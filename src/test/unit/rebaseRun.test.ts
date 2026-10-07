import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { readRunTrees } from '../../claude/runTrees';
import { stateDirectory } from '../../claude/statePaths';
import { snapshotWorkingTree, treeChanges } from '../../git/snapshotTree';
import { adjustForRebases, captureRebaseCursor } from '../../../plugin/hooks/rebase.cjs';

const exec = promisify(execFile);
const script = path.resolve(__dirname, '../../../plugin/hooks/redline-touched.mjs');

describe('Last run across a real Git rebase', function () {
  this.timeout(15_000);
  let repo: string, home: string;
  const git = async (args: string[], extra?: Record<string, string>): Promise<string> =>
    (await exec('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra } })).stdout.trim();
  const write = (file: string, text: string | Buffer): Promise<void> => fs.writeFile(path.join(repo, file), text);
  const text = (changes: Record<number, string> = {}): string => Array.from({ length: 18 }, (_, i) => changes[i] ?? `line ${i}`).join('\n') + '\n';
  const hook = async (event: string, tool?: string): Promise<void> => {
    const child = execFile(process.execPath, [script], { env: { ...process.env, HOME: home } });
    child.stdin?.end(JSON.stringify({ cwd: repo, session_id: 's', hook_event_name: event, tool_name: tool,
      tool_input: tool === 'Edit' ? { file_path: path.join(repo, 'shared.rs') } : undefined }));
    let stderr = '';
    child.stderr?.on('data', (data) => { stderr += String(data); });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '', stderr);
  };
  const changes = async (): Promise<string[]> => {
    const trees = await readRunTrees(repo, home, 's');
    assert.ok(trees?.before && trees.after);
    assert.equal(trees.snapshotError, undefined);
    return [...(await treeChanges(trees.before.tree, trees.after.tree, git)).keys()];
  };
  beforeEach(async () => {
    (vscode as unknown as { resetStub(): void }).resetStub();
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-rebase-')));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-rebase-home-'));
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.invalid']);
    await write('shared.rs', text());
    await git(['add', '-A']); await git(['commit', '-qm', 'base']);
    await git(['checkout', '-qb', 'feature']);
    await write('feature.rs', 'existing feature\n');
    await git(['add', '-A']); await git(['commit', '-qm', 'feature']);
    await git(['checkout', '-q', 'main']);
    await write('upstream.rs', 'incoming upstream file\n');
    await write('shared.rs', text({ 0: 'upstream' }));
    await git(['add', '-A']); await git(['commit', '-qm', 'upstream']);
    await git(['checkout', '-q', 'feature']);
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it('excludes upstream files and hunks while preserving dirty work and new edits', async () => {
    await write('shared.rs', text({ 17: 'earlier unreviewed change' }));
    await hook('UserPromptSubmit');
    await write('shared.rs', text({ 8: 'Claude edit', 17: 'earlier unreviewed change' }));
    await hook('PostToolUse', 'Edit');
    await write('agent.bin', Buffer.from([0, 1, 255]));
    await git(['rebase', '--autostash', 'main']);
    const index = await fs.readFile(path.join(repo, '.git/index'));
    await hook('Stop');
    assert.deepEqual(await changes(), ['agent.bin', 'shared.rs']);
    const trees = (await readRunTrees(repo, home, 's'))!;
    const diff = await git(['diff-tree', '-p', trees.before!.tree, trees.after!.tree, '--', 'shared.rs']);
    assert.match(diff, /\+Claude edit/);
    assert.doesNotMatch(diff, /\+upstream|\+earlier unreviewed/);
    assert.deepEqual(await fs.readFile(path.join(repo, '.git/index')), index, 'normalization never changes the real index');
    await git(['gc', '--prune=now']);
    assert.deepEqual(await changes(), ['agent.bin', 'shared.rs']);
  });

  it('keeps the previous code-changing run after a rebase-only request', async () => {
    await hook('UserPromptSubmit');
    await write('shared.rs', text({ 8: 'previous Claude edit' }));
    await hook('Stop');
    const previous = await readRunTrees(repo, home, 's');
    await hook('UserPromptSubmit'); await hook('PreToolUse', 'Bash');
    await git(['rebase', '--autostash', 'main']);
    await hook('PostToolUse', 'Bash'); await hook('Stop');
    assert.equal((await readRunTrees(repo, home, 's'))?.before?.id, previous?.before?.id);
    assert.deepEqual(await changes(), ['shared.rs']);
  });

  it('keeps agent commits made before the rebase in the run', async () => {
    await hook('UserPromptSubmit');
    await write('agent.rs', 'Claude committed this\n');
    await git(['add', '-A']); await git(['commit', '-qm', 'agent commit']);
    await git(['rebase', 'main']);
    await hook('Stop');
    assert.deepEqual(await changes(), ['agent.rs']);
  });

  it('does not change a completed run when a later rebase rewrites the worktree', async () => {
    await hook('UserPromptSubmit');
    await write('shared.rs', text({ 8: 'Claude edit' }));
    await hook('Stop');
    const before = await readRunTrees(repo, home, 's');
    await git(['rebase', '--autostash', 'main']);
    const after = await readRunTrees(repo, home, 's');
    assert.deepEqual(after?.before, before?.before);
    assert.deepEqual(after?.after, before?.after);
    assert.deepEqual(await changes(), ['shared.rs']);
  });

  it('repairs a saved comparison written by the older hook during a rebase', async () => {
    const before = await snapshotWorkingTree(repo, git);
    const at = new Date(Date.now() - 2_000).toISOString();
    await write('agent.rs', 'Claude edit\n');
    await git(['rebase', '--autostash', 'main']);
    const after = await snapshotWorkingTree(repo, git);
    const state = { before: { id: 'legacy', at, tree: before, session: 's' },
      after: { id: 'legacy', at: new Date(Date.now() + 2_000).toISOString(), tree: after, session: 's' } };
    const dir = stateDirectory(repo, home); await fs.mkdir(dir, { recursive: true });
    // Legacy v2 is intentionally still supported by the extension's reader.
    await fs.writeFile(path.join(dir, 'runs.json'), JSON.stringify(state));
    await fs.writeFile(path.join(dir, 'stopped.json'), JSON.stringify(state.after));
    assert.deepEqual(await changes(), ['agent.rs']);
  });

  it('excludes a fast-forward pull through a rebase alias', async () => {
    await git(['reset', '--hard', await git(['merge-base', 'main', 'feature'])]);
    await hook('UserPromptSubmit');
    await write('agent.rs', 'Claude edit\n');
    await git(['config', 'alias.pram', 'pull --rebase --autostash . main']);
    await git(['pram']);
    await hook('Stop');
    assert.deepEqual(await changes(), ['agent.rs']);
  });

  it('uses the linked worktree reflog rather than another worktree’s HEAD', async () => {
    const original = repo, linked = path.join(home, 'linked');
    await git(['worktree', 'add', '-qb', 'linked', linked, 'feature']);
    try {
      repo = linked;
      await hook('UserPromptSubmit');
      await write('agent.rs', 'Claude edit\n');
      await git(['rebase', '--autostash', 'main']);
      await hook('Stop');
      assert.deepEqual(await changes(), ['agent.rs']);
    } finally { repo = original; await git(['worktree', 'remove', '--force', linked]); }
  });

  it('does not publish rebase work as agent changes while the run is still active', async () => {
    await hook('UserPromptSubmit');
    await write('shared.rs', text({ 8: 'Claude edit' }));
    await hook('PostToolUse', 'Edit');
    await git(['rebase', '--autostash', 'main']);
    const active = await readRunTrees(repo, home, 's');
    assert.ok(active?.pending);
    assert.equal(active.before, undefined);
    assert.equal(active.after, undefined);
    await hook('Stop');
    assert.deepEqual(await changes(), ['shared.rs']);
  });

  it('reports an unfinished rebase instead of comparing conflict markers as Claude edits', async () => {
    await hook('UserPromptSubmit');
    await write('shared.rs', text({ 0: 'agent commit conflicts' }));
    await git(['add', '-A']); await git(['commit', '-qm', 'conflicting agent commit']);
    await assert.rejects(git(['rebase', 'main']));
    await hook('Stop');
    assert.match((await readRunTrees(repo, home, 's'))?.snapshotError ?? '', /rebase.*progress/i);
    await git(['rebase', '--abort']);
  });

  it('does not silently drop earlier dirty edits when normalizing would conflict', async () => {
    await write('shared.rs', text({ 0: 'preexisting dirty edit' }));
    await hook('UserPromptSubmit');
    await git(['rebase', '--autostash', 'main']);
    await write('shared.rs', text({ 0: 'user resolved overlap' }));
    await hook('Stop');
    assert.match((await readRunTrees(repo, home, 's'))?.snapshotError ?? '', /Cannot separate the rebase/);
  });

  it('handles two rebases in the same run', async () => {
    await git(['checkout', '-qb', 'newer-main', 'main']);
    await write('more-upstream.rs', 'more incoming work\n');
    await git(['add', '-A']); await git(['commit', '-qm', 'more upstream']);
    await git(['checkout', '-q', 'feature']);
    await hook('UserPromptSubmit');
    await write('agent.rs', 'Claude edit\n');
    await git(['rebase', 'main']); await git(['rebase', 'newer-main']);
    await hook('Stop');
    assert.deepEqual(await changes(), ['agent.rs']);
  });

  it('does not interpret a commit subject mentioning rebase as a Git operation', async () => {
    await hook('UserPromptSubmit');
    await write('agent.rs', 'Claude edit\n');
    await git(['add', '-A']); await git(['commit', '-qm', 'rebase (finish): ordinary agent commit']);
    await hook('Stop');
    assert.deepEqual(await changes(), ['agent.rs']);
  });

  it('preserves a rename and an executable-bit edit through autostash', async () => {
    await hook('UserPromptSubmit');
    await fs.rename(path.join(repo, 'feature.rs'), path.join(repo, 'renamed.rs'));
    await fs.chmod(path.join(repo, 'shared.rs'), 0o755);
    await git(['add', '-A']);
    await git(['rebase', '--autostash', 'main']);
    await hook('Stop');
    const trees = (await readRunTrees(repo, home, 's'))!;
    assert.equal(trees.snapshotError, undefined);
    const actual = await treeChanges(trees.before!.tree, trees.after!.tree, git);
    assert.deepEqual(actual.get('renamed.rs'), { kind: 'renamed', from: 'feature.rs' });
    assert.deepEqual([...actual.keys()], ['renamed.rs', 'shared.rs']);
    assert.match(await git(['ls-tree', trees.after!.tree, 'shared.rs']), /^100755/);
  });

  it('supports Git versions whose merge-tree requires commit operands', async () => {
    await hook('UserPromptSubmit');
    const before = (await readRunTrees(repo, home, 's'))!.pending!;
    await write('agent.rs', 'Claude edit\n');
    await git(['rebase', 'main']);
    const after = (await snapshotWorkingTree(repo, git))!;
    const adjusted = await adjustForRebases(repo, before,
      { at: new Date().toISOString(), rebaseCursor: await captureRebaseCursor(repo) }, async (args) => {
        if (args[0] === 'merge-tree') {
          // The Git 2.40 interface takes commits; later versions also accept bare trees.
          for (const ref of args.slice(-2)) assert.equal(await git(['cat-file', '-t', ref]), 'commit');
        }
        return git(args);
      });
    assert.deepEqual([...(await treeChanges(adjusted.tree, after, git)).keys()], ['agent.rs']);
  });

  it('requires workspace trust before repairing an older comparison with Git', async () => {
    const before = await snapshotWorkingTree(repo, git);
    const at = new Date(Date.now() - 2_000).toISOString();
    await write('agent.rs', 'Claude edit\n'); await git(['rebase', 'main']);
    const after = { id: 'old', at: new Date(Date.now() + 2_000).toISOString(), tree: await snapshotWorkingTree(repo, git), session: 's' };
    const dir = stateDirectory(repo, home); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'runs.json'), JSON.stringify({ before: { id: 'old', at, tree: before, session: 's' } }));
    await fs.writeFile(path.join(dir, 'stopped.json'), JSON.stringify(after));
    const stub = vscode as unknown as { state: { trusted: boolean } };
    stub.state.trusted = false;
    try {
      const result = await readRunTrees(repo, home, 's');
      assert.equal(result?.before?.tree, before, 'no normalized objects are generated before trust');
      assert.match(result?.snapshotError ?? '', /trust/i);
    } finally { stub.state.trusted = true; }
    assert.deepEqual(await changes(), ['agent.rs']);
  });
});
