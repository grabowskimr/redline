import * as vscode from 'vscode';
import { Config } from '../config';
import { Logger } from '../logger';
import { ReviewNote } from '../model/note';
import { ReviewStore, StoreChange } from '../store/reviewStore';
import { RangeProvider } from './rangeProvider';
import { applyNoteToThread, createThread, fromRange, toRange } from './threadFactory';
import { locationForUri, noteKey, uriForNote } from './uriMapping';

export const CONTROLLER_ID = 'redline.notes';
const PANEL_PROMPTED_KEY = 'redline.commentsPanelPrompted';

/**
 * VS Code auto-opens its built-in "Comments" panel for any file with comment threads
 * (`comments.openView`, default `firstFile`) and on startup (`comments.openPanel`). That
 * panel is redundant next to the Review Notes view, so offer once to switch it off.
 */
export async function maybeOfferToQuietCommentsPanel(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(PANEL_PROMPTED_KEY)) return;
  const cfg = vscode.workspace.getConfiguration('comments');
  const openView = cfg.get<string>('openView', 'firstFile');
  const openPanel = cfg.get<string>('openPanel', 'openOnSessionStartWithComments');
  if (openView === 'never' && openPanel === 'never') return;
  await context.globalState.update(PANEL_PROMPTED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'Redline: VS Code opens its built-in "Comments" panel whenever a file has review notes. Stop it from auto-opening? (sets comments.openView and comments.openPanel to "never" in your user settings)',
    'Turn off',
    'Keep',
  );
  if (choice !== 'Turn off') return;
  await cfg.update('openView', 'never', vscode.ConfigurationTarget.Global);
  await cfg.update('openPanel', 'never', vscode.ConfigurationTarget.Global);
}

/**
 * Owns the CommentController and keeps threads in sync with the store.
 * Threads are materialised lazily for visible editors and never recreated in place
 * (recreating makes the widget flicker).
 */
export class CommentHost implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly threadsByNoteId = new Map<string, vscode.CommentThread>();
  private readonly noteIdByThread = new WeakMap<vscode.CommentThread, string>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly store: ReviewStore,
    config: Config,
    private readonly logger: Logger,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Redline');
    this.controller.options = {
      // `prompt` labels the collapsed reply box; `placeHolder` is the empty textarea. The
      // widget's own header ("Start discussion") is VS Code's and cannot be set from here.
      // `prompt` is the collapsed bar, rendered full width and in bold — long text there
      // reads as a heading rather than an invitation to type.
      //
      // One word for one box: it is always present now, on a note Claude has answered and on
      // one it has never seen, and "follow-up" covers both without changing under you.
      prompt: 'Follow-up…',
      // One placeholder serves both a new note and a follow-up — the controller has a single
      // value for it — so it earns its space by teaching the kind prefixes, which are
      // otherwise undiscoverable. Matches PREFIX_KINDS in commands/noteCommands.
      placeHolder: 'What should change here?   ? question · ! bug · * idea · ~ nit · + praise',
    };
    this.controller.commentingRangeProvider = new RangeProvider(config);
    this.subs.push(
      this.controller,
      // There is no public "commenting ranges changed" event; reassigning the provider
      // makes VS Code re-query ranges for visible editors.
      config.onDidChange(() => {
        const p = this.controller.commentingRangeProvider;
        this.controller.commentingRangeProvider = undefined;
        this.controller.commentingRangeProvider = p;
        for (const id of this.threadsByNoteId.keys()) this.refresh(id);
      }),
      store.onDidChange((e) => this.onStoreChange(e)),
      vscode.window.onDidChangeVisibleTextEditors((eds) => this.materialiseFor(eds)),
    );
    this.materialiseFor(vscode.window.visibleTextEditors);
  }

  // ─── lookups ────────────────────────────────────────────────────────────

  threadFor(noteId: string): vscode.CommentThread | undefined {
    return this.threadsByNoteId.get(noteId);
  }

  noteIdFor(thread: vscode.CommentThread): string | undefined {
    return this.noteIdByThread.get(thread);
  }

  threadsForUri(uri: vscode.Uri): Array<{ noteId: string; thread: vscode.CommentThread }> {
    const key = uri.toString();
    const out: Array<{ noteId: string; thread: vscode.CommentThread }> = [];
    for (const [noteId, thread] of this.threadsByNoteId) {
      if (thread.uri.toString() === key) out.push({ noteId, thread });
    }
    return out;
  }

  /**
   * Close the follow-up textarea (discarding its draft) without collapsing the widgets.
   * Toggling `canReply` re-renders the reply area back to its collapsed state.
   */
  cancelReply(uri: vscode.Uri, only?: vscode.CommentThread): boolean {
    // Just the thread the Cancel came from, when it is known. Falling back to every thread in
    // the file would close a reply being written on a different note.
    const threads = only
      ? this.threadsForUri(uri).filter(({ thread }) => thread === only)
      : this.threadsForUri(uri);
    if (threads.length === 0) return false;
    for (const { thread } of threads) thread.canReply = false;
    setTimeout(() => {
      for (const { noteId } of threads) this.refresh(noteId);
    }, 0);
    return true;
  }

  get rangeProvider(): RangeProvider {
    return this.controller.commentingRangeProvider as RangeProvider;
  }

  // ─── note lifecycle ─────────────────────────────────────────────────────

  private pendingThread: vscode.CommentThread | undefined;

  /**
   * Run `create` (which adds a note to the store) while `thread` is marked as the thread
   * that spawned it, so the store's `add` event adopts that thread instead of creating a
   * second one. Returns the created note.
   */
  createWithThread<T extends ReviewNote>(thread: vscode.CommentThread, create: () => T): T {
    void maybeOfferToQuietCommentsPanel(this.context);
    this.pendingThread = thread;
    try {
      const note = create();
      // If the add event didn't run (e.g. listener order), adopt now.
      if (this.threadsByNoteId.get(note.id) !== thread) this.adopt(thread, note);
      return note;
    } finally {
      this.pendingThread = undefined;
    }
  }

  /** Bind a freshly created note to the (previously empty) thread that spawned it. */
  adopt(thread: vscode.CommentThread, note: ReviewNote): void {
    const previous = this.threadsByNoteId.get(note.id);
    if (previous && previous !== thread) this.disposeThread(note.id);
    applyNoteToThread(thread, note);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.register(note.id, thread);
  }

  /** Ensure a thread exists for the note (materialising if its file is open). */
  ensureThread(note: ReviewNote, uri?: vscode.Uri): vscode.CommentThread | undefined {
    const target = uri ?? uriForNote(note.path, note.workspaceFolder);
    if (!target) return undefined;
    const existing = this.threadsByNoteId.get(note.id);
    if (existing) {
      if (existing.uri.toString() === target.toString()) {
        this.refresh(note.id);
        return existing;
      }
      // Note moved to another file (re-anchor): the old thread is stale.
      this.disposeThread(note.id);
    }
    const thread = createThread(this.controller, target, note);
    this.register(note.id, thread);
    return thread;
  }

  /**
   * Refresh an existing thread's comments (reassigns the array to force re-render).
   * While the user is editing the comment only the range is synced, so the draft survives
   * store updates (e.g. range shifts from the live tracker).
   */
  refresh(noteId: string): void {
    const note = this.store.getById(noteId);
    const thread = this.threadsByNoteId.get(noteId);
    if (!note || !thread) return;
    if (thread.comments.some((c) => c.mode === vscode.CommentMode.Editing)) {
      const r = toRange(note.range);
      if (!thread.range || !thread.range.isEqual(r)) thread.range = r;
      return;
    }
    applyNoteToThread(thread, note);
  }

  disposeThread(noteId: string): void {
    const thread = this.threadsByNoteId.get(noteId);
    if (!thread) return;
    this.threadsByNoteId.delete(noteId);
    try {
      thread.dispose();
    } catch (err) {
      this.logger.warn('thread dispose failed', err);
    }
  }

  disposeAll(): void {
    for (const id of [...this.threadsByNoteId.keys()]) this.disposeThread(id);
  }

  /** Current editor-tracked ranges (VS Code moves `thread.range` as the user types). */
  reconcileRanges(uri: vscode.Uri): void {
    const loc = locationForUri(uri);
    if (!loc) return;
    const key = noteKey(loc.path, loc.workspaceFolder);
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    for (const [id, thread] of this.threadsByNoteId) {
      const note = this.store.getById(id);
      if (!note || noteKey(note.path, note.workspaceFolder) !== key || !thread.range) continue;
      const r = fromRange(thread.range);
      if (r.startLine !== note.range.startLine || r.endLine !== note.range.endLine) {
        patches.push({ id, patch: { range: r, anchor: { ...note.anchor, lineHint: r.startLine } } });
      }
    }
    if (patches.length) this.store.updateMany(patches);
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private register(noteId: string, thread: vscode.CommentThread): void {
    this.threadsByNoteId.set(noteId, thread);
    this.noteIdByThread.set(thread, noteId);
  }

  private materialiseFor(editors: readonly vscode.TextEditor[]): void {
    const seen = new Set<string>();
    for (const ed of editors) {
      const uri = ed.document.uri;
      const loc = locationForUri(uri);
      if (!loc || loc.side === 'base') continue;
      const key = noteKey(loc.path, loc.workspaceFolder);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const note of this.store.notes) {
        if (noteKey(note.path, note.workspaceFolder) !== key) continue;
        if (note.anchor.orphaned) continue;
        if (!this.threadsByNoteId.has(note.id)) this.ensureThread(note, loc.fileUri);
      }
    }
  }

  private onStoreChange(e: StoreChange): void {
    switch (e.type) {
      case 'add':
        // Threads for notes created from the widget are adopted explicitly; quick-add notes
        // need materialising if their file is visible.
        for (const id of e.noteIds) {
          const note = this.store.getById(id);
          if (!note) continue;
          if (this.pendingThread) {
            this.adopt(this.pendingThread, note);
            this.pendingThread = undefined;
          } else if (!this.threadsByNoteId.has(id)) {
            this.materialiseIfVisible(note);
          }
        }
        break;
      case 'update':
        for (const id of e.noteIds) {
          const note = this.store.getById(id);
          if (!note) continue;
          if (note.anchor.orphaned) {
            this.disposeThread(id);
          } else if (this.threadsByNoteId.has(id)) {
            this.refresh(id);
          } else {
            this.materialiseIfVisible(note);
          }
        }
        break;
      case 'delete':
        for (const id of e.noteIds) this.disposeThread(id);
        break;
      case 'clear':
        this.disposeAll();
        break;
      case 'restore':
      case 'reload':
        this.disposeAll();
        this.materialiseFor(vscode.window.visibleTextEditors);
        break;
    }
  }

  private materialiseIfVisible(note: ReviewNote): void {
    const key = noteKey(note.path, note.workspaceFolder);
    for (const ed of vscode.window.visibleTextEditors) {
      const loc = locationForUri(ed.document.uri);
      if (loc && loc.side !== 'base' && noteKey(loc.path, loc.workspaceFolder) === key) {
        this.ensureThread(note, loc.fileUri);
        return;
      }
    }
  }

  dispose(): void {
    this.disposeAll();
    for (const s of this.subs) s.dispose();
  }
}
