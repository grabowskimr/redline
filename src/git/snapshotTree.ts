import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Snapshotting the working tree into a real git tree object.
 *
 * "What did the last run change?" has no answer in ordinary git: a diff against the base
 * commit is cumulative, so an edit from twenty minutes ago is indistinguishable from one
 * made moments ago, and untracked files are missing from it entirely. Redline used to answer
 * it by stitching four signals together — a `git diff` for tracked files, a separate
 * `ls-files --others` walk for new ones, file mtimes to date them, and a directory of copied
 * files to compare against. Each had a hole. The one that hurt most: the untracked walk
 * takes about a second in a large repository, so it was never blocked on, which meant a file
 * created seconds ago was simply absent from the list until the next refresh.
 *
 * A snapshot removes all of it. Staging the whole working tree into a *throwaway* index
 * produces a tree object covering tracked, staged, modified and untracked files alike, and
 * two of those are all it takes:
 *
 *     git diff-tree -r -M --name-status <before> <after>
 *
 * That is one command, about 20ms, and it reports added, deleted, modified and renamed
 * exactly. No timestamps, no second listing, no per-file comparison. The same tree also
 * serves the *left side* of the diff, so "the last run" shows this run's lines rather than
 * every change since the base commit.
 *
 * The user's own index and working tree are never touched: `GIT_INDEX_FILE` points the
 * staging at a scratch file outside the repository. Objects are written into the repository's
 * object store, unreachable — git prunes them on its usual schedule, the same way it handles
 * what `git stash create` leaves behind.
 */

/** git's hash of the empty tree: the "before" for a repository with no commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Scheme for a file's content as it was in a snapshot. */
export const TREE_SIDE_SCHEME = 'redline-tree';

/** What happened to a path between two trees. */
export type TreeChange =
  | { kind: 'added' }
  | { kind: 'deleted' }
  | { kind: 'modified' }
  | { kind: 'renamed'; from: string };

/** Runs git in the repository. `env` is merged over the process environment. */
export type GitRunner = (args: string[], env?: Record<string, string>) => Promise<string>;

/**
 * Staging 42k files costs about 6 seconds against an empty index and under one against a
 * copy of the repository's own — git's stat cache does the work. So the real index is copied
 * first, every time, and this file is only ever scratch.
 */
let sequence = 0;

/**
 * A scratch index, unique to this call.
 *
 * `git add` takes a `.lock` beside whichever index it is given, so a shared path means two
 * snapshots at once — two windows on one repository, or a second caller in this process — and
 * one of them fails with "Another git process seems to be running in this repository". There
 * is nothing to gain from sharing it either: the repository's own index is copied over it
 * every time, so it carries nothing between calls. Unique per call, and removed afterwards.
 */
function shadowIndexPath(root: string): string {
  const id = createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `redline-${id}-${process.pid}-${sequence++}.index`);
}

/**
 * Snapshot the working tree; returns the tree's hash.
 *
 * Undefined on any failure, which every caller treats as "no snapshot available" and falls
 * back to the older signals. Nothing here is worth breaking the panel over.
 */
export async function snapshotWorkingTree(
  root: string,
  run: GitRunner,
  onFail?: (reason: string) => void,
): Promise<string | undefined> {
  const shadow = shadowIndexPath(root);
  try {
    // `--git-path` resolves correctly in a linked worktree, where the index does not live in
    // `<root>/.git` at all but under `.git/worktrees/<name>/`.
    const real = (await run(['rev-parse', '--git-path', 'index'])).trim();
    if (real) {
      try {
        await fs.copyFile(path.resolve(root, real), shadow);
      } catch {
        // No index yet (a fresh repository). Staging from empty is slower but correct.
        await fs.rm(shadow, { force: true });
      }
    }
    // `--ignore-errors` so one unreadable file cannot cost the whole snapshot. Gitignore is
    // respected, which is what keeps this from hashing node_modules.
    //
    // It still *exits* non-zero when any path failed, which is documented and easy to hit: a
    // file the agent is in the middle of moving vanishes between being listed and being read.
    // Everything else is staged by then, so the failure is noted and the tree is written
    // anyway — abandoning the snapshot over one transient file would give up exactly when the
    // tree is changing fastest.
    try {
      await run(['add', '-A', '--ignore-errors', '--'], { GIT_INDEX_FILE: shadow });
    } catch {
      // Partial staging; `write-tree` below either produces a tree or fails outright.
    }
    const tree = (await run(['write-tree'], { GIT_INDEX_FILE: shadow })).trim();
    if (/^[0-9a-f]{40,64}$/.test(tree)) return tree;
    onFail?.(`write-tree returned ${JSON.stringify(tree.slice(0, 80))}`);
    return undefined;
  } catch (err) {
    // Reported rather than swallowed: without this, a snapshot that always fails looks exactly
    // like a working tree that never changes, and the panel quietly serves the older signals
    // forever with nothing to say why.
    const e = err as { message?: string; stderr?: string; signal?: string; code?: unknown };
    const detail = (e.stderr ?? '').trim() || e.message || String(err);
    onFail?.(`${detail.slice(0, 300)}${e.signal ? ` (signal ${e.signal})` : ''}`);
    return undefined;
  } finally {
    // Six or seven megabytes per call in a large repository, so it does not stay in the temp
    // directory; the lock goes too, in case git was killed before it could clean up.
    await fs.rm(shadow, { force: true }).catch(() => undefined);
    await fs.rm(`${shadow}.lock`, { force: true }).catch(() => undefined);
  }
}

/**
 * Split NUL-separated git output into records.
 *
 * `-z` is the only way to get paths out of git verbatim. `core.quotePath=false` stops it
 * escaping non-ASCII, but a path containing a double quote, a backslash or a newline is still
 * returned *quoted* — `"quote\\"double.ts"` — and taking that literally means every later
 * stat, URI and diff for that file is against a path that does not exist.
 */
export function nulFields(out: string): string[] {
  const parts = out.split('\0');
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Paths that differ between two trees or commits, and what happened to each.
 *
 * `-M` detects renames, so moving a file reads as a move rather than as one deletion and one
 * unrelated addition — the single most common shape of an agent's refactor.
 *
 * With `-z` the output is a flat run of NUL-terminated records: a status, then its path, and
 * for a rename the status followed by both paths.
 */
export async function treeChanges(from: string, to: string, run: GitRunner): Promise<Map<string, TreeChange>> {
  const fields = nulFields(
    await run(['diff-tree', '-r', '-M', '-z', '--no-color', '--name-status', from, to, '--']),
  );
  const map = new Map<string, TreeChange>();
  for (let i = 0; i < fields.length; ) {
    const code = (fields[i++] ?? '').trim();
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const was = fields[i++];
      const now = fields[i++];
      if (now) map.set(now, was && code.startsWith('R') ? { kind: 'renamed', from: was } : { kind: 'added' });
      continue;
    }
    const p = fields[i++];
    if (!p) continue;
    map.set(
      p,
      code.startsWith('A') ? { kind: 'added' } : code.startsWith('D') ? { kind: 'deleted' } : { kind: 'modified' },
    );
  }
  return map;
}

/**
 * Paths whose content git will not diff as text.
 *
 * `--numstat` prints `-` for both counts on a binary file, which is git's own judgement and
 * cheaper than guessing from the extension. It matters because the snapshot side of a
 * comparison is served as a *text* document: handing the editor a mangled UTF-8 rendering of
 * a PNG is worse than admitting there is nothing useful to show.
 */
export async function binaryPaths(from: string, to: string, run: GitRunner): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const fields = nulFields(
      await run(['diff-tree', '-r', '-M', '-z', '--no-color', '--numstat', from, to, '--']),
    );
    for (let i = 0; i < fields.length; ) {
      const record = fields[i++];
      if (record === undefined) break;
      const bits = record.split('\t');
      if (bits.length < 3) continue; // not a stat line
      // A tab is legal in a path, so everything after the two counts is the path.
      let p = bits.slice(2).join('\t');
      // A rename's record ends after the counts, and the two paths follow as their own fields.
      if (p === '') {
        const was = fields[i++];
        p = fields[i++] ?? was ?? '';
      }
      if (bits[0] === '-' && bits[1] === '-' && p) out.add(p);
    }
  } catch {
    // Not knowing means treating everything as text, which is what it was before.
  }
  return out;
}

/** A scratch index older than this belongs to a process that is no longer running. */
const SCRATCH_TTL_MS = 60 * 60 * 1000;

/**
 * Remove scratch indexes left behind by a process that was killed mid-snapshot.
 *
 * A crash skips the cleanup that every completed snapshot does, and each file is six or seven
 * megabytes in a large repository — forty of them had accumulated during a day of testing.
 * Age alone is enough to tell: a snapshot takes seconds, so nothing an hour old is in use.
 */
export async function sweepScratchIndexes(): Promise<void> {
  try {
    const dir = os.tmpdir();
    const now = Date.now();
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith('redline-') || !name.includes('.index')) continue;
      const full = path.join(dir, name);
      try {
        const { mtimeMs } = await fs.stat(full);
        if (now - mtimeMs > SCRATCH_TTL_MS) await fs.rm(full, { force: true });
      } catch {
        // gone already, or not ours to remove
      }
    }
  } catch {
    // no temp directory listing; the files are harmless either way
  }
}
