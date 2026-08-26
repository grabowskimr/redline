import * as vscode from 'vscode';
import { ReviewStore } from '../store/reviewStore';
import { locationForUri, noteKey } from '../comments/uriMapping';

/** Claude brand orange. */
const ORANGE = '#D97757';

// A 3px vertical bar rendered in the glyph margin — only on lines that carry a note.
const BAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" preserveAspectRatio="none"><rect x="0" y="0" width="3" height="16" rx="1" fill="${ORANGE}"/></svg>`;
/**
 * Shown while sweeping lines for a new note (gutter drag / whole-line selection): the same
 * solid bar as a real note, dimmed, so the range being picked reads as "not committed yet"
 * without resorting to dashes.
 */
const DRAG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" preserveAspectRatio="none"><rect x="0" y="0" width="3" height="16" rx="1" fill="${ORANGE}" opacity="0.65"/></svg>`;

/**
 * Marks the exact lines of each note with an orange bar next to the line numbers.
 * This is the only editor decoration the extension draws.
 */
export class NoteDecorations implements vscode.Disposable {
  private readonly type: vscode.TextEditorDecorationType;
  private readonly dragType: vscode.TextEditorDecorationType;
  private readonly subs: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly store: ReviewStore) {
    this.type = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(BAR_SVG).toString('base64')}`),
      gutterIconSize: 'cover',
      overviewRulerColor: ORANGE,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    this.dragType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(DRAG_SVG).toString('base64')}`),
      gutterIconSize: 'cover',
      overviewRulerColor: ORANGE,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    this.subs.push(
      this.type,
      this.dragType,
      store.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
    );
    this.apply();
  }

  /**
   * While whole lines are selected, mark them with a dimmed bar: that is the range a note
   * would cover. Ordinary text selections (mid-line columns) never trigger it.
   */
  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const ed = e.textEditor;
    // The marker belongs to the editor being worked in; clear any leftovers elsewhere.
    for (const other of vscode.window.visibleTextEditors) {
      if (other !== ed) other.setDecorations(this.dragType, []);
    }
    const sel = e.selections[0];
    const isLineSweep =
      e.selections.length === 1 &&
      !!sel &&
      !sel.isEmpty &&
      !sel.isSingleLine &&
      sel.start.character === 0 &&
      (sel.end.character === 0 || sel.end.character >= ed.document.lineAt(sel.end.line).text.length);
    if (!isLineSweep || !sel) {
      ed.setDecorations(this.dragType, []);
      return;
    }
    const endLine = sel.end.character === 0 ? sel.end.line - 1 : sel.end.line;
    const ranges: vscode.Range[] = [];
    for (let line = sel.start.line; line <= endLine; line++) ranges.push(new vscode.Range(line, 0, line, 0));
    ed.setDecorations(this.dragType, ranges);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.apply();
    }, 100);
  }

  private apply(): void {
    // A note was created or changed, so any pending-range marker has served its purpose.
    for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(this.dragType, []);
    for (const ed of vscode.window.visibleTextEditors) {
      const loc = locationForUri(ed.document.uri);
      if (!loc || loc.side === 'base') {
        ed.setDecorations(this.type, []);
        continue;
      }
      const key = noteKey(loc.path, loc.workspaceFolder);
      const ranges: vscode.Range[] = [];
      const max = Math.max(ed.document.lineCount - 1, 0);
      for (const n of this.store.notes) {
        if (noteKey(n.path, n.workspaceFolder) !== key) continue;
        if (n.anchor.orphaned || n.done) continue;
        for (let line = n.range.startLine; line <= Math.min(n.range.endLine, max); line++) {
          ranges.push(new vscode.Range(line, 0, line, 0));
        }
      }
      ed.setDecorations(this.type, ranges);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    // Decoration types are VS Code-side resources: without this they outlive the extension
    // and their gutter marks stay on screen after a reload.
    this.type.dispose();
    this.dragType.dispose();
    for (const s of this.subs) s.dispose();
  }
}
