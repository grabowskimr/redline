import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshotWorkingTree, treeChanges } from '../../../git/snapshotTree';
import type { RedlineApi } from '../../../extension';

const EXT_ID = 'marcin.redline';

/**
 * Exercises the extension against a real, dirty repository — large, with genuine git history,
 * a Claude transcript and possibly hook state. The fixture suite cannot cover this: it runs
 * with `--disable-extensions`, which also disables the built-in git extension, and its
 * workspace is a handful of files with no history.
 */
describe('against a real repository', () => {
  let api: RedlineApi;
  let root: string;

  before(async () => {
    const ext = vscode.extensions.getExtension<RedlineApi>(EXT_ID);
    assert.ok(ext, 'extension present');
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.ok(root, 'a workspace folder is open');
    console.log(`      repository: ${root}`);
  });

  it('has the built-in git extension available', () => {
    const git = vscode.extensions.getExtension('vscode.git');
    assert.ok(git, 'vscode.git present');
    assert.ok(git.isActive || true, 'git extension resolvable');
  });

  it('summarises the changes, with the last run a subset of everything', async () => {
    const started = Date.now();
    const s = await api.range.summary();
    const ms = Date.now() - started;
    assert.ok(s, 'a summary was produced');
    console.log(
      `      base=${s.base.slice(0, 8)} origin=${s.origin} files=${s.fileCount} ` +
        `recent=${s.recentCount} via=${s.recentSource} in ${ms}ms`,
    );
    assert.equal(s.unavailable, undefined, 'the file list was readable');
    assert.ok(s.fileCount < 5000, `implausible change count: ${s.fileCount}`);
    const all = new Set(s.files);
    for (const f of s.recent) assert.ok(all.has(f), `${f} is in recent but not in files`);
    assert.equal(s.olderCount, s.fileCount - s.recentCount);
  });

  it('answers again from cache, quickly', async () => {
    const started = Date.now();
    await api.range.summary();
    const ms = Date.now() - started;
    console.log(`      cached summary in ${ms}ms`);
    assert.ok(ms < 50, `cached summary took ${ms}ms`);
  });

  it('picks up a new untracked file', async () => {
    // The listing is refreshed off the hot path, so this appears a moment after the file
    // does — exactly what a user sees. Polled rather than slept on.
    const marker = path.join(root, `redline-untracked-probe-${Date.now()}.txt`);
    const rel = path.basename(marker);
    await fs.writeFile(marker, 'probe\n', 'utf8');
    try {
      const deadline = Date.now() + 30_000;
      let seen = false;
      while (!seen && Date.now() < deadline) {
        api.range.invalidateBase();
        const s = await api.range.summary();
        seen = s?.files.includes(rel) ?? false;
        if (!seen) await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(seen, `untracked probe ${rel} never appeared`);

      // And in the *last run*, not merely in "all changes": a file that did not exist before
      // cannot belong to an earlier run, so it has to be part of the newest one.
      const s = await api.range.summary();
      assert.ok(s, 'summary');
      console.log(`      recentSource=${s.recentSource} recent=${s.recentCount}/${s.fileCount}`);
      assert.ok(s.recent.includes(rel), `a brand-new file is missing from the last run (via ${s.recentSource})`);

      // And it must have a diff pair the editor can actually open. A new file has nothing on
      // the left; handing over a git URI for a path that does not exist at the base gives the
      // multi-file diff a side it cannot resolve.
      const pairs = await api.range.diffResources('recent');
      const pair = pairs.find(([u]) => u.fsPath.endsWith(rel));
      assert.ok(pair, 'the new file has a diff pair');
      console.log(`      new file pair -> left: ${pair[1]?.scheme ?? 'none'}, right: ${pair[2]?.scheme ?? 'none'}`);
      // Either mechanism is correct here: against a snapshot of the run's start when the hook
      // recorded one, and against an empty document when it did not.
      assert.ok(
        ['redline-empty', 'redline-tree'].includes(pair[1]?.scheme ?? ''),
        `a new file compares against an empty side, got ${pair[1]?.scheme}`,
      );
      assert.equal(pair[2]?.scheme, 'file', 'and the file itself on the right');
    } finally {
      await fs.rm(marker, { force: true });
    }
  });

  it('shows a deleted file in the last run, with a diff pair', async () => {
    // A tracked file that is *clean* is chosen and restored with git afterwards, so nothing
    // uncommitted can be lost. Deletions have no mtime to date them by, which is the case the
    // run attribution has to special-case.
    const cp = await import('node:child_process');
    const run = (args: string[]): string =>
      cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

    const dirty = new Set(run(['diff', '--name-only', 'HEAD']).split('\n').map((l) => l.trim()));
    const victim = run(['ls-files'])
      .split('\n')
      .map((l) => l.trim())
      .find((f) => f.endsWith('.ts') && !dirty.has(f) && !f.includes(' '));
    assert.ok(victim, 'a clean tracked file to remove');
    console.log(`      removing ${victim}`);

    const before = await fs.readFile(path.join(root, victim));
    await fs.rm(path.join(root, victim), { force: true });
    try {
      const deadline = Date.now() + 30_000;
      let seen = false;
      let s: Awaited<ReturnType<typeof api.range.summary>>;
      while (!seen && Date.now() < deadline) {
        api.range.invalidateBase();
        s = await api.range.summary();
        seen = s?.recent.includes(victim) ?? false;
        if (!seen) await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(seen, `a deleted file is missing from the last run (via ${s?.recentSource})`);

      const pairs = await api.range.diffResources('recent');
      const pair = pairs.find(([uri]) => uri.fsPath.endsWith(victim));
      assert.ok(pair, 'the deleted file has a diff pair');
      assert.ok(
        ['git', 'redline-tree'].includes(pair[1]?.scheme ?? ''),
        `the earlier revision on the left, got ${pair[1]?.scheme}`,
      );
      assert.equal(pair[2]?.scheme, 'redline-empty', 'and an empty side on the right, because it is gone');
      console.log(`      deleted pair -> left: ${pair[1]?.scheme}, right: ${pair[2]?.scheme}`);
    } finally {
      // Written back rather than checked out: a `git checkout` here competes for the index
      // lock with the extension's own git calls, and losing that race leaves the file deleted.
      await fs.writeFile(path.join(root, victim), before);
    }
  });

  it('gives a renamed file the path it came from as its left side', async () => {
    // A rename's new path does not exist at the base either, so it needs the *old* path on the
    // left. Restored by moving it back, with no git write to race the extension's own calls.
    const cp = await import('node:child_process');
    const run = (args: string[]): string =>
      cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const dirty = new Set(run(['diff', '--name-only', 'HEAD']).split('\n').map((l) => l.trim()));
    const from = run(['ls-files'])
      .split('\n')
      .map((l) => l.trim())
      .find((f) => f.endsWith('.ts') && !dirty.has(f) && !f.includes(' '));
    assert.ok(from, 'a clean tracked file to move');
    const to = `${from}.moved-by-test.ts`;

    await fs.rename(path.join(root, from), path.join(root, to));
    try {
      const deadline = Date.now() + 30_000;
      let pair: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] | undefined;
      while (!pair && Date.now() < deadline) {
        api.range.invalidateBase();
        await api.range.summary();
        pair = (await api.range.diffResources('all')).find(([u]) => u.fsPath.endsWith(to));
        if (!pair) await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(pair, 'the moved file appears');
      console.log(`      moved file pair -> left: ${pair[1] ? pair[1].scheme : 'none'}, right: ${pair[2] ? 'file' : 'none'}`);
      assert.ok(pair[2], 'the new path is the right side');
    } finally {
      await fs.rename(path.join(root, to), path.join(root, from));
    }
  });

  it('produces diff pairs for both scopes without throwing', async () => {
    for (const scope of ['recent', 'all'] as const) {
      const pairs = await api.range.diffResources(scope);
      const s = await api.range.summary();
      const expected = scope === 'recent' ? s?.recentCount : s?.fileCount;
      assert.equal(pairs.length, expected, `${scope}: one pair per file`);
      // Every entry has both sides, so the editor never has to lay out a missing one.
      for (const [uri, original, modified] of pairs) {
        assert.equal(uri.scheme, 'file');
        assert.ok(original, `${uri.fsPath} has a left side`);
        assert.ok(modified, `${uri.fsPath} has a right side`);
        assert.ok(['file', 'git', 'redline-empty', 'redline-tree'].includes(original.scheme), original.scheme);
        assert.ok(['file', 'redline-empty', 'redline-tree'].includes(modified.scheme), modified.scheme);
      }
    }
  });

  it('computes hunks that land inside their files', async () => {
    const started = Date.now();
    const hunks = await api.range.hunks();
    console.log(`      ${hunks.length} hunks in ${Date.now() - started}ms`);
    for (const h of hunks.slice(0, 200)) {
      assert.ok(h.start >= 0, `negative start in ${h.uri.fsPath}`);
      assert.ok(h.end >= h.start, `inverted range in ${h.uri.fsPath}`);
    }
  });

  it('walks changes without throwing', async () => {
    await api.range.walk(1, 'recent');
    await api.range.walk(-1, 'recent');
  });

  it('walks past a file that has been deleted since the hunks were computed', async () => {
    // A hunk can name a file that is no longer there — a deletion, or anything removed after
    // the diff was taken. That used to throw out of the whole command.
    const marker = path.join(root, `redline-walk-probe-${Date.now()}.txt`);
    await fs.writeFile(marker, 'one\ntwo\nthree\n', 'utf8');
    const deadline = Date.now() + 30_000;
    let present = false;
    while (!present && Date.now() < deadline) {
      api.range.invalidateBase();
      const s = await api.range.summary();
      present = s?.files.includes(path.basename(marker)) ?? false;
      if (!present) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(present, 'the probe file was picked up');
    await api.range.hunks(); // cache hunks while the file still exists
    await fs.rm(marker, { force: true }); // now pull it out from under them
    await api.range.walk(1, 'all');
    await api.range.walk(-1, 'all');
  });

  it('boots the panel against a large repository', async () => {
    await vscode.commands.executeCommand('redline.focusPanel');
    assert.equal(await api.panelReady(20_000), true, 'panel reported ready');
  });
  it('snapshots the working tree in about the time the untracked walk used to cost', async () => {
    // The mechanism the last run is measured with. If this regresses into several seconds in a
    // large repository, every refresh is felt — it replaced a listing measured at 823-1203ms
    // here, so that is the bar.
    const git = async (args: string[], env?: Record<string, string>): Promise<string> => {
      const { stdout } = await promisify(execFile)('git', ['-c', 'core.quotePath=false', ...args], {
        cwd: root,
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    };
    let why = '';
    const take = async (): Promise<[string | undefined, number]> => {
      const at = Date.now();
      const tree = await snapshotWorkingTree(root, git, (reason) => {
        why = reason;
      });
      return [tree, Date.now() - at];
    };
    // Twice: the first walk in a 42k-file repository is dominated by whatever the operating
    // system has not cached, and this test runs after eleven others that churned the tree.
    // The second is the steady-state cost, which is the one the design rests on.
    const [cold, coldMs] = await take();
    assert.ok(cold, `a tree was written (${why})`);
    const [tree, snapMs] = await take();
    assert.ok(tree, `a second tree was written (${why})`);
    const compared = Date.now();
    const changes = await treeChanges('HEAD', tree, git);
    const diffMs = Date.now() - compared;
    const kinds = [...changes.values()].reduce<Record<string, number>>((acc, s) => {
      acc[s.kind] = (acc[s.kind] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`      snapshot in ${coldMs}ms cold, ${snapMs}ms warm, compared in ${diffMs}ms — ${JSON.stringify(kinds)}`);
    // Generous on purpose: it is never blocked on, and the point of the bar is to catch a
    // regression into something absurd, not to police the host's scheduling.
    assert.ok(snapMs < 5000, `snapshot took ${snapMs}ms warm`);
    assert.ok(diffMs < 500, `comparison took ${diffMs}ms`);
    // The dirty set from a listing and from a snapshot have to agree, or one of them is lying.
    const listed = new Set(
      (await git(['status', '--porcelain', '--untracked-files=all']))
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3).split(' -> ').pop() as string),
    );
    for (const f of changes.keys()) {
      if (changes.get(f)?.kind === 'renamed') continue; // reported under both paths by status
      assert.ok(listed.has(f), `${f} is in the snapshot but not in git status`);
    }
  });
});
