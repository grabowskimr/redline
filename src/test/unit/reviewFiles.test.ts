import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewFiles } from '../../view/reviewFiles';

describe('reviewing the actual comparison contents', () => {
  it('opens displayed comparisons and advances without rebuilding the file list', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    let reads = 0;
    const range = { summary: async () => ({ label: 'base' }), repoRoot: async () => '/repo', runComparison: () => undefined,
      diffResources: async () => { reads++; return ['a.ts', 'b.ts'].map((name) => [vscode.Uri.file('/repo/' + name), empty, empty]); } };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    const execute = vscode.commands.executeCommand, opened: string[] = [];
    Object.assign(vscode.commands, { executeCommand: async (_command: string, _left: unknown, _right: unknown, title: string) => { opened.push(title); } });
    try {
      await files.refresh('recent'); reads = 0;
      assert.equal(await files.open(files.state.files[0]!.id), true);
      assert.equal(await files.nextUnreviewed(), true);
      assert.equal(reads, 0, 'clicks must not scan every changed file again');
      assert.ok(opened[0]?.startsWith('a.ts')); assert.ok(opened[1]?.startsWith('b.ts'));
    } finally { files.dispose(); Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('keeps the latest clicked row selected when an earlier editor finishes opening later', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    const range = { summary: async () => ({ label: 'base' }), repoRoot: async () => '/repo', runComparison: () => undefined,
      diffResources: async () => ['a.ts', 'b.ts'].map((name) => [vscode.Uri.file('/repo/' + name), empty, empty]) };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    const execute = vscode.commands.executeCommand;
    let release!: () => void, entered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { entered = resolve; });
    const firstOpening = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(vscode.commands, { executeCommand: async (_command: string, _left: unknown, _right: unknown, title: string) => {
      if (title.startsWith('a.ts')) { entered(); await firstOpening; }
    } });
    try {
      await files.refresh('recent'); const [a, b] = files.state.files;
      const first = files.open(a!.id); await firstStarted;
      await files.open(b!.id); release(); await first;
      assert.equal(files.state.selectedId, b!.id, 'an older completion must not move focus back');
    } finally { release(); files.dispose(); Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('refuses old file IDs after switching repositories without rebuilding either list', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    let root = '/repo', reads = 0;
    const range = { summary: async () => ({ label: 'base' }), repoRoot: async () => root, runComparison: () => undefined,
      diffResources: async () => { reads++; return [[vscode.Uri.file(root + '/a.ts'), empty, empty]]; } };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    const execute = vscode.commands.executeCommand; let opens = 0;
    Object.assign(vscode.commands, { executeCommand: async () => { opens++; } });
    try {
      await files.refresh('recent'); const id = files.state.files[0]!.id; root = '/other-worktree';
      assert.equal(await files.open(id), false); assert.equal(opens, 0); assert.equal(reads, 1);
      files.dispose(); assert.equal(await files.open(id), false);
    } finally { files.dispose(); Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('cancels an older pending click before dispatching its editor', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    let delay = false, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const range = { summary: async () => ({ label: 'base' }), repoRoot: async () => { if (delay) await gate; return '/repo'; }, runComparison: () => undefined,
      diffResources: async () => ['a.ts', 'b.ts'].map((name) => [vscode.Uri.file('/repo/' + name), empty, empty]) };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    const execute = vscode.commands.executeCommand, opened: string[] = [];
    Object.assign(vscode.commands, { executeCommand: async (_command: string, _left: unknown, _right: unknown, title: string) => { opened.push(title); } });
    try {
      await files.refresh('recent'); delay = true;
      const first = files.open(files.state.files[0]!.id); const second = files.open(files.state.files[1]!.id);
      release(); assert.deepEqual(await Promise.all([first, second]), [true, true], 'superseded clicks must not trigger a stale-diff notification');
      assert.equal(opened.length, 1); assert.ok(opened[0]?.startsWith('b.ts'));
    } finally { release(); files.dispose(); Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('skips checkboxes still saving when advancing to the next file', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    const range = { summary: async () => ({ label: 'base' }), repoRoot: async () => '/repo', runComparison: () => undefined,
      diffResources: async () => ['a.ts', 'b.ts'].map((name) => [vscode.Uri.file('/repo/' + name), empty, empty]) };
    const files = new ReviewFiles(range as never, { get: () => undefined, update: async () => {} } as never);
    const execute = vscode.commands.executeCommand;
    Object.assign(vscode.commands, { executeCommand: async () => {} });
    try {
      await files.refresh('recent'); const [a, b] = files.state.files;
      const saving = files.mark(a!.id, true);
      await files.nextUnreviewed(); assert.equal(files.state.selectedId, b!.id);
      assert.equal(await saving, true);
    } finally { files.dispose(); Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('resolves a displayed file for editing without taking another snapshot', async () => {
    const uri = vscode.Uri.file('/repo/renamed.ts'), empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    let reads = 0;
    const range = { summary: async () => ({ label: 'base' }), repoRoot: async () => '/repo', runComparison: () => undefined,
      diffResources: async () => { reads++; return [[uri, empty, empty]]; } };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try {
      await files.refresh('recent'); const before = reads;
      assert.equal(files.workingFile(files.state.files[0]!.id)?.toString(), uri.toString());
      assert.equal(files.workingFile('stale'), undefined);
      assert.equal(reads, before, 'opening a working file should not rebuild the review');
    } finally { files.dispose(); }
  });
  it('restores checklist marks when saving review progress fails', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    const range = { summary: async () => ({ label: 'base', recentLabel: 'run' }), repoRoot: async () => '/repo', runComparison: () => undefined,
      diffResources: async () => [[vscode.Uri.file('/repo/a.ts'), empty, empty]] };
    const files = new ReviewFiles(range as never, { get: () => undefined, update: async () => { throw new Error('storage failed'); } } as never);
    try {
      await files.refresh('recent'); assert.equal(await files.markAll(), false);
      assert.equal(files.state.files[0]?.reviewed, false); assert.match(files.state.markError ?? '', /storage failed/);
    } finally { files.dispose(); }
  });


  it('labels unsaved live editors without claiming their disk statistics are current', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-unsaved-stats-')), uri = vscode.Uri.file(path.join(root, 'a.ts'));
    await fs.writeFile(uri.fsPath, 'saved\n');
    const previous = vscode.workspace.textDocuments;
    Object.assign(vscode.workspace, { textDocuments: [{ uri, isDirty: true, getText: () => 'unsaved\nextra\n' }] });
    const range = { summary: async () => ({ label: 'base', recentLabel: 'run' }), repoRoot: async () => root, runComparison: () => undefined,
      diffResources: async () => [[uri, vscode.Uri.from({ scheme: 'redline-empty', path: '/a.ts' }), uri]] };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try { await files.refresh('recent'); assert.equal(files.state.files[0]?.unsaved, true); assert.equal(files.state.files[0]?.stats, undefined); }
    finally { files.dispose(); Object.assign(vscode.workspace, { textDocuments: previous }); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('navigates in Explorer order, with folders first and natural filename sorting', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    const range = { summary: async () => ({ recentLabel: 'finished' }), repoRoot: async () => '/repo',
      diffResources: async () => ['README.md', 'src/file10.ts', 'src/file2.ts'].map((name) => [vscode.Uri.file('/repo/' + name), empty, empty]),
      runComparison: () => undefined };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try {
      await files.refresh();
      assert.deepEqual(files.state.files.map((f) => f.path), ['src/file2.ts', 'src/file10.ts', 'README.md']);
    } finally { files.dispose(); }
  });
  it('allows the initial summary to publish and still captures its completed snapshots', async () => {
    const changed = new vscode.EventEmitter<void>();
    let reads = 0;
    const range = { onDidPublish: changed.event,
      summary: async () => { if (++reads === 1) changed.fire(); return { recentLabel: 'finished' }; },
      repoRoot: async () => '/repo', diffResources: async () => [],
      runComparison: () => ({ before: 'a'.repeat(40), after: 'b'.repeat(40), completed: true }) };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try {
      const review = await files.capture('recent');
      assert.equal(review?.after, 'b'.repeat(40));
      assert.equal(reads, 2);
    } finally { files.dispose(); changed.dispose(); }
  });

  it('refuses a mixed capture if the range keeps changing', async () => {
    const changed = new vscode.EventEmitter<void>();
    let reads = 0;
    const range = { onDidPublish: changed.event,
      summary: async () => ({ recentLabel: 'running' }), repoRoot: async () => '/repo',
      diffResources: async () => { reads++; changed.fire(); return []; }, runComparison: () => undefined };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try {
      assert.equal(await files.capture('recent'), undefined);
      assert.equal(reads, 3, 'retrying is bounded');
      assert.match(files.state.error ?? '', /changed while loading/);
      assert.deepEqual(files.state.files, []);
    } finally { files.dispose(); changed.dispose(); }
  });

  it('retries a same-repository session switch during the final root check', async () => {
    const changed = new vscode.EventEmitter<void>();
    let session = 1, roots = 0;
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    const range = { onDidChange: changed.event,
      summary: async () => ({ recentLabel: `session ${session}` }),
      repoRoot: async () => { if (++roots === 2) { session = 2; changed.fire(); } return '/repo'; },
      diffResources: async () => [[vscode.Uri.file(`/repo/session-${session}.ts`), empty, empty]],
      runComparison: () => ({ before: String(session).repeat(40), after: 'c'.repeat(40), completed: true }) };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try {
      const review = await files.capture('recent');
      assert.deepEqual(review?.files, ['session-2.ts']);
      assert.equal(review?.before, '2'.repeat(40));
      assert.match(review?.label ?? '', /session 2/);
    } finally { files.dispose(); changed.dispose(); }
  });

  it('retries a file list when another run publishes during the read', async () => {
    const changed = new vscode.EventEmitter<void>();
    let run = 1;
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    const range = {
      onDidPublish: changed.event,
      summary: async () => ({ label: 'base', recentLabel: `run ${run}` }), repoRoot: async () => '/repo',
      diffResources: async () => {
        const prior = run;
        if (run === 1) { run = 2; changed.fire(); }
        return [[vscode.Uri.file(`/repo/run-${prior}.ts`), empty, empty]];
      },
      runComparison: () => ({ before: String(run).repeat(40), after: String(run + 1).repeat(40), completed: true }),
    };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try {
      const review = await files.capture('recent');
      assert.deepEqual(review?.files, ['run-2.ts']);
      assert.equal(review?.before, '2'.repeat(40));
      assert.equal(review?.after, '3'.repeat(40));
      assert.match(review?.label ?? '', /run 2/);
    } finally { files.dispose(); changed.dispose(); }
  });

  it('does not call a running comparison an immutable completed snapshot', async () => {
    const empty = vscode.Uri.from({ scheme: 'redline-empty', path: '/empty' });
    const range = { summary: async () => ({ recentLabel: 'running' }), repoRoot: async () => '/repo',
      diffResources: async () => [[vscode.Uri.file('/repo/a.ts'), empty, empty]],
      runComparison: () => ({ before: 'a'.repeat(40), after: 'b'.repeat(40), completed: false }) };
    const files = new ReviewFiles(range as never, { get: () => undefined } as never);
    try {
      const review = await files.capture('recent');
      assert.equal(review?.before, 'a'.repeat(40));
      assert.equal(review?.after, undefined);
    } finally { files.dispose(); }
  });

  it('advances to the next unreviewed file without requiring a mark first', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-progress-next-'));
    await fs.writeFile(path.join(root, 'a'), 'A'); await fs.writeFile(path.join(root, 'b'), 'B');
    const makePair = (name: string) => [vscode.Uri.file(path.join(root, name)), vscode.Uri.from({ scheme: 'redline-empty', path: '/' + name }), vscode.Uri.file(path.join(root, name))];
    const range = { summary: async () => ({ label: 'base', recentLabel: 'last run' }), repoRoot: async () => root, diffResources: async () => [makePair('a'), makePair('b')], runComparison: () => undefined };
    const files = new ReviewFiles(range as never, { get: () => undefined, update: async () => {} } as never);
    const execute = vscode.commands.executeCommand, opened: string[] = [];
    Object.assign(vscode.commands, { executeCommand: async (_id: string, _left: vscode.Uri, right: vscode.Uri) => { opened.push(right.fsPath); } });
    try {
      const selections: Array<string | undefined> = [];
      const subscription = files.onDidChange(() => selections.push((files.state as { selectedId?: string }).selectedId));
      await files.nextUnreviewed();
      assert.equal((files.state as { selectedId?: string }).selectedId, files.state.files[0]?.id);
      assert.equal(files.state.selectionVersion, 1);
      await files.nextUnreviewed();
      assert.equal((files.state as { selectedId?: string }).selectedId, files.state.files[1]?.id);
      assert.equal(files.state.selectionVersion, 2);
      assert.equal(selections.at(-1), files.state.files[1]?.id, 'opening publishes the selected row to the panel');
      subscription.dispose();
      assert.deepEqual(opened, [path.join(root, 'a'), path.join(root, 'b')]);
    } finally { Object.assign(vscode.commands, { executeCommand: execute }); files.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('marks bytes on both sides and refuses a stale action after a file changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-progress-'));
    const before = path.join(root, 'before'), after = path.join(root, 'after');
    await fs.writeFile(before, Buffer.from([0, 1])); await fs.writeFile(after, Buffer.from([0, 2]));
    const pair = [vscode.Uri.file(path.join(root, 'image.bin')), vscode.Uri.file(before), vscode.Uri.file(after)];
    const range = { summary: async () => ({ base: 'a'.repeat(40), label: 'base', recentLabel: 'last run' }), repoRoot: async () => root, diffResources: async () => [pair], runComparison: () => undefined };
    const data = new Map<string, unknown>();
    const files = new ReviewFiles(range as never, { get: (key: string) => data.get(key), update: async (key: string, value: unknown) => { data.set(key, value); } } as never);
    try {
      await files.refresh('recent'); const id = files.state.files[0]!.id;
      assert.equal(await files.mark(id, true), true);
      assert.equal(files.state.files[0]?.reviewed, true);
      await fs.writeFile(after, Buffer.from([0, 3]));
      await files.refresh();
      assert.equal(files.state.files[0]?.reviewed, false);
      assert.equal(await files.mark(id, true), false);
    } finally { files.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
