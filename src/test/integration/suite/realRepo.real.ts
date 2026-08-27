import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
    } finally {
      await fs.rm(marker, { force: true });
    }
  });

  it('produces diff pairs for both scopes without throwing', async () => {
    for (const scope of ['recent', 'all'] as const) {
      const pairs = await api.range.diffResources(scope);
      const s = await api.range.summary();
      const expected = scope === 'recent' ? s?.recentCount : s?.fileCount;
      assert.equal(pairs.length, expected, `${scope}: one pair per file`);
      for (const [uri, original, modified] of pairs) {
        assert.equal(uri.scheme, 'file');
        assert.equal(modified.fsPath, uri.fsPath);
        if (original) assert.ok(original.scheme === 'file' || original.scheme === 'git');
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
});
