import * as vscode from 'vscode';
import { Config } from '../config';
import { Logger } from '../logger';
import { ReviewNote, showsInEditor } from '../model/note';
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
  private readonly commentingRange: RangeProvider;
  /**
   * Whether a note's own lines have moved since it was sent.
   *
   * Set from outside because the answer lives in the index, which is filled by the anchor
   * tracker as documents are read. Unknown counts as unchanged — see `showsInEditor`.
   */
  linesChanged: (noteId: string) => boolean = () => false;

  /**
   * True while a different surface is meant to be drawing notes — the inset surface, once the
   * experimental widget is on and available. The approved spec is explicit that the comment
   * controller stops drawing while the experiment is on ("no + on hover, no Comments-panel
   * entries, no chance of two widgets on one line"); this is what carries that into code without
   * disposing `host` itself, which `LiveTracker` holds directly for re-anchoring regardless of
   * which surface is current (see the note on `host`'s construction in `extension.ts`) — a
   * disposed `CommentController` would break `threadFor`/`reconcileRanges` for the rest of the
   * window, not just pause drawing.
   *
   * Default `false`, unchanged from today: nothing sets this outside `setSuppressed`, and
   * comment mode never calls it, so this changes no behaviour for anyone not using the
   * experiment.
   */

  constructor(
    private readonly store: ReviewStore,
    config: Config,
    private readonly logger: Logger,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Redline');
    this.controller.options = {
      // `prompt` labels the collapsed input bar; `placeHolder` is the empty textarea. The
      // widget's own header ("Start discussion") is VS Code's and cannot be set from here.
      // `prompt` is rendered full width and in bold — long text there reads as a heading
      // rather than an invitation to type.
      //
      // Only one box is left in the editor: the one that starts a note. Follow-ups happen on
      // the card, so this no longer has to cover both and can say what it actually does.
      prompt: 'Add a note…',
      // Short: it sits above a box the editor gives a ninety-pixel floor to, and a sentence
      // that long stretched across an empty field reads as the field's contents. The two
      // prefixes worth teaching are the two that change what the agent does with the note.
      placeHolder: 'What should change here?   ? to ask · ! for a bug',
    };
    this.commentingRange = new RangeProvider(config);
    this.controller.commentingRangeProvider = this.commentingRange;
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

  /**
   * Re-decide, for every note, whether it still belongs in the editor.
   *
   * The store is not the only thing that can change the answer. An agent that rewrites a
   * note's lines in place leaves the note itself untouched — same file, same line numbers,
   * different code — so no store event is raised and nothing here reconsidered: the widget sat
   * on lines it was no longer about for as long as the file stayed open. The signal for that
   * arrives from the index instead, and this is what it calls.
   *
   * Both directions: a thread whose note has stopped qualifying goes, and one that qualifies
   * again — an edit undone, the lines back as they were — is put back.
   */
  sync(): void {
    for (const [id] of [...this.threadsByNoteId]) {
      if (this.isBeingEdited(id)) continue;
      const note = this.store.getById(id);
      if (!note || note.anchor.orphaned || !showsInEditor(note, this.linesChanged(id))) {
        this.disposeThread(id);
      }
    }
    this.materialiseFor(vscode.window.visibleTextEditors);
  }

  /**
   * Is a half-written edit open in this note's widget?
   *
   * The one thing that outranks "this note no longer belongs on these lines": disposing the
   * thread takes the sentence being typed into it with it, and there is no way to get it back.
   * `sync()` has always honoured that; the store event did not, so clicking Approve on the card
   * — or the agent's rewrite landing — deleted the draft. It is reconsidered as soon as the
   * edit is finished with: the save and cancel commands call `sync()`.
   */
  private isBeingEdited(noteId: string): boolean {
    const thread = this.threadsByNoteId.get(noteId);
    return !!thread?.comments.some((c) => c.mode === vscode.CommentMode.Editing);
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

  /** Which files take a note at all — asked by the commands, so the rule lives in one place. */
  get rangeProvider(): RangeProvider {
    return this.commentingRange;
  }

  // ─── note lifecycle ─────────────────────────────────────────────────────

  private pendingThread: vscode.CommentThread | undefined;

  /**
   * Run `create` (which adds a note to the store) while `thread` is marked as the thread
   * that spawned it, so the store's `add` event adopts that thread instead of creating a
   * second one. Returns the created note.
   *
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
    // Settled, orphaned or standing on rewritten lines before its widget was ever adopted — a
    // re-imported note, or a report that landed between the two. Adopting it here is how a
    // disposed widget came back once.
    if (!showsInEditor(note, this.linesChanged(note.id))) {
      try {
        thread.dispose();
      } catch {
        /* already gone */
      }
      return;
    }
    const previous = this.threadsByNoteId.get(note.id);
    if (previous && previous !== thread) this.disposeThread(note.id);
    applyNoteToThread(thread, note);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.register(note.id, thread);
  }

  /** Ensure a thread exists for the note (materialising if its file is open). */
  ensureThread(note: ReviewNote, uri?: vscode.Uri): vscode.CommentThread | undefined {
    // A note that no longer belongs on these lines has no widget — and must not grow one back
    // the next time its file is opened, or scrolled, or the note is touched by the tracker.
    if (!showsInEditor(note, this.linesChanged(note.id))) {
      this.disposeThread(note.id);
      return undefined;
    }
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
        if (note.anchor.orphaned || !showsInEditor(note, this.linesChanged(note.id))) continue;
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
          // The same rule `sync()` follows, and for the same reason — see `isBeingEdited`.
          // `refresh` below already knows to leave a draft alone and sync only the range.
          const editing = this.isBeingEdited(id);
          if (!editing && (note.anchor.orphaned || !showsInEditor(note, this.linesChanged(note.id)))) {
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
    if (!showsInEditor(note, this.linesChanged(note.id))) return;
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
