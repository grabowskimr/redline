import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
interface WorkingLocation {
  fileUri: vscode.Uri;
  path: string;
  workspaceFolder?: string;
  side?: 'base';
}

/** Resolve an owned saved diff to its current workspace path. */
export function locationForUri(uri: vscode.Uri): WorkingLocation | undefined {
  let fileUri = uri;
  let side: 'base' | undefined;
  let history: { tree: string; root: string; treePath: string } | undefined;
  if (uri.scheme === 'redline-tree') {
    const params = new URLSearchParams(uri.query),
      tree = params.get('tree'),
      root = params.get('root');
    const rel = uri.path.replace(/^\//, '');
    if (
      !tree ||
      !/^[a-f0-9]{40,64}$/.test(tree) ||
      !root ||
      !rel ||
      rel.split('/').includes('..') ||
      rel.includes('\0')
    ) {
      return undefined;
    }
    fileUri = vscode.Uri.file(path.join(root, rel));
    history = { tree, root, treePath: rel };
  } else if (uri.scheme === 'git') {
    try {
      const q = JSON.parse(uri.query) as { path?: string; ref?: string };
      if (typeof q.path === 'string') {
        fileUri = vscode.Uri.file(q.path);
        // An empty ref ("") is the index/working-tree side; anything else is the base.
        if (q.ref !== undefined && q.ref !== '' && q.ref !== '~') side = 'base';
      }
    } catch {
      return undefined;
    }
  } else if (uri.scheme !== 'file' && uri.scheme !== 'vscode-vfs') {
    return undefined;
  }
  // Snapshot roots are canonical, while VS Code may have opened a symlink spelling.
  // Map back through an owned workspace folder without resolving the historical file:
  // deleted files must remain reviewable too.
  if (!vscode.workspace.getWorkspaceFolder(fileUri)) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const relative = path.relative(realpathSync(folder.uri.fsPath), fileUri.fsPath);
        if (
          relative === '..' ||
          relative.startsWith('..' + path.sep) ||
          path.isAbsolute(relative)
        ) {
          continue;
        }
        fileUri = vscode.Uri.joinPath(folder.uri, ...relative.split(path.sep));
        break;
      } catch {
        /* an unavailable folder cannot own this document */
      }
    }
  }
  if (!vscode.workspace.getWorkspaceFolder(fileUri)) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  let rel: string;
  if (folder) {
    rel = path.posix.normalize(
      vscode.workspace.asRelativePath(fileUri, false).split(path.sep).join(path.posix.sep),
    );
  } else {
    rel = fileUri.path;
  }
  const loc: WorkingLocation = { path: rel, fileUri, ...history };
  if (folder) loc.workspaceFolder = folder.name;
  if (side) loc.side = side;
  return loc;
}
