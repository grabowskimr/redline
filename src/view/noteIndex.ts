import * as vscode from 'vscode';
import { locationForUri, noteKey } from '../comments/uriMapping';
import { compareByPathThenLine, hasUnsentReply, isOnDeck, isOpen, ReviewNote } from '../model/note';
import { ReviewStore } from '../store/reviewStore';

/** How many deleted notes keep their send-time flags. An Undo is offered on one note at a time. */
const RETIRED_LIMIT = 200;

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
  /**
   * noteId → *these lines* differ from what was sent.
   *
   * Not a subset of `changed`: a send clears `changed` on its own (see `clearSentSignals`),
   * and until this is cleared with it a re-sent note is marked as standing on rewritten lines
   * while nothing says anything moved.
   */
  private readonly linesDirty = new Set<string>();
  /**
   * Flags for notes that have just left the store, so a note that comes back under its own id
   * comes back with them.
   *
   * Delete is undoable and `reinstate` keeps the id, so pruning on the delete event answered
   * "have these lines changed?" with a fresh "no" for a note sent before the code under it was
   * rewritten — and a widget was drawn back onto lines the note is no longer about. Restoring
   * an archived batch does the same thing with the same ids. Bounded, because this exists to
   * stop the sets growing for the whole session, not to replace them.
   */
  private readonly retired = new Map<string, { changed?: boolean; lines: boolean }>();

  constructor(private readonly store: ReviewStore) {
    this.subs.push(
      store.onDidChange(() => {
        this.restoreRetired();
        this.pruneChanged();
        void this.updateContextKeys();
      }),
    );
    void this.updateContextKeys();
  }

  /** Notes back in the store under an id we kept flags for — an Undo, or a restored batch. */
  private restoreRetired(): void {
    if (this.retired.size === 0) return;
    let revived = false;
    for (const [id, flags] of [...this.retired]) {
      if (!this.store.getById(id)) continue;
      this.retired.delete(id);
      if (flags.changed !== undefined) this.changed.set(id, flags.changed);
      if (flags.lines) {
        this.linesDirty.add(id);
        revived = true;
      }
    }
    // Only the widget rule is announced: `changed` is a badge nobody redraws on its own, while
    // a note that came back onto rewritten lines must lose the thread the add event just drew.
    if (revived) this._onDidChange.fire();
  }

  /**
   * Drop entries for notes that no longer exist. Nothing else removes them, so deleting
   * notes over a long-lived window would leave the map growing for the whole session.
   */
  private pruneChanged(): void {
    if (this.changed.size === 0 && this.linesDirty.size === 0) return;
    const live = new Set(this.store.notes.map((n) => n.id));
    for (const id of [...this.changed.keys()]) {
      if (!live.has(id)) {
        this.retire(id);
        this.changed.delete(id);
      }
    }
    for (const id of [...this.linesDirty]) {
      if (!live.has(id)) {
        this.retire(id);
        this.linesDirty.delete(id);
      }
    }
  }

  private retire(id: string): void {
    const flags = this.retired.get(id) ?? { lines: false };
    const changed = this.changed.get(id);
    if (changed !== undefined) flags.changed = changed;
    if (this.linesDirty.has(id)) flags.lines = true;
    // Re-inserted so the oldest key stays first: this is dropped oldest-first when full.
    this.retired.delete(id);
    this.retired.set(id, flags);
    while (this.retired.size > RETIRED_LIMIT) {
      const oldest = this.retired.keys().next();
      if (oldest.done) break;
      this.retired.delete(oldest.value);
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

  /**
   * Did *these lines* change since the note was sent?
   *
   * Narrower than `changedSinceSent`, which also counts an edit elsewhere in the file — right
   * for a badge saying "something moved", wrong for deciding whether the widget still sits on
   * the code it is about.
   */
  linesChanged(noteId: string): boolean {
    return this.linesDirty.has(noteId);
  }

  /**
   * Announced, like `setChangedSinceSent` — this decides whether a note keeps its widget, and
   * nothing else will notice on its behalf.
   *
   * Silent, it was a change nobody heard: an agent that edits somewhere else in a file first
   * and the note's own lines second leaves `changedSinceSent` already true, so that setter
   * returns without firing, and the widget stayed on lines it was no longer about until some
   * unrelated repaint came past.
   */
  setLinesChanged(noteId: string, value: boolean): void {
    const had = this.linesDirty.has(noteId);
    if (had === value) return;
    if (value) this.linesDirty.add(noteId);
    else this.linesDirty.delete(noteId);
    this._onDidChange.fire();
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

  /**
   * Forget both send-time signals, which is what sending a note again means: `markSent` writes
   * a fresh `snippetHash` taken from the code as it is right now, so nothing about the note is
   * stale any more.
   *
   * The one to call from a send. Clearing only `changed` left `linesDirty` holding the note
   * from its previous round, so `showsInEditor` stayed false after the re-send: no widget, no
   * gutter bar, and `revealNote` silently doing nothing, until something happened to make the
   * tracker re-resolve that file.
   */
  clearSentSignals(noteId: string): void {
    const hadChanged = this.changed.delete(noteId);
    const hadLines = this.linesDirty.delete(noteId);
    this.retired.delete(noteId);
    if (hadChanged || hadLines) this._onDidChange.fire();
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
      // Anything to send, which is not the same as anything on deck: a follow-up written on a
      // note that has already been answered is sendable while nothing is waiting to go.
      vscode.commands.executeCommand(
        'setContext',
        'redline.canSend',
        notes.some((n) => isOpen(n) || hasUnsentReply(n)),
      ),
      vscode.commands.executeCommand('setContext', 'redline.hasSent', notes.some((n) => !!n.sent)),
      vscode.commands.executeCommand('setContext', 'redline.hasArchive', this.store.hasArchive),
    ]);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this._onDidChange.dispose();
  }
}
