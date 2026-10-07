import * as vscode from 'vscode';
import { locationForUri } from '../viewer/workingLocation';
import { createAnchor, resolveAnchor } from '../anchor/anchorService';

/** Saved comparisons stay immutable; this action opens their editable workspace counterpart. */
export async function openWorkingFile(requested?: vscode.Uri): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const input = vscode.window.tabGroups?.activeTabGroup.activeTab?.input as
    { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
  const original = input?.original,
    modified = input?.modified;
  const source = requested ?? editor?.document.uri ?? modified;
  if (!source) return;
  const inDiff =
    original instanceof vscode.Uri &&
    modified instanceof vscode.Uri &&
    [original, modified].some((uri) => uri.toString() === source.toString());
  // The old path may no longer exist after a rename. An empty modified side denotes
  // a deletion, in which case the original side still identifies the working path.
  const destination = inDiff
    ? (locationForUri(modified!) ?? locationForUri(original!))
    : locationForUri(source);
  const uri = destination?.fileUri;
  if (!uri || uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) {
    void vscode.window.showInformationMessage(
      'Redline: this comparison has no working file in the current workspace.',
    );
    return;
  }
  const live = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) throw new Error('Not a file');
  } catch {
    // A dirty buffer can outlive deletion on disk. Opening it must not discard it.
    if (!live?.isDirty) {
      void vscode.window.showInformationMessage(
        'Redline: this working file no longer exists or cannot be accessed. Its saved comparison is still available.',
      );
      return;
    }
  }
  let selection: vscode.Range | undefined;
  const selectedUri = editor?.document.uri.toString();
  const followsSelection =
    selectedUri === source.toString() ||
    (inDiff && [original, modified].some((side) => side?.toString() === selectedUri)) ||
    (editor && locationForUri(editor.document.uri)?.fileUri.toString() === uri.toString());
  if (editor && followsSelection) {
    try {
      const doc = live ?? (await vscode.workspace.openTextDocument(uri));
      const { start, end } = editor.selection;
      const before = editor.document.getText(),
        after = doc.getText();
      // Bound navigation work for very large files; opening them still uses VS Code's
      // native editor. Prefer the live buffer, including edits that have not been saved.
      const anchor =
        before.length <= 1_000_000 && after.length <= 1_000_000
          ? resolveAnchor(
              after,
              createAnchor(before, {
                startLine: start.line,
                startChar: start.character,
                endLine: end.line,
                endChar: end.character,
              }),
            )
          : undefined;
      const position = (line: number, character: number): vscode.Position => {
        line = Math.max(0, Math.min(line, doc.lineCount - 1));
        return new vscode.Position(line, Math.min(character, doc.lineAt(line).text.length));
      };
      selection = new vscode.Range(
        position(anchor?.range.startLine ?? start.line, start.character),
        position(anchor?.range.endLine ?? end.line, end.character),
      );
    } catch {
      /* A binary/custom-editor resource still opens through vscode.open. */
    }
  }
  await vscode.commands.executeCommand('vscode.open', uri, {
    preview: false,
    ...(selection ? { selection } : {}),
  });
}

/** A stale tree-row argument must never fall back to the active editor. */
export function openWorkingFileAction(files: {
  workingFile(id: string): vscode.Uri | undefined;
}): (value?: unknown) => Promise<void> {
  return async (value) => {
    const id =
      typeof value === 'string'
        ? value
        : (value as { file?: { id?: string } } | undefined)?.file?.id;
    if (id !== undefined) {
      const uri = files.workingFile(id);
      if (uri) await openWorkingFile(uri);
      return;
    }
    await openWorkingFile(value instanceof vscode.Uri ? value : undefined);
  };
}
