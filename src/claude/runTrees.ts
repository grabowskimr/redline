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
}

export interface RunTrees {
  before?: RunTree;
  after?: RunTree;
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

export async function readRunTrees(root: string, home?: string): Promise<RunTrees | undefined> {
  const [started, stopped] = await Promise.all([
    readJson(runTreesPath(root, home)),
    readJson(stoppedPath(root, home)),
  ]);
  const trees: RunTrees = {};
  const before = started?.before;
  if (isTree(before)) trees.before = before;
  // The stop marker names a tree only from the version of the hook that records one, and only
  // for a run that has actually ended.
  if (stopped && typeof stopped.tree === 'string' && typeof stopped.at === 'string') {
    const after = { at: stopped.at, tree: stopped.tree };
    if (isTree(after)) trees.after = after;
  }
  if (!trees.before && !trees.after) return undefined;
  return trees;
}
