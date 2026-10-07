import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitIn } from '../../git/savedComparison';
import { ReviewCheckpoint } from '../../git/reviewCheckpoint';
import { ReviewFiles } from '../../view/reviewFiles';

// Real Git repositories: the baseline, saved bytes and user's index are not mocked.
describe('unreviewed changes across runs', function () {
  this.timeout(20000);
  let root: string, base: string, git: ReturnType<typeof gitIn>, files: ReviewFiles;
  let latest: string[];
  const memory = { get: () => undefined, update: async () => {} };
  const names = () => files.state.files.map((f) => f.path);
  const pending = () => files.refresh('unreviewed');
  const accept = (name: string) => files.mark(files.state.files.find((f) => f.path === name)!.id, true);
  const makeFiles = () => new ReviewFiles({ summary: async () => ({ base, label: 'branch changes', recentLabel: 'latest run' }),
    repoRoot: async () => root, runComparison: () => undefined,
    diffResources: async () => latest.map((name) => [vscode.Uri.file(path.join(root, name)), vscode.Uri.from({ scheme: 'redline-empty', path: '/' + name }), vscode.Uri.file(path.join(root, name))]),
  } as never, memory as never);
  beforeEach(async () => {
    (vscode as unknown as { resetStub(): void }).resetStub();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-unreviewed-')); git = gitIn(root);
    await git(['init', '-q']);
    await git(['config', 'user.name', 'Review Test']); await git(['config', 'user.email', 'review@example.test']);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) await fs.writeFile(path.join(root, name), 'original\n');
    await git(['add', '.']); await git(['commit', '-qm', 'base']); base = (await git(['rev-parse', 'HEAD'])).trim();
    for (const name of ['a.ts', 'b.ts', 'c.ts']) await fs.writeFile(path.join(root, name), 'first change\n');
    latest = ['a.ts', 'b.ts', 'c.ts']; files = makeFiles();
  });
  afterEach(async () => { files.dispose(); Object.assign(vscode.workspace, { textDocuments: [] }); await fs.rm(root, { recursive: true, force: true }); });

  it('accepts rapid checkbox clicks without conflicting or rescanning the whole repository', async () => {
    await pending(); const ids = files.state.files.map((file) => file.id);
    const compare = ReviewCheckpoint.prototype.compare; let fullSnapshots = 0;
    ReviewCheckpoint.prototype.compare = async function (...args) { fullSnapshots++; return compare.apply(this, args); };
    try {
      assert.deepEqual(await Promise.all(ids.map((id) => files.mark(id, true))), [true, true, true]);
      assert.deepEqual(names(), []); assert.equal(files.state.acceptedCount, 3);
      assert.equal(fullSnapshots, 0, 'acceptance must validate selected paths, not snapshot the entire repository');
      files.dispose(); files = makeFiles(); await pending(); assert.deepEqual(names(), []);
    } finally { ReviewCheckpoint.prototype.compare = compare; }
  });
  it('opens the displayed saved version without another full snapshot after the working file changes', async () => {
    await pending(); const id = files.state.files.find((file) => file.path === 'a.ts')!.id;
    await fs.writeFile(path.join(root, 'a.ts'), 'new work after the displayed snapshot\n');
    const compare = ReviewCheckpoint.prototype.compare, retain = ReviewCheckpoint.prototype.retain, execute = vscode.commands.executeCommand;
    let snapshots = 0, retained = 0; const opened: vscode.Uri[] = [];
    ReviewCheckpoint.prototype.compare = async function (...args) { snapshots++; return compare.apply(this, args); };
    ReviewCheckpoint.prototype.retain = async function (...args) { retained++; return retain.apply(this, args); };
    Object.assign(vscode.commands, { executeCommand: async (_command: string, _left: vscode.Uri, right: vscode.Uri) => { opened.push(right); } });
    try {
      assert.equal(await files.open(id), true);
      assert.equal(await files.open(files.state.files.find((file) => file.path === 'b.ts')!.id), true);
      assert.equal(snapshots, 0, 'open must use the displayed immutable pair');
      assert.equal(retained, 1, 'retain a comparison once, not again for every row');
      const tree = new URLSearchParams(opened[0]!.query).get('tree');
      assert.equal(await git(['show', `${tree}:a.ts`]), 'first change\n');
      assert.equal(await accept('a.ts'), false, 'the speedup must not accept unseen working edits');
    } finally { ReviewCheckpoint.prototype.compare = compare; ReviewCheckpoint.prototype.retain = retain; Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('retries retention after failure and never opens an unretained comparison', async () => {
    await pending(); const id = files.state.files[0]!.id;
    const retain = ReviewCheckpoint.prototype.retain, execute = vscode.commands.executeCommand;
    let attempts = 0, opened = 0;
    ReviewCheckpoint.prototype.retain = async function (...args) { if (++attempts === 1) throw new Error('retention failed'); return retain.apply(this, args); };
    Object.assign(vscode.commands, { executeCommand: async () => { opened++; } });
    try {
      await assert.rejects(files.open(id), /retention failed/); assert.equal(opened, 0);
      assert.equal(await files.open(id), true); assert.equal(opened, 1); assert.equal(attempts, 2);
    } finally { ReviewCheckpoint.prototype.retain = retain; Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('bulk-accepts only the displayed versions and leaves newer or newly discovered changes pending', async () => {
    await pending(); const ids = files.state.files.map((file) => file.id);
    await fs.writeFile(path.join(root, 'a.ts'), 'unseen change\n');
    await fs.writeFile(path.join(root, 'new.ts'), 'new unseen file\n');
    const bulk = files as unknown as { markAll(ids: string[]): Promise<boolean> };
    assert.equal(typeof bulk.markAll, 'function', 'Mark all reviewed is available');
    assert.equal(await bulk.markAll(ids), false, 'stale files are reported rather than accepted');
    await pending(); assert.deepEqual(names(), ['a.ts', 'new.ts']);
    const context = await files.capture('unreviewed');
    assert.equal(await git(['show', `${context?.before}:a.ts`]), 'original\n');
    assert.equal(await git(['show', `${context?.before}:b.ts`]), 'first change\n');
  });
  it('bulk acceptance from the palette skips a checkbox already being saved', async () => {
    await pending();
    const acceptMany = ReviewCheckpoint.prototype.acceptMany;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ReviewCheckpoint.prototype.acceptMany = async function (...args) { started(); await gate; return acceptMany.apply(this, args); };
    try {
      const single = accept('a.ts'); await entered;
      const bulk = files.markAll(); release();
      assert.deepEqual(await Promise.all([single, bulk]), [true, true]);
      assert.deepEqual(names(), []); assert.equal(files.state.markError, undefined);
    } finally { release(); ReviewCheckpoint.prototype.acceptMany = acceptMany; }
  });
  it('preserves unsaved buffers and the real index when accepting all displayed files', async () => {
    await git(['add', 'b.ts']);
    const index = await fs.readFile(path.join(root, '.git/index'));
    Object.assign(vscode.workspace, { textDocuments: [{ uri: vscode.Uri.file(path.join(root, 'a.ts')), isDirty: true, getText: () => 'unsaved\n' }] });
    await pending();
    const bulk = files as unknown as { markAll(ids: string[]): Promise<boolean> };
    assert.equal(typeof bulk.markAll, 'function');
    assert.equal(await bulk.markAll(files.state.files.map((file) => file.id)), true);
    assert.deepEqual(names(), []); assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
    assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'first change\n');
    await pending(); assert.deepEqual(names(), []);
  });

  it('reports real per-file additions and deletions and the accepted-file progress', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'one\ntwo\n');
    await pending();
    const row = files.state.files.find((f) => f.path === 'a.ts') as unknown as { stats?: unknown };
    assert.deepEqual(row.stats, { added: 2, deleted: 1, binary: false });
    await accept('a.ts');
    assert.equal((files.state as unknown as { acceptedCount?: number }).acceptedCount, 1);
    await fs.appendFile(path.join(root, 'a.ts'), 'three\n'); await pending();
    assert.equal((files.state as unknown as { acceptedCount?: number }).acceptedCount, 0);
    assert.deepEqual((files.state.files.find((f) => f.path === 'a.ts') as unknown as { stats?: unknown }).stats, { added: 1, deleted: 0, binary: false });
  });
  it('keeps B and C after a follow-up only changes A, while Last run stays separate', async () => {
    await pending(); latest = ['a.ts']; await fs.writeFile(path.join(root, 'a.ts'), 'second change\n');
    await files.refresh('recent'); assert.deepEqual(names(), ['a.ts']);
    await pending(); assert.deepEqual(names(), ['a.ts', 'b.ts', 'c.ts']);
    await accept('a.ts'); assert.deepEqual(names(), ['b.ts', 'c.ts']);
  });
  it('compares only against accepted bytes, survives reload and preserves unchecked files', async () => {
    await pending(); await accept('a.ts'); files.dispose(); files = makeFiles();
    await fs.writeFile(path.join(root, 'a.ts'), 'second change\n');
    const context = await files.capture('unreviewed'); assert.ok(context?.before); assert.ok(context.after);
    assert.equal(await git(['show', `${context.before}:a.ts`]), 'first change\n');
    assert.equal(await git(['show', `${context.before}:b.ts`]), 'original\n');
    assert.equal(await git(['show', `${context.after}:a.ts`]), 'second change\n');
    assert.deepEqual(context.files, ['a.ts', 'b.ts', 'c.ts']);
    await git(['gc', '--prune=now']);
    assert.equal(await git(['show', `${context.before}:a.ts`]), 'first change\n');
  });
  it('shows a revert to the original base after accepting a different version', async () => {
    await pending(); await accept('a.ts'); await fs.writeFile(path.join(root, 'a.ts'), 'original\n');
    await pending(); assert.ok(names().includes('a.ts'));
    const context = await files.capture('unreviewed');
    assert.equal(await git(['show', `${context?.before}:a.ts`]), 'first change\n');
  });
  it('rejects stale acceptance but does not invalidate B when only A changes', async () => {
    await pending(); const a = files.state.files.find((f) => f.path === 'a.ts')!.id;
    const b = files.state.files.find((f) => f.path === 'b.ts')!.id;
    await fs.writeFile(path.join(root, 'a.ts'), 'second change\n');
    assert.equal(await files.mark(a, true), false);
    assert.equal(await files.mark(b, true), true); assert.deepEqual(names(), ['a.ts', 'c.ts']);
  });
  it('never stages anything or changes the working files while reading or accepting', async () => {
    await git(['add', 'b.ts']); await fs.writeFile(path.join(root, 'b.ts'), 'unstaged\n');
    const index = await fs.readFile(path.join(root, '.git/index'));
    const status = await git(['status', '--porcelain']);
    await pending(); await accept('a.ts');
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
    assert.equal(await git(['status', '--porcelain']), status);
    assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'first change\n');
  });
  it('accepts dirty text without saving it and detects later unsaved changes', async () => {
    let text = 'unsaved version\n';
    Object.assign(vscode.workspace, { textDocuments: [{ uri: vscode.Uri.file(path.join(root, 'a.ts')), isDirty: true, getText: () => text }] });
    await pending(); await accept('a.ts'); assert.deepEqual(names(), ['b.ts', 'c.ts']);
    text = 'later unsaved version\n';
    const context = await files.capture('unreviewed');
    assert.equal(await git(['show', `${context?.before}:a.ts`]), 'unsaved version\n');
    assert.equal(await git(['show', `${context?.after}:a.ts`]), text);
    assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'first change\n');
  });
  it('keeps deleted and binary files, and a recreated accepted deletion returns', async () => {
    await fs.rm(path.join(root, 'a.ts')); await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 255]));
    await pending(); await accept('a.ts'); await accept('image.bin'); assert.deepEqual(names(), ['b.ts', 'c.ts']);
    await fs.writeFile(path.join(root, 'a.ts'), 'recreated\n'); await pending(); assert.ok(names().includes('a.ts'));
  });
  it('accepts a rename as one change and uses its new path for later edits', async () => {
    await pending(); await accept('a.ts');
    await fs.rename(path.join(root, 'a.ts'), path.join(root, 'renamed.ts'));
    await pending(); assert.ok(names().includes('renamed.ts'));
    await accept('renamed.ts'); assert.deepEqual(names(), ['b.ts', 'c.ts']);
    await fs.appendFile(path.join(root, 'renamed.ts'), 'later edit\n');
    const context = await files.capture('unreviewed');
    assert.equal(await git(['show', `${context?.before}:renamed.ts`]), 'first change\n');
  });
  it('detects and accepts a file-mode-only change', async () => {
    await pending(); await accept('a.ts'); await fs.chmod(path.join(root, 'a.ts'), 0o755);
    await pending(); assert.ok(names().includes('a.ts')); await accept('a.ts');
    assert.deepEqual(names(), ['b.ts', 'c.ts']);
  });
  it('starts from a new review base without losing the prior base’s checkpoint', async () => {
    await pending(); await accept('a.ts'); const originalBase = base;
    await git(['commit', '--allow-empty', '-qm', 'another base']); base = (await git(['rev-parse', 'HEAD'])).trim();
    await pending(); assert.ok(names().includes('a.ts'));
    base = originalBase; await pending(); assert.deepEqual(names(), ['b.ts', 'c.ts']);
  });
  it('isolates linked worktrees even though they share Git objects and refs', async () => {
    await pending(); await accept('a.ts'); const originalRoot = root;
    const linked = path.join(root, '..', path.basename(root) + '-linked');
    try {
      await git(['worktree', 'add', '--detach', linked, base]);
      await fs.writeFile(path.join(linked, 'a.ts'), 'first change\n');
      root = linked; await pending(); assert.deepEqual(names(), ['a.ts']);
    } finally { root = originalRoot; await git(['worktree', 'remove', '--force', linked]); }
    await pending(); assert.deepEqual(names(), ['b.ts', 'c.ts']);
  });
  it('never overwrites another window’s acceptance with an older baseline', async () => {
    const queue = new ReviewCheckpoint();
    const one = await queue.compare(root, base), two = await queue.compare(root, base);
    await queue.accept(one, one.files.find((f) => f.path === 'a.ts')!);
    await assert.rejects(queue.accept(two, two.files.find((f) => f.path === 'b.ts')!));
    await pending(); assert.deepEqual(names(), ['b.ts', 'c.ts']);
  });
  it('does not commit acceptance if retaining the validated snapshot fails', async () => {
    const queue = new ReviewCheckpoint(), comparison = await queue.compare(root, base);
    const lock = path.join(root, '.git', comparison.ref + '-current.lock');
    await fs.writeFile(lock, 'test lock');
    try {
      await assert.rejects(queue.acceptMany(comparison, [comparison.files.find((file) => file.path === 'a.ts')!]));
      await assert.rejects(git(['rev-parse', '--verify', '--quiet', comparison.ref]), 'failed acceptance must leave its checkpoint unchanged');
    } finally { await fs.rm(lock, { force: true }); }
  });
  it('replays disjoint checkbox clicks from two windows without losing either acceptance', async () => {
    const other = makeFiles();
    try {
      await pending(); await other.refresh('unreviewed');
      const a = files.state.files.find((file) => file.path === 'a.ts')!.id;
      const b = other.state.files.find((file) => file.path === 'b.ts')!.id;
      assert.deepEqual(await Promise.all([files.mark(a, true), other.mark(b, true)]), [true, true]);
      await pending(); assert.deepEqual(names(), ['c.ts']);
    } finally { other.dispose(); }
  });
  it('bulk-accepts unusual filenames, binary bytes and executable modes without changing them', async () => {
    const odd = 'odd\tline\nname.ts';
    await fs.writeFile(path.join(root, odd), 'literal filename\n');
    await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 255, 4])); await fs.chmod(path.join(root, 'a.ts'), 0o755);
    await pending(); assert.equal(await files.markAll(), true);
    await pending(); assert.deepEqual(names(), []);
    assert.deepEqual(await fs.readFile(path.join(root, 'image.bin')), Buffer.from([0, 255, 4]));
    assert.equal(await fs.readFile(path.join(root, odd), 'utf8'), 'literal filename\n');
  });
  it('keeps an opened comparison readable after newer acceptances and Git pruning', async () => {
    const execute = vscode.commands.executeCommand; let after: vscode.Uri | undefined;
    Object.assign(vscode.commands, { executeCommand: async (_command: string, _left: vscode.Uri, right: vscode.Uri) => { after = right; } });
    try {
      await pending(); await files.open(files.state.files.find((f) => f.path === 'a.ts')!.id);
      const tree = new URLSearchParams(after!.query).get('tree'); assert.ok(tree);
      for (const name of ['a.ts', 'b.ts', 'c.ts']) await accept(name);
      await fs.writeFile(path.join(root, 'a.ts'), 'newer accepted version\n'); await pending(); await accept('a.ts');
      await git(['gc', '--prune=now']);
      assert.equal(await git(['show', `${tree}:a.ts`]), 'first change\n');
    } finally { Object.assign(vscode.commands, { executeCommand: execute }); }
  });
  it('advances past the accepted row instead of jumping back to the first file', async () => {
    const execute = vscode.commands.executeCommand;
    Object.assign(vscode.commands, { executeCommand: async () => {} });
    try {
      await pending(); await files.open(files.state.files.find((f) => f.path === 'b.ts')!.id);
      await accept('b.ts'); await files.nextUnreviewed();
      assert.equal(files.state.selectedId, files.state.files.find((f) => f.path === 'c.ts')!.id);
    } finally { Object.assign(vscode.commands, { executeCommand: execute }); }
  });
});
