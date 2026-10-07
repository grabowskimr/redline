import * as vscode from 'vscode';

export const EMPTY_SIDE_SCHEME = 'redline-empty';
export function emptySide(uri: vscode.Uri, note?: string): vscode.Uri {
  return uri.with({ scheme: EMPTY_SIDE_SCHEME, path: note ? `${uri.path} (${note})` : uri.path, query: '', fragment: '' });
}
export function registerEmptySideProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(EMPTY_SIDE_SCHEME, { provideTextDocumentContent: () => '' });
}
