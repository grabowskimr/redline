import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitRunner, TREE_SIDE_SCHEME } from './snapshotTree';

/**
 * A file as it was in a snapshot, as a URI the diff editor can open.
 *
 * The path is kept in the URI's path so the editor's title shows the real file name, and the
 * tree and repository ride along in the query.
 */
export function treeSide(root: string, tree: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: TREE_SIDE_SCHEME,
    path: '/' + relPath.split(path.sep).join('/'),
    query: `tree=${tree}&root=${encodeURIComponent(root)}`,
  });
}

/** Immutable, read-only blobs. Keep bytes intact so native binary editors also work. */
export function registerTreeSideProvider(
  _runFor: (root: string) => GitRunner,
  knownRoot: (candidate?: string) => Promise<string | undefined>,
): vscode.Disposable {
  const exec = promisify(execFile);
  const changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const cache = new Map<string, Buffer>();
  let cacheBytes = 0;
  const readFile = async (uri: vscode.Uri): Promise<Uint8Array> => {
    const params = new URLSearchParams(uri.query);
    const tree = params.get('tree');
    const root = params.get('root');
    const rel = uri.path.replace(/^\//, '');
    const expected = await knownRoot(root ?? undefined);
    const canonical = async (candidate: string | undefined) => candidate ? realpath(candidate).catch(() => undefined) : undefined;
    const [actualRoot, expectedRoot] = await Promise.all([canonical(root ?? undefined), canonical(expected)]);
    if (!tree || !/^[a-f0-9]{40,64}$/.test(tree) || !root || !expected ||
        !actualRoot || actualRoot !== expectedRoot || !rel ||
        rel.split('/').includes('..') || rel.includes('\0')) {
      throw new Error('This saved comparison does not belong to the selected repository.');
    }
    const key = `${actualRoot}\0${tree}\0${rel}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let bytes: Buffer;
    try {
      bytes = (await exec('git', ['show', `${tree}:${rel}`], {
        cwd: actualRoot, encoding: 'buffer', timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
      })).stdout;
    } catch {
      throw new Error(`Saved comparison unavailable for ${rel}. Refresh the review or select another run.`);
    }
    const limit = 16 * 1024 * 1024;
    if (bytes.length <= limit) {
      while (cacheBytes + bytes.length > limit && cache.size) {
        const first = cache.keys().next().value!;
        cacheBytes -= cache.get(first)!.length;
        cache.delete(first);
      }
      cache.set(key, bytes);
      cacheBytes += bytes.length;
    }
    return bytes;
  };
  const readOnly = (): never => { throw new Error('Saved comparisons are read-only.'); };
  const provider = vscode.workspace.registerFileSystemProvider(TREE_SIDE_SCHEME, {
    onDidChangeFile: changes.event,
    watch: () => ({ dispose() {} }),
    stat: async (uri) => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: (await readFile(uri)).length }),
    readFile,
    readDirectory: readOnly,
    createDirectory: readOnly,
    writeFile: readOnly,
    delete: readOnly,
    rename: readOnly,
  }, { isReadonly: true, isCaseSensitive: true });
  return { dispose() { provider.dispose(); changes.dispose(); cache.clear(); cacheBytes = 0; } };
}
