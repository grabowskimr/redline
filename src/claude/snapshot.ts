import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { touchedLogPath } from './touched';

/**
 * What the working tree looked like when the current request was submitted.
 *
 * The Redline hook copies every already-modified file at `UserPromptSubmit`. That is the
 * only way to answer "which lines did *this* run change?" for uncommitted work: a git diff
 * against the base commit is cumulative, so an edit from an earlier run in the same file is
 * indistinguishable from one made moments ago.
 *
 * Absent unless the hook is installed, so every caller has to work without it.
 */

export interface RunSnapshot {
  /** ISO timestamp of the request this snapshot belongs to. */
  at: string;
  /** Absolute path to the stored copy of a repo-relative file, if it has one. */
  storedPath(relPath: string): string | undefined;
  /** Files the snapshot covers — those already modified when the run began. */
  has(relPath: string): boolean;
}

interface Manifest {
  at?: string;
  files?: Record<string, string>;
}

function snapshotDir(cwd: string, home?: string): string {
  return path.join(path.dirname(touchedLogPath(cwd, home)), 'snapshot');
}

/** Manifests keyed by the file's size and mtime; asked for on every recomputation. */
const manifestCache = new Map<string, { key: string; snapshot: RunSnapshot }>();
/** Comparison verdicts keyed by the current file's size and mtime. */
const verdictCache = new Map<string, { key: string; differs: boolean }>();
const CACHE_LIMIT = 512;

export async function readSnapshot(cwd: string, home?: string): Promise<RunSnapshot | undefined> {
  const dir = snapshotDir(cwd, home);
  const file = path.join(dir, 'manifest.json');
  let key: string | undefined;
  try {
    const st = await fs.stat(file);
    key = `${st.size}:${st.mtimeMs}`;
    const hit = manifestCache.get(file);
    if (hit && hit.key === key) return hit.snapshot;
  } catch {
    return undefined; // no snapshot here
  }
  try {
    const raw = await fs.readFile(file, 'utf8');
    const manifest = JSON.parse(raw) as Manifest;
    if (typeof manifest.at !== 'string' || !manifest.files) return undefined;
    const files = manifest.files;
    const snapshot: RunSnapshot = {
      at: manifest.at,
      has: (rel) => Object.prototype.hasOwnProperty.call(files, rel),
      storedPath: (rel) => {
        const stored = files[rel];
        return stored === undefined ? undefined : path.join(dir, stored);
      },
    };
    if (key !== undefined) {
      if (manifestCache.size > CACHE_LIMIT) manifestCache.clear();
      manifestCache.set(file, { key, snapshot });
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

/**
 * Whether a file differs from its snapshot — i.e. whether this run touched it.
 *
 * Compared by content rather than by timestamp: a formatter or a build can move an mtime
 * without changing anything, and this is the one signal that should not be fooled by that.
 * Returns true when there is nothing to compare against, so a missing snapshot never hides
 * a change.
 */
export async function differsFromSnapshot(
  snapshot: RunSnapshot,
  repoRoot: string,
  relPath: string,
): Promise<boolean> {
  const stored = snapshot.storedPath(relPath);
  if (stored === undefined) return true;
  const current = path.join(repoRoot, relPath);
  try {
    const [a, b] = await Promise.all([fs.stat(stored), fs.stat(current)]);
    // Different sizes settle it without reading either file.
    if (a.size !== b.size) return true;
    // Same size: the contents have to be compared, so remember the answer against the
    // current file's identity rather than re-reading both on every recomputation.
    const key = `${b.size}:${b.mtimeMs}:${a.mtimeMs}`;
    const hit = verdictCache.get(stored);
    if (hit && hit.key === key) return hit.differs;
    const [before, now] = await Promise.all([fs.readFile(stored), fs.readFile(current)]);
    const differs = !before.equals(now);
    if (verdictCache.size > CACHE_LIMIT) verdictCache.clear();
    verdictCache.set(stored, { key, differs });
    return differs;
  } catch {
    return true; // one side unreadable (deleted, for instance): report it
  }
}
