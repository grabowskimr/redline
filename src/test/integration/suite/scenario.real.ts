import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
    // Reporting is what is under test, not what it chooses to show. The setting is committed
    // in the fixture: updating it here would write into the working tree being asserted on.
    assert.equal(
      vscode.workspace.getConfiguration('redline').get('onRunFinished'),
      'nothing',
      'the fixture pins what happens on finish',
    );
  });

  it('lists exactly what the run changed, and nothing from before it', async () => {
    const s = await api.range.summary();
    assert.ok(s);
    console.log(`      via=${s.recentSource} recent=${s.recent.join(', ')}`);
    assert.equal(s.recentSource, 'hook', 'the tree snapshots were used');
    assert.deepEqual(
      [...s.recent].sort(),
      [
        'src/component.ts',
        'src/gone.ts',
        'src/moved.ts',
        'src/restored.ts',
        'src/utils.test.ts',
        'src/utils.ts',
      ],
      'both new files, the deletion, the rename, the updated import and the restored file',
    );
    assert.ok(!s.recent.includes('build/out.js'), 'ignored output stays out');

    // The one that was missing for real: the run undid an uncommitted edit, so the file is now
    // identical to the base commit. It differs from nothing there — and it is the whole point
    // of the review. Last and All answer different questions; neither contains the other.
    assert.ok(!s.files.includes('src/restored.ts'), 'nothing to show against the base commit');
    assert.equal(s.olderCount, s.files.filter((f) => !s.recent.includes(f)).length, 'older is what the run missed');
  });

  it('compares the last run against the file as the run found it, not against the base', async () => {
    const pairs = await api.range.diffResources('recent');
    const byPath = new Map(pairs.map((p) => [path.relative(root, p[0].fsPath), p]));

    const created = byPath.get('src/utils.ts');
    assert.ok(created, 'the file the run created is in the diff');
    // Labelled rather than merely empty: the multi-file editor shows this above the entry, and
    // an unlabelled empty pane reads the same as a file that lost all its content.
    assert.match(created[1].path, /utils\.ts \(new file\)$/, 'the left side says what happened');
    const left = await vscode.workspace.openTextDocument(created[1]);
    assert.equal(left.getText(), '', 'and is empty, because the file did not exist then');
    assert.equal(created[2].scheme, 'file', 'the whole new file on the right');

    const removed = byPath.get('src/gone.ts');
    assert.ok(removed, 'the deleted file is in the diff');
    assert.match(removed[2].path, /gone\.ts \(deleted\)$/, 'and its right side says so');

    const deleted = byPath.get('src/gone.ts');
    assert.ok(deleted, 'the deleted file is in the diff');
    const gone = await vscode.workspace.openTextDocument(deleted[1]);
    assert.equal(gone.getText(), 'export const gone = 1\n', 'its content before the run');

    const renamed = byPath.get('src/moved.ts');
    assert.ok(renamed, 'the renamed file is in the diff');
    const was = await vscode.workspace.openTextDocument(renamed[1]);
    assert.equal(was.getText(), 'export const kept = 1\n', 'compared against the path it came from');

    // The one that is easy to get wrong: this file was already modified when the run began.
    // The restored file has a real left side too: the comment that was there when the run
    // began, so the diff reads as the removal it was asked for.
    const restored = byPath.get('src/restored.ts');
    assert.ok(restored, 'the restored file is in the diff');
    const had = await vscode.workspace.openTextDocument(restored[1]);
    assert.ok(had.getText().includes('a stray comment'), 'the comment the run was asked to remove');

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
        [
          'src/component.ts',
          'src/gone.ts',
          'src/moved.ts',
          'src/restored.ts',
          'src/utils.test.ts',
          'src/utils.ts',
        ],
        'the same answer as with a stop marker',
      );
    } finally {
      await fs.writeFile(stopped, saved, 'utf8');
      api.range.invalidate(true);
    }
  });

  it('takes no snapshot at all while nothing is changing, and one when something does', async () => {
    // Every snapshot walks the whole working tree — over a second in a large repository — so
    // an open window that is doing nothing must not be paying for it. The rule is that a tree
    // nothing has changed since is not stale, however old it is.
    await api.range.summary();
    const quiet = api.range.snapshotCount;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1500)); // longer than the pacing window
      api.range.invalidate(true);
      await api.range.summary();
    }
    assert.equal(
      api.range.snapshotCount,
      quiet,
      `no snapshots were taken while the tree sat still (was ${quiet}, now ${api.range.snapshotCount})`,
    );

    // And it does notice a change, rather than serving the old tree forever.
    const probe = path.join(root, 'src', 'probe.ts');
    await fs.writeFile(probe, 'export const probe = 1\n', 'utf8');
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        api.range.invalidate(true);
        const s = await api.range.summary();
        if (s?.recent.includes('src/probe.ts')) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const s = await api.range.summary();
      assert.ok(s?.recent.includes('src/probe.ts'), 'the new file turned up in the last run');
      assert.ok(api.range.snapshotCount > quiet, 'which took a snapshot');
      console.log(`      snapshots: ${quiet} while idle, ${api.range.snapshotCount} after a write`);
    } finally {
      await fs.rm(probe, { force: true });
    }
  });

  it('reports a run that was started from the terminal, with no session it can reach', async () => {
    // The scenario has no Claude Code process at all, which is the strict version of the case
    // this exists for: someone typing in iTerm or tmux. Redline can never *send* there, but
    // the run still happened and the hook recorded it — and for a long time that meant the
    // whole thing went unreported, because reporting was gated on finding a session to send
    // to. Nothing about knowing a run finished requires being able to reach it.
    const state = process.env.REDLINE_SCENARIO_STATE;
    assert.ok(state, 'the scenario passed its state directory');
    const stopped = path.join(state, 'stopped.json');
    const marker = JSON.parse(await fs.readFile(stopped, 'utf8')) as { at: string; tree?: string };

    // A marker this window has not seen, so the assertion does not depend on whether an
    // earlier test in this file already consumed the scenario's own.
    const fresh = (offsetMs: number): Promise<void> =>
      fs.writeFile(
        stopped,
        JSON.stringify({ ...marker, at: new Date(Date.parse(marker.at) + offsetMs).toISOString() }),
        'utf8',
      );
    await fresh(60_000);
    const before = api.hookRuns();
    await api.reportHookRun();
    assert.equal(api.hookRuns(), before + 1, 'the run was reported with no reachable session');

    // And exactly once: the hook writes state for every repository under one directory, so a
    // run finishing in another worktree signals here too.
    await api.reportHookRun();
    await api.reportHookRun();
    assert.equal(api.hookRuns(), before + 1, 'the same run is not announced again');

    // A genuinely new run is a new marker, and that one does get through.
    await fresh(120_000);
    await api.reportHookRun();
    assert.equal(api.hookRuns(), before + 2, 'the next run was reported');
    await fs.writeFile(stopped, JSON.stringify(marker), 'utf8');
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
