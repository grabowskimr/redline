import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { RedlineAPI } from '../../../extension';
import type { ChangeNode } from '../../../viewer/changesView';

const exec = promisify(execFile);
const waitFor = async (test: () => boolean, message: string) => {
  const end = Date.now() + 15000;
  while (!test()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise((done) => setTimeout(done, 50));
  }
};

describe('Redline in VS Code', function () {
  this.timeout(30000);
  let api: RedlineAPI, root: string, extension: vscode.Extension<RedlineAPI>;
  const hook = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const child = execFile(
        'node',
        [path.join(extension.extensionPath, 'plugin/hooks/redline-touched.mjs')],
        {
          env: { ...process.env, HOME: process.env.REDLINE_TEST_HOME! },
          timeout: 15000,
        },
        (error, _stdout, stderr) =>
          error || stderr ? reject(error ?? new Error(stderr)) : resolve(),
      );
      child.stdin?.end(
        JSON.stringify({ cwd: root, session_id: 'integration-session', hook_event_name: event }),
      );
    });
  const allNodes = (nodes: ChangeNode[]): ChangeNode[] =>
    nodes.flatMap((n) => [n, ...allNodes(n.children ?? [])]);
  before(async () => {
    root = await fs.realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: root });
    await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    await fs.mkdir(path.join(root, 'native/deep'), { recursive: true });
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      await fs.writeFile(path.join(root, 'native/deep', name), 'const value = 1;\n');
    }
    await exec('git', ['add', '-A'], { cwd: root });
    await exec('git', ['commit', '-qm', 'base'], { cwd: root });
    extension = vscode.extensions.getExtension<RedlineAPI>('grabowskmr.redline-for-claude-code')!;
    assert.ok(extension);
    api = await extension.activate();
    await api.ready;
    api.range.invalidate();
    await api.range.summary();
    await hook('UserPromptSubmit');
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      await fs.writeFile(path.join(root, 'native/deep', name), 'const value = 2;\n');
    }
    await hook('Stop');
    api.range.selectRepository(root, 'integration-session');
    await vscode.commands.executeCommand('redline.reviewChanges');
    await waitFor(() => api.files.state.files.length === 3, 'Last run did not load');
  });
  it('activates only the viewer commands and native tree', async () => {
    const commands = (await vscode.commands.getCommands(true)).filter((c) =>
      c.startsWith('redline.'),
    );
    assert.ok(commands.includes('redline.reviewUnreviewed'));
    assert.ok(!commands.includes('redline.submit'));
    assert.ok(!commands.includes('redline.addNoteHere'));
    assert.equal(api.view.tree.visible, true);
    assert.match(api.view.tree.title ?? '', /Last run/);
  });
  it('opens the viewer after moving it to another container and back', async () => {
    for (const destinationId of ['workbench.view.explorer', 'workbench.view.extension.redline']) {
      await vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: ['redline.changes'],
        destinationId,
      });
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('redline.changes.focus'),
        `Missing focus command after moving to ${destinationId}`,
      );
      await vscode.commands.executeCommand('redline.focusPanel');
      assert.equal(api.view.tree.visible, true);
    }
  });
  it('uses native theme icons and leaves Last run acceptance out of the tree', () => {
    const node = allNodes(api.view.getChildren()).find((n) => n.file)!;
    const item = api.view.getTreeItem(node);
    assert.equal(item.resourceUri?.scheme, 'file');
    assert.equal((item.iconPath as vscode.ThemeIcon).id, 'file');
    assert.equal(item.checkboxState, undefined);
    assert.equal(item.command?.command, 'redline.openReviewFile');
  });
  it('opens immutable diff sides and highlights the file without refreshing the list', async () => {
    const id = api.files.state.files[0]!.id;
    const started = performance.now();
    await vscode.commands.executeCommand('redline.openReviewFile', id);
    await waitFor(
      () =>
        vscode.window.tabGroups.all.some((g) =>
          g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff),
        ),
      'Diff did not open',
    );
    const tab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputTextDiff)!;
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal(input.original.scheme, 'redline-tree');
    assert.equal(input.modified.scheme, 'redline-tree');
    assert.equal(
      (await vscode.workspace.openTextDocument(input.modified)).getText(),
      'const value = 2;\n',
    );
    await waitFor(
      () => api.view.tree.selection[0]?.file?.id === id,
      'Native tree did not select the opened file',
    );
    console.log(`Native diff open: ${Math.round(performance.now() - started)} ms`);
  });
  it('opens the real editable working file from the tree action', async () => {
    const row = api.files.state.files[0]!;
    await vscode.commands.executeCommand('redline.openWorkingFile', row.id);
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.scheme === 'file',
      'Working file did not open',
    );
    assert.equal(
      await fs.realpath(vscode.window.activeTextEditor!.document.uri.fsPath),
      path.join(root, row.path),
    );
    assert.equal(vscode.window.activeTextEditor?.document.isDirty, false);
  });
  it('keeps earlier unreviewed files after another prompt changes only one file', async () => {
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'native/deep/a.ts'), 'const value = 3;\n');
    await hook('Stop');
    await waitFor(
      () => api.files.state.scope === 'recent' && api.files.state.files.length === 1,
      'Run watcher did not update Last run',
    );
    assert.equal(api.files.state.files[0]?.path, 'native/deep/a.ts');
    await vscode.commands.executeCommand('redline.reviewUnreviewed');
    assert.equal(api.files.state.files.length, 3);
    const node = allNodes(api.view.getChildren()).find((n) => n.file)!;
    assert.ok(api.view.getTreeItem(node).checkboxState !== undefined);
  });
  it('accepts rapid checkbox operations and advances only the selected files', async () => {
    const [a, b] = api.files.state.files;
    const first = api.files.mark(a!.id, true),
      second = api.files.mark(b!.id, true);
    assert.equal(api.files.state.pendingIds?.length, 2);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(
      api.files.state.files.map((f) => f.path),
      ['native/deep/c.ts'],
    );
    await vscode.commands.executeCommand('redline.markAllReviewed');
    assert.equal(api.files.state.files.length, 0);
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'native/deep/a.ts'), 'const value = 4;\n');
    await hook('Stop');
    await waitFor(
      () => api.files.state.files.length === 1,
      'New edits did not reopen the accepted file',
    );
    const context = await api.files.capture('unreviewed');
    assert.ok(context?.before);
    const text = await exec('git', ['show', `${context.before}:native/deep/a.ts`], { cwd: root });
    assert.equal(
      text.stdout,
      'const value = 3;\n',
      'Baseline must be the accepted version, not the branch base',
    );
  });
  it('refreshes Unreviewed after external edits without another Claude event', async () => {
    await fs.writeFile(path.join(root, 'native/deep/c.ts'), 'const value = 9;\n');
    await waitFor(
      () => api.files.state.files.some((f) => f.path === 'native/deep/c.ts'),
      'External file edit did not refresh Unreviewed',
    );
  });
  it('never falls back to another session’s last run', async () => {
    api.range.selectRepository(root, 'missing-session');
    await api.view.refresh('recent');
    assert.equal(api.files.state.files.length, 0);
    assert.match(api.files.state.error ?? '', /No completed run/);
    api.range.selectRepository(root, 'integration-session');
    await api.view.refresh('recent');
    assert.equal(api.files.state.files.length, 1);
  });
  it('opens an empty Changes view and preserves the active scope from the status-bar command', async () => {
    api.range.selectRepository(root, 'missing-session');
    await vscode.commands.executeCommand('redline.reviewChanges');
    assert.equal(api.files.state.files.length, 0);
    assert.equal(api.view.tree.visible, true);
    api.range.selectRepository(root, 'integration-session');
    await vscode.commands.executeCommand('redline.reviewUnreviewed');
    await vscode.commands.executeCommand('redline.focusPanel');
    assert.equal(api.files.state.scope, 'unreviewed');
    assert.equal(api.view.tree.visible, true);
  });
});
