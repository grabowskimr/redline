import * as vscode from 'vscode';
import { locationForUri, noteKey } from '../comments/uriMapping';
import { compareByPathThenLine, isOnDeck, isOpen, ReviewNote } from '../model/note';
import { ReviewStore } from '../store/reviewStore';

/**
 * Queries over the store that the UI and commands share, plus the `when`-clause context
 * keys. Replaces the old tree provider — the panel is a webview, so no TreeDataProvider
 * is needed, but everything still needs one place to ask "which notes, in what order".
 */
export class NoteIndex implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly subs: vscode.Disposable[] = [];
  /** noteId → the code at its anchor differs from what was sent to the agent. */
  private readonly changed = new Map<string, boolean>();

  constructor(private readonly store: ReviewStore) {
    this.subs.push(
      store.onDidChange(() => {
        this.pruneChanged();
        void this.updateContextKeys();
      }),
    );
    void this.updateContextKeys();
  }

  /**
   * Drop entries for notes that no longer exist. Nothing else removes them, so deleting
   * notes over a long-lived window would leave the map growing for the whole session.
   */
  private pruneChanged(): void {
    if (this.changed.size === 0) return;
    const live = new Set(this.store.notes.map((n) => n.id));
    for (const id of [...this.changed.keys()]) {
      if (!live.has(id)) this.changed.delete(id);
    }
  }

  /** Notes still to be sent, in document order — the set a submit picks up. */
  openNotes(): ReviewNote[] {
    return this.store.notes.filter(isOpen).sort(compareByPathThenLine);
  }

  /** Everything the panel lists above the "sent" section, done notes included. */
  panelNotes(): ReviewNote[] {
    return this.store.notes.filter(isOnDeck).sort(compareByPathThenLine);
  }

  sentNotes(): ReviewNote[] {
    return this.store.notes.filter((n) => n.sent).sort(compareByPathThenLine);
  }

  notesForUri(uri: vscode.Uri): ReviewNote[] {
    const loc = locationForUri(uri);
    if (!loc) return [];
    const key = noteKey(loc.path, loc.workspaceFolder);
    return this.store.notes.filter((n) => noteKey(n.path, n.workspaceFolder) === key);
  }

  changedSinceSent(noteId: string): boolean {
    return this.changed.get(noteId) ?? false;
  }

  /** Called by the live tracker when it re-resolves a file. */
  setChangedSinceSent(noteId: string, value: boolean): boolean {
    if (this.changed.get(noteId) === value) return false;
    this.changed.set(noteId, value);
    this._onDidChange.fire();
    return true;
  }

  clearChangedSinceSent(noteId: string): void {
    if (this.changed.delete(noteId)) this._onDidChange.fire();
  }

  refresh(): void {
    this._onDidChange.fire();
    void this.updateContextKeys();
  }

  private async updateContextKeys(): Promise<void> {
    const notes = this.store.notes;
    await Promise.all([
      // Done-but-unsent notes still need Clear All and the rest of the view menu.
      vscode.commands.executeCommand('setContext', 'redline.hasNotes', notes.some(isOnDeck)),
      vscode.commands.executeCommand('setContext', 'redline.hasSent', notes.some((n) => !!n.sent)),
      vscode.commands.executeCommand('setContext', 'redline.hasArchive', this.store.hasArchive),
    ]);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this._onDidChange.dispose();
  }
}
