import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openWorkingFileAction } from '../../commands/openWorkingFile';
import { treeSide } from '../../git/treeSide';

describe('opening the editable file from a saved review', () => {
  const stub = vscode as unknown as { resetStub(): void; state: { folders: unknown[] }; shown: { messages: string[] } };
  const originalOpen = vscode.workspace.openTextDocument, originalExecute = vscode.commands.executeCommand;
  let root: string, uri: vscode.Uri, calls: unknown[][];
  beforeEach(async () => {
    stub.resetStub(); root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-edit-review-'));
    uri = vscode.Uri.file(path.join(root, 'new.ts')); calls = [];
    stub.state.folders = [{ uri: vscode.Uri.file(root) }];
    await fs.writeFile(uri.fsPath, 'first\ntarget\nlast\n');
    Object.assign(vscode.commands, { executeCommand: async (...args: unknown[]) => { calls.push(args); } });
  });
  afterEach(async () => {
    Object.assign(vscode.workspace, { openTextDocument: originalOpen, textDocuments: [] });
    Object.assign(vscode.commands, { executeCommand: originalExecute });
    Object.assign(vscode.window, { activeTextEditor: undefined, tabGroups: undefined });
    await fs.rm(root, { recursive: true, force: true });
  });
  function command() {
    return openWorkingFileAction({ workingFile: id => id === 'current-row' ? uri : undefined });
  }
  it('maps canonical file rows back into a workspace opened through a symlink', async () => {
    const alias = root + '-alias';
    await fs.symlink(root, alias);
    uri = vscode.Uri.file(await fs.realpath(uri.fsPath));
    stub.state.folders = [{ uri: vscode.Uri.file(alias) }];
    try {
      await command()('current-row');
      assert.equal((calls[0]?.[1] as vscode.Uri | undefined)?.fsPath, path.join(alias, 'new.ts'));
    } finally { await fs.unlink(alias); }
  });
  it('opens the current row without changing or refreshing the saved comparison', async () => {
    await command()('current-row');
    assert.equal(calls[0]?.[0], 'vscode.open'); assert.equal((calls[0]?.[1] as vscode.Uri).toString(), uri.toString());
    assert.equal((calls[0]?.[2] as vscode.TextDocumentShowOptions).preview, false);
    assert.equal(await fs.readFile(uri.fsPath, 'utf8'), 'first\ntarget\nlast\n');
  });
  it('relocates the reviewed line into an already dirty working document without saving it', async () => {
    const snapshot = treeSide(root, 'a'.repeat(40), 'new.ts');
    const live = { uri, isDirty: true, getText: () => 'inserted\nfirst\ntarget\nlast\n', lineCount: 5,
      lineAt: (line: number) => ({ text: ['inserted', 'first', 'target', 'last', ''][line] }) };
    Object.assign(vscode.workspace, { textDocuments: [live], openTextDocument: async () => live });
    Object.assign(vscode.window, { activeTextEditor: { document: { uri: snapshot, getText: () => 'first\ntarget\nlast\n' }, selection: new vscode.Selection(1, 2, 1, 5) } });
    await command()(snapshot);
    const options = calls[0]?.[2] as vscode.TextDocumentShowOptions;
    assert.equal(options.selection?.start.line, 2); assert.equal(options.selection?.start.character, 2);
    assert.equal(options.selection?.end.character, 5);
    assert.equal(live.isDirty, true); assert.equal(await fs.readFile(uri.fsPath, 'utf8'), 'first\ntarget\nlast\n');
  });
  it('opens the renamed destination even when invoked on the original side', async () => {
    const original = treeSide(root, 'a'.repeat(40), 'old.ts'), modified = treeSide(root, 'b'.repeat(40), 'new.ts');
    Object.assign(vscode.window, { tabGroups: { activeTabGroup: { activeTab: { input: { original, modified } } } } });
    await command()(original);
    assert.equal((calls[0]?.[1] as vscode.Uri).toString(), uri.toString());
  });
  it('does not recreate a deleted file or open a different file for a stale row', async () => {
    const open = command(); await open('stale-row'); assert.equal(calls.length, 0);
    await fs.rm(uri.fsPath); await open(treeSide(root, 'a'.repeat(40), 'new.ts'));
    assert.equal(calls.length, 0); assert.ok(stub.shown.messages.some((m) => /no longer exists/.test(m)));
    await assert.rejects(fs.stat(uri.fsPath));
  });
  it('rejects snapshots from a different worktree instead of guessing the same filename', async () => {
    await command()(treeSide(root + '-other', 'a'.repeat(40), 'new.ts'));
    assert.equal(calls.length, 0);
  });
  it('chooses the correct root when two workspace folders contain the same filename', async () => {
    const other = path.join(root, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'new.ts'), 'other worktree');
    stub.state.folders = [{ uri: vscode.Uri.file(other) }, { uri: vscode.Uri.file(root) }];
    await command()(treeSide(other, 'a'.repeat(40), 'new.ts'));
    assert.equal((calls[0]?.[1] as vscode.Uri).fsPath, path.join(other, 'new.ts'));
  });
  it('opens a binary resource natively even when it cannot be decoded as text', async () => {
    await fs.writeFile(uri.fsPath, Buffer.from([0, 255, 128]));
    const snapshot = treeSide(root, 'a'.repeat(40), 'new.ts');
    Object.assign(vscode.window, { activeTextEditor: { document: { uri: snapshot }, selection: new vscode.Selection(0, 0, 0, 0) } });
    await command()(snapshot);
    assert.equal(calls[0]?.[0], 'vscode.open'); assert.equal((calls[0]?.[2] as vscode.TextDocumentShowOptions).selection, undefined);
  });
  it('preserves a dirty buffer when the underlying file was removed', async () => {
    Object.assign(vscode.workspace, { textDocuments: [{ uri, isDirty: true }] });
    await fs.rm(uri.fsPath); await command()('current-row');
    assert.equal((calls[0]?.[1] as vscode.Uri).toString(), uri.toString());
    await assert.rejects(fs.stat(uri.fsPath));
  });
});
