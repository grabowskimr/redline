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
function shadowIndexPath(root: string): string {
  const id = createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `redline-${id}.index`);
}

/**
 * Snapshot the working tree; returns the tree's hash.
 *
 * Undefined on any failure, which every caller treats as "no snapshot available" and falls
 * back to the older signals. Nothing here is worth breaking the panel over.
 */
export async function snapshotWorkingTree(root: string, run: GitRunner): Promise<string | undefined> {
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
    await run(['add', '-A', '--ignore-errors', '--'], { GIT_INDEX_FILE: shadow });
    const tree = (await run(['write-tree'], { GIT_INDEX_FILE: shadow })).trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Paths that differ between two trees or commits, and what happened to each.
 *
 * `-M` detects renames, so moving a file reads as a move rather than as one deletion and one
 * unrelated addition — the single most common shape of an agent's refactor.
 */
export async function treeChanges(from: string, to: string, run: GitRunner): Promise<Map<string, TreeChange>> {
  const out = await run(['diff-tree', '-r', '-M', '--no-color', '--name-status', from, to, '--']);
  const map = new Map<string, TreeChange>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = (parts[0] ?? '').trim();
    // A rename is `R100<TAB>old<TAB>new`; everything else is `X<TAB>path`.
    if ((code.startsWith('R') || code.startsWith('C')) && parts.length >= 3) {
      const was = parts[1]?.trim();
      const now = parts[2]?.trim();
      if (now) map.set(now, was && code.startsWith('R') ? { kind: 'renamed', from: was } : { kind: 'added' });
      continue;
    }
    const p = parts[1]?.trim();
    if (!p) continue;
    map.set(
      p,
      code.startsWith('A') ? { kind: 'added' } : code.startsWith('D') ? { kind: 'deleted' } : { kind: 'modified' },
    );
  }
  return map;
}
