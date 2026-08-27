import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TREE_SIDE_SCHEME } from '../../../git/snapshotTree';
import type { RedlineApi } from '../../../extension';

const EXT_ID = 'marcin.redline';

/**
 * The scenario `scripts/scenario.sh` builds: a repository where one run extracted a helper
 * into a new file, wrote its test, updated the importing component, deleted one file and
 * renamed another — with an edit from an *earlier* run sitting in the same component file.
 *
 * Every one of these assertions is a bug that was reported by hand at least once. The last
 * run has been wrong in every direction: new files missing entirely because the untracked
 * listing was never blocked on, files from earlier runs listed as current, an edit from a
 * previous run showing up in the diff of this one.
 */
describe('the run Claude just finished', function () {
  let api: RedlineApi;
  let root: string;

  before(async function () {
    if (process.env.REDLINE_SCENARIO !== '1') this.skip();
    const ext = vscode.extensions.getExtension<RedlineApi>(EXT_ID);
    assert.ok(ext, 'extension present');
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.ok(root, 'a workspace folder is open');
  });

  it('lists exactly what the run changed, and nothing from before it', async () => {
    const s = await api.range.summary();
    assert.ok(s);
    console.log(`      via=${s.recentSource} recent=${s.recent.join(', ')}`);
    assert.equal(s.recentSource, 'hook', 'the tree snapshots were used');
    assert.deepEqual(
      [...s.recent].sort(),
      ['src/component.ts', 'src/gone.ts', 'src/moved.ts', 'src/utils.test.ts', 'src/utils.ts'],
      'both new files, the deletion, the rename and the updated import',
    );
    assert.ok(!s.recent.includes('build/out.js'), 'ignored output stays out');
  });

  it('compares the last run against the file as the run found it, not against the base', async () => {
    const pairs = await api.range.diffResources('recent');
    const byPath = new Map(pairs.map((p) => [path.relative(root, p[0].fsPath), p]));

    const created = byPath.get('src/utils.ts');
    assert.ok(created, 'the file the run created is in the diff');
    assert.equal(created[1].scheme, TREE_SIDE_SCHEME, 'its left side comes from the snapshot');
    const left = await vscode.workspace.openTextDocument(created[1]);
    assert.equal(left.getText(), '', 'and is empty, because the file did not exist then');
    assert.equal(created[2].scheme, 'file', 'the whole new file on the right');

    const deleted = byPath.get('src/gone.ts');
    assert.ok(deleted, 'the deleted file is in the diff');
    const gone = await vscode.workspace.openTextDocument(deleted[1]);
    assert.equal(gone.getText(), 'export const gone = 1\n', 'its content before the run');

    const renamed = byPath.get('src/moved.ts');
    assert.ok(renamed, 'the renamed file is in the diff');
    const was = await vscode.workspace.openTextDocument(renamed[1]);
    assert.equal(was.getText(), 'export const kept = 1\n', 'compared against the path it came from');

    // The one that is easy to get wrong: this file was already modified when the run began.
    const edited = byPath.get('src/component.ts');
    assert.ok(edited, 'the edited file is in the diff');
    const before = await vscode.workspace.openTextDocument(edited[1]);
    assert.ok(
      before.getText().includes('export const earlier = 1'),
      'the left side still holds the earlier run\'s edit, so only this run\'s lines show as changed',
    );
  });

  it('is exact while the run is still going, without making the panel wait for it', async () => {
    // No stop marker yet: the hook has recorded where the run started and nothing else, which
    // is the state throughout a run. The panel then has to snapshot the tree itself — off the
    // hot path, because that takes over a second in a large repository — so the first answer
    // may come from the older signals and the exact one follows.
    const state = process.env.REDLINE_SCENARIO_STATE;
    assert.ok(state, 'the scenario passed its state directory');
    const stopped = path.join(state, 'stopped.json');
    const saved = await fs.readFile(stopped, 'utf8');
    await fs.rm(stopped);
    try {
      api.range.invalidate(true);
      const started = Date.now();
      const first = await api.range.summary();
      const firstMs = Date.now() - started;
      console.log(`      mid-run first answer in ${firstMs}ms via ${first?.recentSource}`);
      assert.ok(firstMs < 2000, `the panel waited ${firstMs}ms for a snapshot`);

      const deadline = Date.now() + 30_000;
      let s = first;
      while (s?.recentSource !== 'hook' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        api.range.invalidate(true);
        s = await api.range.summary();
      }
      assert.equal(s?.recentSource, 'hook', 'the snapshot landed and the answer became exact');
      assert.deepEqual(
        [...(s?.recent ?? [])].sort(),
        ['src/component.ts', 'src/gone.ts', 'src/moved.ts', 'src/utils.test.ts', 'src/utils.ts'],
        'the same answer as with a stop marker',
      );
    } finally {
      await fs.writeFile(stopped, saved, 'utf8');
      api.range.invalidate(true);
    }
  });

  it('walks only the lines this run touched', async () => {
    const hunks = await api.range.hunks();
    const component = hunks.filter((h) => h.uri.fsPath.endsWith('src/component.ts'));
    assert.ok(component.length > 0, 'the edited file has hunks');
    // Three lines in the file after the run; the earlier run's line is not one of ours.
    const lines = new Set<number>();
    for (const h of component) for (let l = h.start; l <= h.end; l++) lines.add(l);
    assert.ok(lines.size <= 3, `the run's own lines only, got ${[...lines].join(',')}`);
  });
});
