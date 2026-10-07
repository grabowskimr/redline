import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stateDirectory } from './statePaths';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adjustForRebases, captureRebaseCursor } from '../../plugin/hooks/rebase.cjs';
import * as vscode from 'vscode';

/** Session-owned before/after trees published atomically in the version-three runs database.
 * Legacy two-file records remain readable only in a verified repository namespace.
 */

export interface RunTree {
  /** HEAD before this prompt, for initializing Unreviewed after agent commits. */
  head?: string;
  id?: string;
  /** ISO timestamp of the moment the snapshot was taken. */
  at: string;
  /** Tree object hash. */
  tree: string;
  /** The session the snapshot belongs to, from hooks that record it. */
  session?: string;
  /** Worktree-local HEAD reflog boundary; precise even for operations in the same second. */
  rebaseCursor?: string;
}

export interface RunTrees {
  observedAt?: string;
  snapshotError?: string;
  before?: RunTree;
  after?: RunTree;
  /**
   * The request currently in flight, and the tree it started from.
   *
   * Not a boundary. Hook 2 and later stop moving `before` at every request and move it at the
   * first change instead, so a turn that only talks leaves the last run that *did* change
   * something on screen. This marker is what says the hook saw the request at all — which is
   * how `before` being older than the request under review is told apart from a hook that has
   * stopped writing. Absent from hook 1, and while nothing is running.
   */
  pending?: RunTree;
  /** Finished runs, newest first, kept so they can still be looked at. */
  history?: PastRun[];
}

/** A run that has already finished: both of its ends. */
export interface PastRun extends RunTree {
  /** The tree the run left behind. */
  after: string;
  endedAt?: string;
  endRebaseCursor?: string;
  /**
   * The end is the tree at the *next* request, not one taken when this run stopped.
   *
   * Claude Code does not run the `Stop` hook on an interrupt, so an interrupted run has no end
   * of its own. This is the closest honest one, and it can carry edits made in between.
   */
  approx?: boolean;
}

/**
 * The marker the hook writes when a run stops.
 *
 * The record of a finished run, and it exists whether or not the prompt came from Redline and
 * whether or not the session is one VS Code can reach: a Claude Code session in iTerm, tmux or
 * any other terminal writes exactly the same marker. `at` identifies the run, which is what
 * makes it safe to react to — reporting is keyed on it rather than on a time window.
 */
export interface StopMarker {
  id?: string;
  startedAt?: string;
  message?: string;
  error?: string;
  batchId?: string;
  at: string;
  /** The Claude Code session that ran, so its transcript can be read directly. */
  session: string;
  /** The working tree as the run left it. Absent from hooks older than 0.2.0. */
  tree?: string;
}

function isTree(value: unknown): value is RunTree {
  const v = value as Partial<RunTree> | undefined;
  return (
    !!v &&
    typeof v.tree === 'string' &&
    /^[0-9a-f]{40,64}$/.test(v.tree) &&
    typeof v.at === 'string' &&
    Number.isFinite(Date.parse(v.at))
  );
}

/** Cached on each file's size and mtime: asked for on every recomputation. */
const cache = new Map<string, { key: string; value: Record<string, unknown> }>();
const CACHE_LIMIT = 32;

export function runTreesPath(root: string, home?: string): string {
  return path.join(stateDirectory(root, home), 'runs.json');
}

export function stoppedPath(root: string, home?: string): string {
  return path.join(stateDirectory(root, home), 'stopped.json');
}

/** Reads one JSON file, remembering the answer against its size and mtime. */
async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let key: string;
  try {
    const st = await fs.stat(file);
    key = `${st.size}:${st.mtimeMs}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.value;
  } catch {
    return undefined; // no hook here, or a version that does not write this
  }
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(file, { key, value });
    return value;
  } catch {
    return undefined; // half-written, or not what we expect
  }
}

/**
 * The last run to finish in this repository, or undefined when none has since the hook was
 * installed. Cheap: one stat, and the parse is remembered against size and mtime.
 */
export async function readStopMarker(root: string, home?: string, session?: string): Promise<StopMarker | undefined> {
  const state = session ? await readJson(runTreesPath(root, home)) : undefined;
  const selected = session && state?.sessions
    ? (state.sessions as Record<string, { stopped?: Record<string, unknown> }>)[createHash('sha256').update(session).digest('hex')]?.stopped
    : undefined;
  const raw = selected ?? await readJson(stoppedPath(root, home));
  if (!raw || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return undefined;
  if (session && raw.session !== session) return undefined;
  const marker: StopMarker = { at: raw.at, session: typeof raw.session === 'string' ? raw.session : '' };
  for (const key of ['id', 'startedAt', 'message', 'error', 'batchId'] as const) {
    if (typeof raw[key] === 'string') marker[key] = raw[key];
  }
  if (typeof raw.tree === 'string' && /^[0-9a-f]{40,64}$/.test(raw.tree)) marker.tree = raw.tree;
  return marker;
}

export async function readRunTrees(root: string, home?: string, session?: string): Promise<RunTrees | undefined> {
  const [database, stopped] = await Promise.all([
    readJson(runTreesPath(root, home)),
    readJson(stoppedPath(root, home)),
  ]);
  const started = session && database?.sessions
    ? (database.sessions as Record<string, Record<string, unknown>>)[createHash('sha256').update(session).digest('hex')]
    : database;
  const trees: RunTrees = {};
  if (typeof started?.observedAt === 'string') trees.observedAt = started.observedAt;
  if (typeof started?.snapshotError === 'string') trees.snapshotError = started.snapshotError;
  const before = started?.before;
  if (isTree(before)) {
    trees.before = { at: before.at, tree: before.tree };
    if (typeof before.head === 'string' && /^[a-f0-9]{40,64}$/.test(before.head)) trees.before.head = before.head;
    if (typeof before.id === 'string') trees.before.id = before.id;
    if (typeof before.rebaseCursor === 'string') trees.before.rebaseCursor = before.rebaseCursor;
    if (typeof (before as RunTree).session === 'string') trees.before.session = (before as RunTree).session;
  }
  const pending = started?.pending;
  if (isTree(pending)) {
    trees.pending = { at: pending.at, tree: pending.tree };
    if (typeof pending.head === 'string' && /^[a-f0-9]{40,64}$/.test(pending.head)) trees.pending.head = pending.head;
    if (typeof pending.id === 'string') trees.pending.id = pending.id;
    if (typeof pending.rebaseCursor === 'string') trees.pending.rebaseCursor = pending.rebaseCursor;
    if (typeof (pending as RunTree).session === 'string') trees.pending.session = (pending as RunTree).session;
  }
  // The stop marker names a tree only from the version of the hook that records one, and only
  // for a run that has actually ended.
  const completed = database?.version === 3 ? started?.after as Record<string, unknown> | undefined : stopped;
  if (completed && typeof completed.tree === 'string' && typeof completed.at === 'string') {
    const after: RunTree = { at: completed.at, tree: completed.tree };
    if (typeof completed.session === 'string') after.session = completed.session;
    if (typeof completed.id === 'string') after.id = completed.id;
    if (typeof completed.rebaseCursor === 'string') after.rebaseCursor = completed.rebaseCursor;
    if (isTree(after)) trees.after = after;
  }
  const past = started?.history;
  if (Array.isArray(past)) {
    const history: PastRun[] = [];
    for (const raw of past) {
      const e = raw as Partial<PastRun>;
      // Read before the guard: narrowing to `RunTree` drops the fields this one adds.
      const after = e.after;
      const approx = e.approx === true;
      const endedAt = e.endedAt, endRebaseCursor = e.endRebaseCursor;
      if (!isTree(e) || typeof after !== 'string' || !/^[0-9a-f]{40,64}$/.test(after)) continue;
      const run: PastRun = { at: e.at, tree: e.tree, after };
      if (typeof e.head === 'string' && /^[a-f0-9]{40,64}$/.test(e.head)) run.head = e.head;
      if (typeof e.id === 'string') run.id = e.id;
      if (typeof e.session === 'string') run.session = e.session;
      if (typeof e.rebaseCursor === 'string') run.rebaseCursor = e.rebaseCursor;
      if (typeof endedAt === 'string') run.endedAt = endedAt;
      if (typeof endRebaseCursor === 'string') run.endRebaseCursor = endRebaseCursor;
      if (approx) run.approx = true;
      history.push(run);
    }
    if (history.length > 0) trees.history = history;
  }
  if (!trees.before && !trees.after && !trees.history && !trees.pending && !trees.snapshotError) return undefined;
  await normalizeRebase(root, trees);
  return trees;
}

/** Older hooks stored the entire rebase in the run. Repair its read model without rewriting state. */
async function normalizeRebase(root: string, trees: RunTrees): Promise<void> {
  const before = trees.before, after = trees.after;
  if (!before || trees.snapshotError) return;
  const active = !!trees.pending && trees.pending.id === before.id;
  if (!active && (!after || (before.session && after.session && before.session !== after.session))) return;
  // New hooks already normalized and retained this exact completed pair. It stays valid even
  // after the reflog expires, or after a later rebase in the very same second.
  if (!active && before.rebaseCursor && before.rebaseCursor === after?.rebaseCursor) return;
  if (!vscode.workspace.isTrusted) {
    trees.snapshotError = 'Trust this workspace before repairing a saved rebase comparison.';
    return;
  }
  try {
    const end = active ? { at: new Date().toISOString(), rebaseCursor: await captureRebaseCursor(root) } : after!;
    const adjusted = await adjustForRebases(root, before, end, async (args) => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before repairing a saved rebase comparison.');
      return (await promisify(execFile)('git', args, { cwd: root, timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout;
    });
    if (!adjusted.rebased) return;
    if (active) {
      trees.snapshotError = 'Git rebased during this run. Last run will refresh when Claude finishes.';
      return;
    }
    trees.before = { ...before, tree: adjusted.tree };
    if (adjusted.tree === after?.tree && trees.history?.length) {
      const [previous, ...history] = trees.history;
      if (previous && !previous.approx && previous.session === before.session) {
        trees.before = previous;
        trees.after = { id: previous.id, at: previous.endedAt || before.at, tree: previous.after, session: previous.session,
          rebaseCursor: previous.endRebaseCursor };
        trees.history = history;
      }
    }
  } catch (error) {
    trees.snapshotError = error instanceof Error ? error.message : 'Cannot separate the rebase from this run.';
  }
}
