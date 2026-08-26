import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectSlug } from './transcripts';

/**
 * Files the agent itself changed, as recorded by the Redline hook for Claude Code.
 *
 * Without the hook, Redline can only infer authorship from timestamps: a file you saved, or
 * one a formatter or a build wrote, is indistinguishable from the agent's work. The hook
 * removes the guess. It is optional, so every caller has to cope with an empty answer.
 *
 * Pure Node — no `vscode` — so it can be unit-tested.
 */

export interface TouchedEntry {
  at: string;
  session: string;
  /** Absolute path as the agent saw it. */
  file: string;
  via: 'edit' | 'bash' | string;
}

/** Where the hook writes; mirrors Claude Code's own per-directory transcript layout. */
export function touchedLogPath(cwd: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'redline', projectSlug(cwd), 'touched.jsonl');
}

/** A log this large means something is wrong; read the newest part and move on. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * Parsed logs keyed by size and mtime.
 *
 * `summary()` asks for this on every recomputation, once per candidate directory, and the
 * log only ever grows — so re-reading and re-parsing megabytes each time is pure waste.
 */
const parsedCache = new Map<string, { key: string; entries: TouchedEntry[] }>();
const PARSED_LIMIT = 16;

/**
 * Entries recorded at or after `since`. Returns undefined — not an empty array — when there
 * is no log at all, so a caller can tell "the hook is not installed" from "the hook is
 * installed and the agent changed nothing".
 */
export async function touchedSince(cwd: string, since: number, home?: string): Promise<TouchedEntry[] | undefined> {
  const file = touchedLogPath(cwd, home);
  let raw: string;
  let cacheKey: string | undefined;
  try {
    const stat = await fs.stat(file);
    const size = stat.size;
    if (size === 0) return [];
    cacheKey = `${size}:${stat.mtimeMs}`;
    const hit = parsedCache.get(file);
    if (hit && hit.key === cacheKey) return hit.entries.filter((e) => Date.parse(e.at) >= since);
    const handle = await fs.open(file, 'r');
    try {
      const len = Math.min(size, MAX_READ_BYTES);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, size - len);
      raw = buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined; // no log: the hook is not installed here
  }

  const all: TouchedEntry[] = [];
  for (const line of raw.split('\n')) {
    // Reading from an offset can start mid-line, and a hook writing concurrently can leave
    // a partial one at the end. Both are expected; skip them.
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const e = entry as Partial<TouchedEntry>;
    if (typeof e.at !== 'string' || typeof e.file !== 'string') continue;
    if (!Number.isFinite(Date.parse(e.at))) continue;
    all.push({ at: e.at, session: e.session ?? '', file: e.file, via: e.via ?? 'edit' });
  }
  if (cacheKey !== undefined) {
    if (parsedCache.size > PARSED_LIMIT) parsedCache.clear();
    parsedCache.set(file, { key: cacheKey, entries: all });
  }
  return all.filter((e) => Date.parse(e.at) >= since);
}

/**
 * Repository-relative paths the agent changed since `since`, ready to compare against a
 * `git diff --name-only` listing. Paths outside `repoRoot` are dropped: an agent may edit
 * notes or configuration elsewhere, and those are not part of this review.
 */
export async function touchedPathsSince(
  cwd: string,
  repoRoot: string,
  since: number,
  home?: string,
): Promise<Set<string> | undefined> {
  const entries = await touchedSince(cwd, since, home);
  if (entries === undefined) return undefined;
  const prefix = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  const out = new Set<string>();
  for (const e of entries) {
    if (!e.file.startsWith(prefix)) continue;
    out.add(e.file.slice(prefix.length));
  }
  return out;
}
