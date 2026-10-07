import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { gitIn } from '../../git/savedComparison';
import { snapshotWorkingTree } from '../../git/snapshotTree';
import { stateDirectory } from '../../claude/statePaths';

interface RangeUnderTest {
  selectRepository(root: string, session?: string): void;
  summary(): Promise<{ recent: string[]; recentUnavailable?: string; base: string } | undefined>;
  diffResources(scope: string): Promise<vscode.Uri[][]>;
  sessions(): Promise<Array<{ root: string; id: string }>>;
  savedFileFingerprint?(uri: vscode.Uri): string;
  invalidate(): void;
  dispose(): void;
}

describe('2.0 session-owned viewer range', function () {
  this.timeout(15000);
  let root: string, home: string, range: RangeUnderTest, git: ReturnType<typeof gitIn>;
  let before: string, after: string;
  async function record(session = 'chosen', error?: string): Promise<void> {
    const at = new Date().toISOString();
    const state = {
      observedAt: at,
      snapshotError: error,
      before: { id: 'run', session, tree: before, at, head: (await git(['rev-parse', 'HEAD'])).trim() },
      after: { id: 'run', session, tree: after, at },
    };
    await fs.mkdir(stateDirectory(root, home), { recursive: true });
    await fs.writeFile(
      path.join(stateDirectory(root, home), 'runs.json'),
      JSON.stringify({
        version: 3,
        root,
        ...state,
        sessions: { [createHash('sha256').update(session).digest('hex')]: state },
      }),
    );
  }
  beforeEach(async () => {
    (vscode as unknown as { resetStub(): void }).resetStub();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-viewer-range-')));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-viewer-home-'));
    git = gitIn(root);
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await fs.writeFile(path.join(root, 'a.rs'), 'base\n');
    await git(['add', '-A']);
    await git(['commit', '-qm', 'base']);
    before = (await snapshotWorkingTree(root, git))!;
    await fs.writeFile(path.join(root, 'a.rs'), 'Claude\n');
    after = (await snapshotWorkingTree(root, git))!;
    let module: { ViewerRange?: new (...args: unknown[]) => RangeUnderTest } = {};
    try {
      module = require(path.join(__dirname, '../../viewer/range'));
    } catch {
      /* implementation absent before this test */
    }
    assert.ok(module.ViewerRange, 'The native viewer needs a session-owned range source');
    const saved = new Map<string, unknown>();
    range = new module.ViewerRange(
      () => [root],
      {
        get: (key: string) => saved.get(key),
        update: async (key: string, value: unknown) => {
          saved.set(key, value);
        },
      },
      home,
    );
  });
  afterEach(async () => {
    range?.dispose();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  it('lists hook sessions and opens the selected immutable pair', async () => {
    await record();
    range.selectRepository(root, 'chosen');
    assert.deepEqual(
      (await range.sessions()).map((s) => s.id),
      ['chosen'],
    );
    assert.deepEqual((await range.summary())?.recent, ['a.rs']);
    await fs.writeFile(path.join(root, 'a.rs'), 'later manual change\n');
    const pairs = await range.diffResources('recent');
    assert.equal(pairs[0]?.[2]?.scheme, 'redline-tree');
    assert.equal(typeof range.savedFileFingerprint, 'function');
    assert.match(range.savedFileFingerprint!(pairs[0]![2]!), /100644/);
    assert.equal(new URLSearchParams(pairs[0]![2]!.query).get('tree'), after);
  });
  it('never borrows another session when the chosen session has no record', async () => {
    await record('other');
    range.selectRepository(root, 'chosen');
    const summary = await range.summary();
    assert.deepEqual(summary?.recent, []);
    assert.ok(summary?.recentUnavailable);
  });
  it('reports a capture failure instead of showing an older snapshot as the new run', async () => {
    await record('chosen', 'Required clean filter failed');
    range.selectRepository(root, 'chosen');
    const summary = await range.summary();
    assert.deepEqual(summary?.recent, []);
    assert.match(summary?.recentUnavailable ?? '', /filter failed/);
  });
  it('rejects sessions from outside the current workspace', async () => {
    assert.throws(() => range.selectRepository(home, 'chosen'), /workspace|repository/i);
  });
  it('does not hide committed Claude edits when the viewer first opens after the run', async () => {
    const base = (await git(['rev-parse', 'HEAD'])).trim();
    await record();
    await git(['add', '-A']); await git(['commit', '-qm', 'Claude commit']);
    range.selectRepository(root, 'chosen');
    assert.equal((await range.summary())?.base, base);
  });
  it('keeps the review base when Claude commits on the main branch', async () => {
    await record();
    range.selectRepository(root, 'chosen');
    const base = (await range.summary())!.base;
    await git(['add', '-A']);
    await git(['commit', '-qm', 'Claude commit']);
    range.invalidate();
    assert.equal((await range.summary())!.base, base);
  });
});
