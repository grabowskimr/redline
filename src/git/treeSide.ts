import * as vscode from 'vscode';
import * as path from 'node:path';
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

/**
 * Serves those URIs, read-only.
 *
 * A path missing from the tree — a file the run created — is not an error: it correctly has
 * no content there, and the diff then reads as the whole file arriving. This is also why a
 * separate empty scheme is no longer needed for the left side of an addition.
 */
export function registerTreeSideProvider(runFor: (root: string) => GitRunner): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(TREE_SIDE_SCHEME, {
    provideTextDocumentContent: async (uri) => {
      const params = new URLSearchParams(uri.query);
      const tree = params.get('tree');
      const root = params.get('root');
      if (!tree || !root) return '';
      const rel = uri.path.replace(/^\//, '');
      try {
        return await runFor(root)(['show', `${tree}:${rel}`]);
      } catch {
        return ''; // absent from that tree, or the object has since been pruned
      }
    },
  });
}
