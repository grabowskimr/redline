import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { registerTreeSideProvider, treeSide } from '../../git/treeSide';

const exec = promisify(execFile);
describe('saved comparison file contents', () => {
  let root: string, tree: string, dispose: vscode.Disposable;
  let read: (uri: vscode.Uri) => Promise<Uint8Array | string>;
  const originalText = vscode.workspace.registerTextDocumentContentProvider;
  const originalFs = vscode.workspace.registerFileSystemProvider;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-blob-'));
    await exec('git', ['init', '-q'], { cwd: root });
    await fs.writeFile(path.join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 0, 255, 128, 3]));
    await exec('git', ['add', '-A'], { cwd: root });
    tree = (await exec('git', ['write-tree'], { cwd: root })).stdout.trim();
    vscode.workspace.registerTextDocumentContentProvider = (_scheme, provider) => {
      read = async (uri) => await provider.provideTextDocumentContent(uri, {} as never) ?? '';
      return { dispose() {} };
    };
    vscode.workspace.registerFileSystemProvider = (_scheme, provider) => {
      read = async (uri) => await provider.readFile(uri);
      return { dispose() {} };
    };
    dispose = registerTreeSideProvider((cwd) => async (args) => (await exec('git', args, { cwd })).stdout, async () => root);
  });
  afterEach(async () => {
    dispose.dispose();
    vscode.workspace.registerTextDocumentContentProvider = originalText;
    vscode.workspace.registerFileSystemProvider = originalFs;
    await fs.rm(root, { recursive: true, force: true });
  });
  it('reads the same trusted repository through a filesystem alias', async () => {
    const alias = root + '-alias';
    try {
      await fs.symlink(root, alias, 'dir');
      assert.deepEqual(Buffer.from(await read(treeSide(alias, tree, 'image.png'))), Buffer.from([137, 80, 78, 71, 0, 255, 128, 3]));
    } finally { await fs.rm(alias, { force: true }); }
  });
  it('rejects a different repository even when it contains the same object', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-untrusted-'));
    try { await assert.rejects(read(treeSide(other, tree, 'image.png')), /does not belong/); }
    finally { await fs.rm(other, { recursive: true, force: true }); }
  });
  it('preserves arbitrary binary bytes instead of decoding them as UTF-8', async () => {
    const bytes = await read(treeSide(root, tree, 'image.png'));
    assert.deepEqual(Buffer.from(bytes), Buffer.from([137, 80, 78, 71, 0, 255, 128, 3]));
  });
  it('reports an unavailable object instead of presenting an empty file', async () => {
    await assert.rejects(read(treeSide(root, 'a'.repeat(40), 'image.png')));
  });
});
