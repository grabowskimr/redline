#!/usr/bin/env node
/** Redline: immutable snapshots at prompt and completion boundaries.
 * This observer never injects context, reads feedback, or controls Claude's turn.
 * All Git staging uses a unique temporary index; the real index is untouched.
 */
import { mkdir, stat, utimes, writeFile, readFile, copyFile, rename, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { captureRebaseCursor, adjustForRebases } from './rebase.cjs';

const execFileP = promisify(execFile);

const stateKey = (root) => `repo-${createHash('sha256').update(root).digest('hex')}`;
const logDir = (root) => join(homedir(), '.claude', 'redline', stateKey(root));

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
    // Bounded, like everything else here. This runs on every hook event, including every edit
    // the agent makes, and a `git` that never returns holds up the tool call it is attached
    // to — which is the one thing this file promises not to do.
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: QUICK_TIMEOUT_MS,
    });
    return stdout.trim() ? await realpath(stdout.trim()) : undefined;
  } catch {
    return undefined; // no state is written outside a Git repository
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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
 * under one, because git's stat cache does the work. Objects land in the repository. Owned
 * refs protect retained review trees; evicted, unreferenced objects become eligible for pruning.
 *
 * Runs inline at UserPromptSubmit: it has to finish before the agent's first edit, or the
 * "before" is not before anything. Measured at ~0.9s in a 42k-file monorepo.
 */
async function snapshotTree(root) {
  /*
   * A scratch index of this call's own.
   *
   * Two sessions working in one worktree ran this at the same time on one path, and git's
   * `index.lock` is per file: one of them failed with "Another git process seems to be
   * running", and that run lost its "before" — so everything it changed was attributed to
   * whatever came next. The pid and a counter are what keep them apart; the extension's copy
   * of this routine has done it that way since the same thing happened there.
   */
  /*
   * The random part is what keeps the path out of an attacker's reach. The hash is of a path
   * that can be guessed and pid space is small, and on Linux `tmpdir()` is the world-writable
   * `/tmp` — anyone can pre-create this name as a symlink, and the `copyFile` below follows
   * the destination, so `~/.bashrc` would be truncated and overwritten with a git index. The
   * extension's copy of this routine (`src/git/snapshotTree.ts`) carries the same guard.
   */
  const key = createHash('sha1').update(root).digest('hex').slice(0, 16);
  const nonce = randomBytes(8).toString('hex');
  const shadow = join(tmpdir(), `redline-${key}-${process.pid}-${(snapshotSeq += 1)}-${nonce}.hook.index`);
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
        const from = resolve(root, real);
        await copyFile(from, shadow);
        /*
         * ... and give the copy the original's timestamp back.
         *
         * Staging skips a file whose stat still matches its index entry, and git's guard
         * against that missing an edit is the index's own mtime: an entry stamped at or after
         * it is "racily clean" — modified so soon after it was staged that the stat cannot be
         * trusted — and git compares the content instead. Copying resets the mtime to now, so
         * every entry looks safely older than the index it sits in, the guard never fires, and
         * an edit made in the same second as the last staging is read out of the stat cache:
         * two snapshots, one tree, a run that changed a file and reported nothing changed.
         *
         * Rare — it needs an edit inside that one second — but it lasts, because the cached
         * stat stays wrong until something refreshes the real index.
         *
         * Truncated to the millisecond rather than rounded, which is all `utimes` carries:
         * rounding puts the copy up to half a millisecond *after* the index it came from, and
         * that is the same hole again, narrower. Erring early only re-reads a file.
         */
        try {
          const { atimeNs, mtimeNs } = await stat(from, { bigint: true });
          const seconds = (ns) => Number(ns / 1000000n) / 1000;
          await utimes(shadow, seconds(atimeNs), seconds(mtimeNs));
        } catch {
        // Its own guard: a failure here means the copy simply keeps the time of the copy,
        // which is the old behaviour. Folded into the outer `catch` it would have discarded
        // the copied index and staged the whole repository from empty — seconds of work, on
        // every snapshot, because a timestamp could not be set.
        }
      } catch {
        await rm(shadow, { force: true }); // no index yet: stage from empty
      }
    }
    const env = { GIT_INDEX_FILE: shadow };
    const { stdout: entries } = await git(['ls-files', '-v', '-z'], env);
    const assumed = entries.split('\0').filter((entry) => /^[a-z] /.test(entry)).map((entry) => entry.slice(2));
    const stamp = await stat(shadow).catch(() => undefined);
    for (let i = 0; i < assumed.length; i += 256) {
      await git(['update-index', '--no-assume-unchanged', '--', ...assumed.slice(i, i + 256)], env);
    }
    if (assumed.length && stamp) await utimes(shadow, stamp.atime, stamp.mtime);
    await git(['add', '-A', '--'], env);
    const { stdout } = await git(['write-tree'], env);
    const tree = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
  } catch {
    return undefined; // not a repository, git unavailable, or too slow
  } finally {
    // Several megabytes per call, in the temp directory, once per run. Nothing else was ever
    // going to remove them.
    await rm(shadow, { force: true }).catch(() => undefined);
    await rm(`${shadow}.lock`, { force: true }).catch(() => undefined);
  }
}

/** Tells one call's scratch index from the next one's inside a single process. */
let snapshotSeq = 0;

/** Bound each snapshot operation; capture failures are reported explicitly. */
const SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * For the git calls that sit on the critical path of every tool call.
 *
 * Much shorter than the snapshot's: this one runs constantly and the answer is only ever used
 * to attribute a file to a run. Losing that is a smaller price than a stalled agent.
 */
const QUICK_TIMEOUT_MS = 5_000;

/** How many finished runs stay reachable. */
const MAX_RUN_HISTORY = 5;

// Every invocation owns one session. Boundary handlers run synchronously under a repository
// lock, so a detached Stop cannot read the following prompt's pending generation.
let eventSession = '';
let eventRoot = '';
const sessionKey = (session) => createHash('sha256').update(session).digest('hex');
async function readDatabase(dir) {
  try { return JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8')); }
  catch { return {}; }
}
async function readRuns(dir) {
  const database = await readDatabase(dir);
  if (database.version >= 3) return database.sessions?.[sessionKey(eventSession)] || {};
  // Legacy data is usable only when its session matches; it is never assigned to another.
  return !database.before?.session || database.before.session === eventSession ? database : {};
}
async function retainTrees(database) {
  const prefix = `refs/redline/${stateKey(eventRoot)}/`;
  const desired = new Map();
  for (const [key, state] of Object.entries(database.sessions)) {
    for (const [name, entry] of [['before', state.before], ['pending', state.pending], ['after', state.after], ['current', state.stopped]]) {
      if (entry?.tree) desired.set(`${prefix}${key}/${name}`, entry.tree);
      if (entry?.head) desired.set(`${prefix}${key}/${name}-head`, entry.head);
    }
    for (const [i, entry] of (state.history || []).entries()) {
      if (entry.tree) desired.set(`${prefix}${key}/history-${i}-before`, entry.tree);
      if (entry.after) desired.set(`${prefix}${key}/history-${i}-after`, entry.after);
      if (entry.head) desired.set(`${prefix}${key}/history-${i}-head`, entry.head);
    }
  }
  const git = (args) => execFileP('git', args, { cwd: eventRoot, timeout: QUICK_TIMEOUT_MS });
  const existing = new Map((await git(['for-each-ref', '--format=%(refname) %(objectname)', prefix])).stdout.trim().split('\n').filter(Boolean).map((line) => line.split(' ')));
  const updates = [];
  for (const [ref, tree] of desired) {
    if (!/^[a-f0-9]{40,64}$/.test(tree) || /[\s\0]/.test(ref)) throw new Error('Invalid snapshot reference');
    if (existing.get(ref) !== tree) updates.push(`update ${ref} ${tree}`);
  }
  for (const ref of existing.keys()) if (!desired.has(ref)) updates.push(`delete ${ref}`);
  if (updates.length) await new Promise((done, reject) => {
    const child = execFile('git', ['update-ref', '--stdin'], { cwd: eventRoot, timeout: QUICK_TIMEOUT_MS }, error => error ? reject(error) : done());
    child.stdin?.on('error', reject);
    child.stdin?.end(updates.join('\n') + '\n');
  });
}
async function writeRuns(dir, runs) {
  const previous = await readDatabase(dir);
  const sessions = { ...(previous.sessions || {}), [sessionKey(eventSession)]: runs };
  // Limit dormant sessions as well as each session's history; never evict an active turn.
  const ordered = Object.entries(sessions).sort((a, b) => Date.parse(b[1].observedAt || 0) - Date.parse(a[1].observedAt || 0));
  for (const [key, state] of ordered.slice(20)) if (!state.pending) delete sessions[key];
  const latest = ordered[0]?.[1] || runs;
  const database = { ...latest, version: 3, root: eventRoot, sessions };
  await retainTrees(database);
  const file = join(dir, 'runs.json'), temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(database), 'utf8');
  await rename(temp, file);
}

async function recordRunStart(root, sessionId) {
  const dir = logDir(root), runs = await readRuns(dir);
  const at = new Date().toISOString(), id = randomUUID();
  const rebaseCursor = await captureRebaseCursor(root);
  const tree = await snapshotTree(root);
  const head = await execFileP('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeout: QUICK_TIMEOUT_MS }).then(r => r.stdout.trim(), () => undefined);
  const stable = rebaseCursor === await captureRebaseCursor(root);
  runs.observedAt = at;
  runs.pending = { id, at, head, tree: stable ? tree : undefined, rebaseCursor, session: sessionId || '' };
  runs.snapshotError = !stable ? 'Git changed while the run’s start snapshot was captured.' : tree ? undefined : 'The start snapshot could not be captured.';
  await writeRuns(dir, runs);
}

async function promoteRun(dir, sessionId) {
  const runs = await readRuns(dir), pending = runs.pending;
  if (!pending?.tree || pending.promoted || pending.session !== sessionId) return;
  const prev = runs.before;
  if (prev?.tree && prev.id !== pending.id) {
    const completed = runs.after?.id === prev.id ? runs.after.tree : undefined;
    const entry = { ...prev, after: completed || pending.tree, approx: !completed || undefined,
      endedAt: completed ? runs.after.at : undefined, endRebaseCursor: completed ? runs.after.rebaseCursor : undefined };
    runs.history = [entry, ...(runs.history || [])].slice(0, MAX_RUN_HISTORY);
  }
  runs.before = { id: pending.id, at: pending.at, tree: pending.tree, head: pending.head, session: pending.session, rebaseCursor: pending.rebaseCursor };
  runs.after = undefined;
  runs.pending = { ...pending, promoted: true };
  await writeRuns(dir, runs);
}

async function settleRun(dir, endTree, sessionId, rebaseCursor) {
  let runs = await readRuns(dir);
  const pending = runs.pending;
  if (!pending || pending.session !== sessionId) return;
  if (pending.tree && endTree) {
    try {
      const adjusted = await adjustForRebases(eventRoot, pending, { at: new Date().toISOString(), rebaseCursor },
        async (args) => (await execFileP('git', args, { cwd: eventRoot, timeout: QUICK_TIMEOUT_MS })).stdout);
      pending.tree = adjusted.tree;
      pending.rebaseCursor = adjusted.rebaseCursor;
      if (pending.promoted) runs.before = { ...runs.before, tree: adjusted.tree, rebaseCursor: adjusted.rebaseCursor };
      await writeRuns(dir, runs);
    } catch (error) {
      runs.snapshotError = error.message;
      delete runs.pending;
      await writeRuns(dir, runs);
      return;
    }
  }
  if (endTree && pending.tree && endTree !== pending.tree && !pending.promoted) {
    await promoteRun(dir, sessionId);
    runs = await readRuns(dir);
  }
  if (endTree && runs.pending?.promoted && runs.before?.tree === endTree && runs.history?.length) {
    const [restored, ...history] = runs.history;
    runs.before = { id: restored.id, at: restored.at, tree: restored.tree, head: restored.head, session: restored.session, rebaseCursor: restored.rebaseCursor };
    runs.after = { id: restored.id, at: restored.endedAt || pending.at, tree: restored.after, session: restored.session, rebaseCursor: restored.endRebaseCursor };
    runs.history = history;
  } else if (endTree && runs.pending?.promoted) {
    runs.after = { id: pending.id, at: new Date().toISOString(), tree: endTree, session: sessionId, rebaseCursor };
  }
  if (!endTree) runs.snapshotError = 'The completed snapshot could not be captured.';
  delete runs.pending;
  await writeRuns(dir, runs);
}

async function resumeStoppedRun(root, sessionId) {
  const dir = logDir(root), runs = await readRuns(dir), stopped = runs.stopped;
  if (runs.pending || !stopped?.tree || stopped.session !== sessionId) return;
  const same = runs.before?.id === stopped.id;
  runs.pending = { id: stopped.id, at: stopped.startedAt || stopped.at, resumedAt: new Date().toISOString(),
    tree: same ? runs.before.tree : stopped.tree, head: same ? runs.before.head : stopped.head, session: sessionId,
    rebaseCursor: same ? runs.before.rebaseCursor : stopped.rebaseCursor,
    promoted: same || undefined };
  await writeRuns(dir, runs);
}

async function acquireLock(dir) {
  await mkdir(dir, { recursive: true });
  const lock = join(dir, 'lifecycle.lock'), deadline = Date.now() + 20_000;
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner'), String(process.pid));
      return () => rm(lock, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Recover a crashed writer, but never steal a live writer's lock.
      try {
        const pid = Number(await readFile(join(lock, 'owner'), 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if (e.code === 'ESRCH') { await rm(lock, { recursive: true, force: true }); continue; } }
        }
      } catch {
        // A writer can die between mkdir and publishing its pid. Never steal a new lock.
        try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) { await rm(lock, { recursive: true, force: true }); continue; } } catch { /* another writer recovered it */ }
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the run boundary');
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}

async function markAlive(root) {
  const dir = logDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'root.json'), JSON.stringify({ root }), 'utf8');
  const file = join(dir, 'hook.json');
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(
    temp,
    JSON.stringify({ name: 'redline', version: 4, pluginVersion: '1.0.0', capabilities: ['runSnapshots'], at: new Date().toISOString() }),
    'utf8',
  );
  await rename(temp, file);
}

/**
 * A run ended. Redline watches for this file to know the moment to refresh, rather than
 * polling for it — and housekeeping goes here, where no tool call is waiting on it.
 *
 * The tree recorded here is what "the last run" is measured against, together with the one
 * from the start of the run.
 */
async function runEnded(root, sessionId, payload) {
  // Stop can mean Claude is paused waiting for a background task, not finished.
  if (payload.hook_event_name === 'Stop' && Array.isArray(payload.background_tasks) && payload.background_tasks.length) return;
  const dir = logDir(root), runs = await readRuns(dir);
  const pending = runs.pending;
  if (payload.redline_run_id && payload.redline_run_id !== pending?.id) return;
  if (!pending && runs.stopped) return; // duplicate completion
  const rebaseCursor = await captureRebaseCursor(root);
  const tree = await snapshotTree(root);
  const stable = rebaseCursor === await captureRebaseCursor(root);
  await settleRun(dir, stable ? tree : undefined, sessionId, rebaseCursor);
  const stopped = {
    id: pending?.id || randomUUID(), head: pending?.head, at: new Date().toISOString(), startedAt: pending?.at,
    session: sessionId, tree: stable ? tree : undefined, rebaseCursor,
    error: payload.hook_event_name === 'StopFailure' ? String(payload.error || 'unknown') : undefined,
  };
  const settled = await readRuns(dir);
  settled.stopped = stopped;
  await writeRuns(dir, settled);
  const target = join(dir, 'stopped.json'), temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(stopped), 'utf8');
  await rename(temp, target);
}

async function main() {
  const payload = JSON.parse((await readStdin()) || '{}');
  const event = payload.hook_event_name;
  if (!['UserPromptSubmit', 'Stop', 'StopFailure'].includes(event)) return;
  const root = await repoRoot(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  if (!root || typeof payload.session_id !== 'string' || !payload.session_id) return;
  eventSession = payload.session_id;
  eventRoot = root;
  const release = await acquireLock(logDir(root));
  try {
    if (event === 'UserPromptSubmit') {
      await markAlive(root);
      await recordRunStart(root, eventSession);
    } else {
      // Another Stop hook can continue the same prompt without a UserPromptSubmit.
      // Resume only when Claude explicitly identifies a continuation; ordinary
      // duplicate completion events must not incorporate later working-file edits.
      if (payload.stop_hook_active === true) await resumeStoppedRun(root, eventSession);
      await runEnded(root, eventSession, payload);
    }
  } finally { await release(); }
}

try { await main(); }
catch (error) { process.stderr.write(`redline-hook: ${error.message || error}\n`); }
process.stdout.write('{}\n');
