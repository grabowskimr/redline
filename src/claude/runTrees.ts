import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { touchedLogPath } from './touched';

/**
 * The tree snapshots the Redline hook records around a run.
 *
 * `before` is written as the request is submitted — the only moment at which "what the tree
 * looked like before this run" can be captured — and lives in `runs.json`. `after` rides
 * along with the stop marker in `stopped.json`, so the panel can show the exact result of a
 * finished run without doing any work of its own, and so neither file's arrival can be
 * mistaken for the other event.
 *
 * Both are plain git tree hashes; see `src/git/snapshotTree.ts` for what they are and why.
 * Absent unless the plugin is installed, so every caller has to work without them.
 */

export interface RunTree {
  /** ISO timestamp of the moment the snapshot was taken. */
  at: string;
  /** Tree object hash. */
  tree: string;
  /** The session the snapshot belongs to, from hooks that record it. */
  session?: string;
}

export interface RunTrees {
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
  return path.join(path.dirname(touchedLogPath(root, home)), 'runs.json');
}

export function stoppedPath(root: string, home?: string): string {
  return path.join(path.dirname(touchedLogPath(root, home)), 'stopped.json');
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
export async function readStopMarker(root: string, home?: string): Promise<StopMarker | undefined> {
  const raw = await readJson(stoppedPath(root, home));
  if (!raw || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return undefined;
  const marker: StopMarker = { at: raw.at, session: typeof raw.session === 'string' ? raw.session : '' };
  if (typeof raw.tree === 'string' && /^[0-9a-f]{40,64}$/.test(raw.tree)) marker.tree = raw.tree;
  return marker;
}

export async function readRunTrees(root: string, home?: string): Promise<RunTrees | undefined> {
  const [started, stopped] = await Promise.all([
    readJson(runTreesPath(root, home)),
    readJson(stoppedPath(root, home)),
  ]);
  const trees: RunTrees = {};
  const before = started?.before;
  if (isTree(before)) {
    trees.before = { at: before.at, tree: before.tree };
    if (typeof (before as RunTree).session === 'string') trees.before.session = (before as RunTree).session;
  }
  const pending = started?.pending;
  if (isTree(pending)) {
    trees.pending = { at: pending.at, tree: pending.tree };
    if (typeof (pending as RunTree).session === 'string') trees.pending.session = (pending as RunTree).session;
  }
  // The stop marker names a tree only from the version of the hook that records one, and only
  // for a run that has actually ended.
  if (stopped && typeof stopped.tree === 'string' && typeof stopped.at === 'string') {
    const after: RunTree = { at: stopped.at, tree: stopped.tree };
    if (typeof stopped.session === 'string') after.session = stopped.session;
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
      if (!isTree(e) || typeof after !== 'string' || !/^[0-9a-f]{40,64}$/.test(after)) continue;
      const run: PastRun = { at: e.at, tree: e.tree, after };
      if (typeof e.session === 'string') run.session = e.session;
      if (approx) run.approx = true;
      history.push(run);
    }
    if (history.length > 0) trees.history = history;
  }
  if (!trees.before && !trees.after && !trees.history && !trees.pending) return undefined;
  return trees;
}
