#!/usr/bin/env node
/**
 * Redline hook for Claude Code — records which files the agent itself changed.
 *
 * Redline otherwise has to infer this from git ranges and file timestamps, and neither can
 * tell *who* made a change: a file you saved yourself, or one a formatter or a build
 * touched, looks exactly like the agent's work. This records the agent's edits at the
 * source, so "what changed in the last run" stops being a guess.
 *
 * Invoked by `redline-touched.sh`, which is what Claude Code is pointed at — hooks get a
 * minimal PATH and an nvm/Homebrew/Volta node is often not on it. See "Attributing changes
 * exactly" in the Redline README.
 *
 * Contract with Claude Code: reply with JSON and exit 0, always. A hook that fails or stalls
 * interferes with the turn it is attached to, and none of this is worth that. Every failure
 * path is silent.
 */
import { appendFile, mkdir, stat, writeFile, readFile, readdir, unlink, copyFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The hook's reply. `{}` unless there is something to inject. */
let reply = {};

/** Same scheme Claude Code uses for transcript directories, so Redline can find ours. */
const slug = (dir) => dir.replace(/[^A-Za-z0-9-]/g, '-');
const logDir = (root) => join(homedir(), '.claude', 'redline', slug(root));

/**
 * The repository root for a working directory.
 *
 * Everything here is keyed by this rather than by the payload's `cwd`, because `cwd` is
 * often a subdirectory — an agent that has `cd`-ed, or a Bash call made deeper in the tree.
 * Keying by `cwd` scattered the log and the snapshots across a directory per subdirectory,
 * so Redline (which looks under the repository root) found only a fraction of them, and the
 * newest snapshot was frequently an empty one written from somewhere deep in the tree.
 *
 * It also fixes the paths: `git diff --name-only` prints them relative to the repository
 * root, so joining them onto a subdirectory `cwd` failed for every file.
 */
async function repoRoot(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || cwd;
  } catch {
    return cwd; // not a repository; keep the caller's directory
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update']);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Paths from a tool input, covering the single- and multi-file shapes. */
function pathsFrom(input) {
  if (!input || typeof input !== 'object') return [];
  const out = [];
  if (typeof input.file_path === 'string') out.push(input.file_path);
  if (typeof input.notebook_path === 'string') out.push(input.notebook_path);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e.file_path === 'string') out.push(e.file_path);
  }
  return out;
}

/**
 * Append-only log, so it needs a ceiling: an agent working in one directory for months
 * would otherwise grow it without bound. Redline only ever reads the newest part, so the
 * older half is dropped whole once the file gets large. Trimming happens on a line
 * boundary — a half-line would be unparseable.
 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_LOG_BYTES = 2 * 1024 * 1024;

async function trimLog(logFile) {
  try {
    const { size } = await stat(logFile);
    if (size <= MAX_LOG_BYTES) return;
    const raw = await readFile(logFile, 'utf8');
    const cut = raw.length - KEEP_LOG_BYTES;
    const from = raw.indexOf('\n', cut > 0 ? cut : 0);
    await writeFile(logFile, from >= 0 ? raw.slice(from + 1) : '', 'utf8');
  } catch {
    // nothing to trim, or unreadable
  }
}

/** Bash markers are per session; clear ones left behind by sessions that are long gone. */
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

async function sweepMarkers(dir) {
  try {
    const now = Date.now();
    for (const name of await readdir(dir)) {
      if (!name.startsWith('bash-') || !name.endsWith('.start')) continue;
      const full = join(dir, name);
      const { mtimeMs } = await stat(full);
      if (now - mtimeMs > MARKER_TTL_MS) await unlink(full);
    }
  } catch {
    // best effort
  }
}

async function record(root, sessionId, files, via) {
  const unique = [...new Set(files.filter((f) => typeof f === 'string' && f))];
  if (unique.length === 0) return;
  const dir = logDir(root);
  await mkdir(dir, { recursive: true });
  const at = new Date().toISOString();
  const lines = unique.map((f) => JSON.stringify({ at, session: sessionId, file: f, via })).join('\n');
  const logFile = join(dir, 'touched.jsonl');
  await appendFile(logFile, lines + '\n', 'utf8');
}

const markerFile = (root, sessionId) => join(logDir(root), `bash-${(sessionId || 'x').replace(/[^\w-]/g, '')}.start`);

/**
 * Bash can write files without naming them, so the command is bracketed instead: the start
 * time is noted, then afterwards any tracked file that changed *and* is newer than that is
 * attributed to it. `git diff --name-only` is used rather than `git status`, which walks
 * untracked files and costs about eight times as much in a large repo. Files Bash creates
 * from scratch are therefore not recorded here — Redline counts untracked files as new work
 * on its own.
 */
async function bashStart(root, sessionId) {
  await mkdir(logDir(root), { recursive: true });
  await writeFile(markerFile(root, sessionId), String(Date.now()), 'utf8');
}

async function bashEnd(root, sessionId) {
  let start = 0;
  try {
    start = Number(await readFile(markerFile(root, sessionId), 'utf8')) || 0;
  } catch {
    return; // no matching start; attributing the whole diff would be a lie
  }
  const { stdout } = await execFileP('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  const changed = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const touched = [];
  for (const rel of changed) {
    try {
      const { mtimeMs } = await stat(join(root, rel));
      if (mtimeMs >= start) touched.push(join(root, rel));
    } catch {
      // deleted by the command; Redline picks deletions up from git anyway
    }
  }
  await record(root, sessionId, touched, 'bash');
}

/**
 * Copy every file that is already modified, so the next run can be told apart from the ones
 * before it.
 *
 * Git cannot answer "which lines did this run change?" for uncommitted work: a diff against
 * the base commit is cumulative, so an edit made twenty minutes ago is indistinguishable
 * from one made just now. Knowing what the file looked like when the request was submitted
 * is the only way, and this is the moment to record it.
 *
 * Files that are currently clean are deliberately skipped: if the run touches one, its whole
 * diff against the base belongs to this run anyway.
 *
 * Only tracked files are listed. `git ls-files --others` would add untracked ones, but it
 * walks the entire working tree applying gitignore — measured at 823-1203ms to find three
 * files in a 42k-file repo, against 61-109ms for the diff and 6ms for the copies. Redline
 * dates anything without a snapshot entry against the timestamp below instead, which costs
 * nothing and answers the same question.
 *
 * Runs inline rather than detached — the copy has to finish before the agent starts editing,
 * and it is a handful of small files while the model is still thinking.
 */
async function snapshotRunStart(root) {
  const dir = join(logDir(root), 'snapshot');
  let changed = [];
  try {
    const tracked = await execFileP('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD'], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    changed = tracked.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return; // not a repo, or git unavailable
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files = {};
  let total = 0;
  for (const rel of changed.slice(0, MAX_SNAPSHOT_FILES)) {
    const stored = encodeURIComponent(rel);
    try {
      const { size } = await stat(join(root, rel));
      if (size > MAX_SNAPSHOT_FILE_BYTES) continue;
      if (total + size > MAX_SNAPSHOT_TOTAL_BYTES) break;
      await copyFile(join(root, rel), join(dir, stored));
      total += size;
      files[rel] = stored;
    } catch {
      // unreadable or vanished; it simply has no snapshot
    }
  }
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ at: new Date().toISOString(), files }),
    'utf8',
  );
}

/**
 * The token Redline types to hand over a batch of review feedback.
 *
 * Nothing is pasted into the terminal: Redline writes the feedback beside its other state and
 * types this, and the prompt is answered here with the whole thing injected. A short token
 * survives being typed where several kilobytes of prompt does not — which is what made
 * sending unreliable in the first place.
 *
 * Deliberately free of `@` and `/`, which the agent's input treats specially.
 */
const DELIVERY_TOKEN = 'redline-review';

/** Feedback older than this is stale — a batch nobody sent, or an interrupted one. */
const OUTBOX_TTL_MS = 60 * 60 * 1000;

/** Hand over any pending review feedback, and consume it so it cannot arrive twice. */
async function takePendingReview(root, prompt) {
  if (!prompt.toLowerCase().includes(DELIVERY_TOKEN)) return undefined;
  const file = join(logDir(root), 'outbox.md');
  try {
    const { mtimeMs } = await stat(file);
    if (Date.now() - mtimeMs > OUTBOX_TTL_MS) {
      await unlink(file);
      return undefined;
    }
    const text = await readFile(file, 'utf8');
    await unlink(file);
    return text.trim() || undefined;
  } catch {
    return undefined; // nothing waiting
  }
}

/** Tells Redline the hook is installed and live here, so it can choose how to deliver. */
async function markAlive(root) {
  const dir = logDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'hook.json'),
    JSON.stringify({ name: 'redline', version: 1, token: DELIVERY_TOKEN, at: new Date().toISOString() }),
    'utf8',
  );
}

/** Bounds: a snapshot is meant to be a handful of source files, not a copy of the tree. */
const MAX_SNAPSHOT_FILES = 200;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
/** Total ceiling, so the per-file limit cannot multiply into hundreds of megabytes. */
const MAX_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * A run ended. Redline watches for this file to know the moment to refresh, rather than
 * polling for it — and housekeeping goes here, where no tool call is waiting on it.
 */
async function runEnded(root, sessionId) {
  const dir = logDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'stopped.json'),
    JSON.stringify({ at: new Date().toISOString(), session: sessionId }),
    'utf8',
  );
  await trimLog(join(dir, 'touched.jsonl'));
  await sweepMarkers(dir);
}

try {
  const payload = JSON.parse((await readStdin()) || '{}');
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const root = await repoRoot(cwd);
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';

  if (event === 'UserPromptSubmit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    // Marked alive first: even if the snapshot fails, Redline should know the hook is here.
    await markAlive(root);
    const pending = await takePendingReview(root, prompt);
    if (pending) {
      reply = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: pending,
        },
      };
    }
    await snapshotRunStart(root);
  } else if (event === 'Stop') {
    // Deliberately not SubagentStop: a turn using subagents fires that once per subagent,
    // and each one would look like the end of the run.
    await runEnded(root, sessionId);
  } else if (tool === 'Bash') {
    if (event === 'PreToolUse') await bashStart(root, sessionId);
    else await bashEnd(root, sessionId);
  } else if (EDIT_TOOLS.has(tool)) {
    await record(root, sessionId, pathsFrom(payload.tool_input), 'edit');
  }
} catch {
  // Silent by design: see the contract note above.
}

process.stdout.write(JSON.stringify(reply) + '\n');
