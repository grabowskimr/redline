import * as vscode from 'vscode';
import * as path from 'node:path';

export interface NoteLocation {
  /** Workspace-folder-relative posix path (or absolute posix path when outside any folder). */
  path: string;
  workspaceFolder?: string;
  /** `base` for the left-hand side of a diff editor. */
  side?: 'base';
  /** The `file:` URI the note refers to (for opening / watching). */
  fileUri: vscode.Uri;
}

/**
 * Map any editor URI to the note's stored location. Handles `git:` URIs from the diff
 * editor by reading the `path` field from the query.
 */
export function locationForUri(uri: vscode.Uri): NoteLocation | undefined {
  let fileUri = uri;
  let side: 'base' | undefined;
  if (uri.scheme === 'git') {
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
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  let rel: string;
  if (folder) {
    rel = path.posix.normalize(
      vscode.workspace.asRelativePath(fileUri, false).split(path.sep).join(path.posix.sep),
    );
  } else {
    rel = fileUri.path;
  }
  const loc: NoteLocation = { path: rel, fileUri };
  if (folder) loc.workspaceFolder = folder.name;
  if (side) loc.side = side;
  return loc;
}

/** Rebuild a file URI from a stored note path + workspace folder name. */
export function uriForNote(notePath: string, workspaceFolder?: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolder !== undefined) {
    const folder = folders.find((f) => f.name === workspaceFolder);
    // The folder the note belongs to is not in this workspace any more: never guess
    // another root with the same relative path.
    return folder ? vscode.Uri.joinPath(folder.uri, ...notePath.split('/')) : undefined;
  }
  if (path.posix.isAbsolute(notePath)) return vscode.Uri.file(notePath);
  const folder = folders[0];
  return folder ? vscode.Uri.joinPath(folder.uri, ...notePath.split('/')) : undefined;
}

/** Stable key for "same file" comparisons. */
export function noteKey(notePath: string, workspaceFolder?: string): string {
  return `${workspaceFolder ?? ''}::${notePath}`;
}
