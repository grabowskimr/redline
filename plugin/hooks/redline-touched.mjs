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
import { appendFile, mkdir, stat, writeFile, readFile, readdir, unlink, copyFile, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
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
  // `-z` so a path containing a quote, a backslash or a newline comes back verbatim rather
  // than escaped — an escaped one fails every stat below and is silently dropped.
  const { stdout } = await execFileP('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', 'HEAD'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  const changed = stdout.split('\0').filter(Boolean);
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
 * Snapshot the whole working tree into a git tree object.
 *
 * This is the one thing only a hook can do: capture what the tree looked like *before* the
 * agent starts editing. Everything Redline shows about a run is a diff between this tree and
 * a later one, which is why the answer covers new files, deleted files and renames without a
 * single timestamp comparison.
 *
 * The user's index and working tree are untouched — `GIT_INDEX_FILE` points the staging at a
 * scratch file in the temp directory. The real index is copied there first: staging 42k files
 * against an empty index costs about 6 seconds, against a copy of the repository's own index
 * under one, because git's stat cache does the work. Objects land in the repository unreachable
 * and are pruned on git's usual schedule, as `git stash create` leaves them.
 *
 * Runs inline at UserPromptSubmit: it has to finish before the agent's first edit, or the
 * "before" is not before anything. Measured at ~0.9s in a 42k-file monorepo.
 */
async function snapshotTree(root) {
  const shadow = join(tmpdir(), `redline-${createHash('sha1').update(root).digest('hex').slice(0, 16)}.hook.index`);
  const git = (args, env) =>
    execFileP('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: root,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: SNAPSHOT_TIMEOUT_MS,
    });
  try {
    const { stdout: indexPath } = await git(['rev-parse', '--git-path', 'index']);
    const real = indexPath.trim();
    if (real) {
      try {
        await copyFile(resolve(root, real), shadow);
      } catch {
        await rm(shadow, { force: true }); // no index yet: stage from empty
      }
    }
    await git(['add', '-A', '--ignore-errors', '--'], { GIT_INDEX_FILE: shadow });
    const { stdout } = await git(['write-tree'], { GIT_INDEX_FILE: shadow });
    const tree = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
  } catch {
    return undefined; // not a repository, git unavailable, or too slow
  }
}

/** Beyond this the snapshot is holding up the turn; the older signals cover the gap. */
const SNAPSHOT_TIMEOUT_MS = 30_000;

/**
 * Record the tree the run starts from.
 *
 * Its own file, written only at submit: Redline watches for it to know the run boundary has
 * moved. The end-of-run tree rides along with the stop marker instead, so neither event can
 * ever be mistaken for the other.
 */
async function recordRunStart(root, sessionId) {
  const tree = await snapshotTree(root);
  if (!tree) return;
  const dir = logDir(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'runs.json');
  const temp = `${file}.tmp`;
  // Renamed into place: Redline could otherwise read a half-written file and see no run at all.
  // The session is recorded so the two ends of a run can be checked against each other: two
  // sessions working in one repository overwrite each other's marker, and a "before" from a
  // different session than the one that stopped describes a different run.
  await writeFile(
    temp,
    JSON.stringify({ before: { at: new Date().toISOString(), tree, session: sessionId || '' } }),
    'utf8',
  );
  await rename(temp, file);
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
  // Exact match. A substring test would hand over a batch to any prompt that merely mentions
  // the tool — talking *about* Redline would silently consume a review.
  if (prompt.trim().toLowerCase() !== DELIVERY_TOKEN) return undefined;
  const file = join(logDir(root), 'outbox.md');
  try {
    const { mtimeMs } = await stat(file);
    if (Date.now() - mtimeMs > OUTBOX_TTL_MS) {
      await unlink(file);
      return undefined;
    }
    const text = await readFile(file, 'utf8');
    // Renamed rather than deleted: if anything goes wrong between here and the reply, the
    // review still exists on disk instead of being lost with no way to get it back.
    await rename(file, join(logDir(root), 'outbox.sent.md'));
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

/**
 * A run ended. Redline watches for this file to know the moment to refresh, rather than
 * polling for it — and housekeeping goes here, where no tool call is waiting on it.
 *
 * The tree recorded here is what "the last run" is measured against, together with the one
 * from the start of the run.
 */
async function runEnded(root, sessionId) {
  const dir = logDir(root);
  await mkdir(dir, { recursive: true });
  // Snapshotted before the marker is written, so that by the time Redline reacts to the marker
  // the exact result of the run is already on disk and the panel has nothing left to compute.
  const tree = await snapshotTree(root);
  await writeFile(
    join(dir, 'stopped.json'),
    JSON.stringify({ at: new Date().toISOString(), session: sessionId, tree }),
    'utf8',
  );
  await trimLog(join(dir, 'touched.jsonl'));
  await sweepMarkers(dir);
  // Earlier versions kept a directory of copied files here to serve as the run's "before".
  // A tree object does that now, so this is dead weight — and it was measured in tens of
  // megabytes for a large run.
  await rm(join(dir, 'snapshot'), { recursive: true, force: true });
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
    await recordRunStart(root, sessionId);
  } else if (event === 'Stop') {
    // Deliberately not SubagentStop: a turn using subagents fires that once per subagent,
    // and each one would look like the end of the run.
    //
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
