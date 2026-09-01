import * as vscode from 'vscode';
import { createAnchor } from '../anchor/anchorService';
import { isNoteComment } from '../comments/noteComment';
import { fromRange, toRange } from '../comments/threadFactory';
import { locationForUri, uriForNote } from '../comments/uriMapping';
import {
  KIND_META,
  KINDS_BY_WEIGHT,
  NewNoteInput,
  NoteKind,
  ReviewNote,
} from '../model/note';
import { Deps, resolveNoteId, resolveNoteIdOrPick } from './deps';

const PREFIX_KINDS: Array<[string, NoteKind]> = [
  ['? ', 'question'],
  ['! ', 'bug'],
  ['* ', 'idea'],
  ['~ ', 'nit'],
  ['+ ', 'praise'],
];

/** `? why` → { body: 'why', kind: 'question' } when prefixes are enabled. */
export function applyKindPrefix(
  text: string,
  fallback: NoteKind,
  enabled: boolean,
): { body: string; kind: NoteKind } {
  if (enabled) {
    for (const [prefix, kind] of PREFIX_KINDS) {
      if (text.startsWith(prefix) && text.length > prefix.length) {
        return { body: text.slice(prefix.length).trim(), kind };
      }
    }
  }
  return { body: text, kind: fallback };
}

async function pickKind(current?: NoteKind): Promise<NoteKind | undefined> {
  const items: Array<vscode.QuickPickItem & { noteKind: NoteKind }> = KINDS_BY_WEIGHT.map((k) => ({
    label: `${KIND_META[k].icon} ${KIND_META[k].label}`,
    description: KIND_META[k].description,
    detail: k === current ? 'current' : undefined,
    noteKind: k,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'What kind of note is this? (shapes how Claude treats it)',
    matchOnDescription: true,
  });
  return picked?.noteKind;
}

/** Normalise a selection to whole lines and build the note input. */
async function buildNoteInput(
  deps: Deps,
  document: vscode.TextDocument,
  range: vscode.Range,
  body: string,
  kind: NoteKind,
): Promise<NewNoteInput | undefined> {
  const loc = locationForUri(document.uri);
  if (!loc) {
    void vscode.window.showWarningMessage('Redline: this document cannot hold review notes.');
    return undefined;
  }
  let endLine = range.end.line;
  if (endLine > range.start.line && range.end.character === 0) endLine--;
  endLine = Math.min(endLine, Math.max(document.lineCount - 1, 0));
  const startLine = Math.min(range.start.line, endLine);
  const serial = fromRange(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length));
  const anchor = createAnchor(document.getText(), serial);
  const input: NewNoteInput = {
    path: loc.path,
    languageId: document.languageId,
    range: serial,
    anchor,
    // What you were looking at, kept as you saw it. The anchor's own copy moves with the code.
    snapshot: { code: anchor.snippet, startLine: serial.startLine },
    body,
    kind,
  };
  if (loc.workspaceFolder !== undefined) input.workspaceFolder = loc.workspaceFolder;
  const git = await deps.git.snapshot(loc.fileUri).catch(() => undefined);
  if (git) input.git = git;
  return input;
}

export function noteCommands(deps: Deps) {
  const { store, host, config, logger } = deps;

  // ── creating ─────────────────────────────────────────────────────────

  /** The gutter widget's "Add note" button. */
  async function createNote(arg: unknown): Promise<void> {
    const reply = arg as vscode.CommentReply | undefined;
    if (!reply?.thread) return quickAddNote();
    const raw = typeof reply.text === 'string' ? reply.text.trim() : '';
    if (!raw) {
      void vscode.window.showWarningMessage('Redline: write something before adding a note.');
      return;
    }
    const thread = reply.thread;
    /*
     * Before anything that waits.
     *
     * The moment the editor accepts what you typed it re-renders the thread, and a thread it
     * has not been told otherwise about offers to be replied to — so a reply bar appeared under
     * the new note for as long as it took to read the file and ask git about it, which is a
     * visible flash and an invitation to type into a box that does nothing. Everything below
     * here awaits something; this cannot.
     */
    thread.canReply = false;

    // A thread that already holds a note takes no more input. VS Code only offers this action
    // on an empty thread, so it is not reachable — but the branch that used to be here
    // appended the text as a follow-up, which is the one thing the widget must no longer do.
    // Refusing beats quietly starting a second note on the same line.
    if (host.noteIdFor(thread)) return;

    const doc = await vscode.workspace.openTextDocument(thread.uri);
    const parsed = applyKindPrefix(raw, config.defaultKind, config.kindPrefixes);
    const input = await buildNoteInput(
      deps,
      doc,
      thread.range ?? new vscode.Range(0, 0, 0, 0),
      parsed.body,
      parsed.kind,
    );
    if (!input) return;
    host.createWithThread(thread, () => store.add(input));
  }

  /** Keyboard flow: no widget, just an input box at the cursor/selection. */
  /**
   * Open the note widget on the current line, ready to type in.
   *
   * The same thing the `+` in the gutter does, without the mouse. It asks the editor to do it
   * rather than building a thread here: the editor already knows where the commentable ranges
   * are, how to focus the box, and — the part that matters — what to do when you press Escape.
   * A thread we opened ourselves and you walked away from would leave an empty marker in the
   * gutter with nothing in it.
   *
   * `quickAddNote` stays as it was, for anyone who would rather type into a prompt: on a
   * narrow screen the widget takes half the editor.
   */
  async function addNoteHere(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      void vscode.window.showInformationMessage('Redline: open a file first.');
      return;
    }
    if (!host.rangeProvider.isSupported(ed.document)) {
      void vscode.window.showWarningMessage('Redline: this file is excluded from review notes.');
      return;
    }
    try {
      await vscode.commands.executeCommand('workbench.action.addComment');
    } catch (err) {
      // Older editors do not have the command. The prompt asks for the same thing.
      logger.trace(`the editor could not open a comment widget: ${String(err)}`);
      await quickAddNote();
    }
  }

  async function quickAddNote(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      void vscode.window.showInformationMessage('Redline: open a file first.');
      return;
    }
    if (!host.rangeProvider.isSupported(ed.document)) {
      void vscode.window.showWarningMessage('Redline: this file is excluded from review notes.');
      return;
    }
    const sel = ed.selection;
    const body = await vscode.window.showInputBox({
      prompt: `Note for ${vscode.workspace.asRelativePath(ed.document.uri)}:${sel.start.line + 1}`,
      placeHolder: 'What should change here? (? question · ! bug · * idea · ~ nit)',
      ignoreFocusOut: true,
    });
    if (!body?.trim()) return;
    const parsed = applyKindPrefix(body.trim(), config.defaultKind, config.kindPrefixes);
    const input = await buildNoteInput(deps, ed.document, new vscode.Range(sel.start, sel.end), parsed.body, parsed.kind);
    if (!input) return;
    const note = store.add(input);
    // The document already open, not a uri resolved fresh from `note.path` — matters on the
    // index side of a staged diff, and for a note whose workspace folder is no longer open.
    host.ensureThread(note, ed.document.uri);
  }

  /** Programmatic creation (public API + tests). */
  async function createNoteAt(
    uri: vscode.Uri,
    range: vscode.Range,
    body: string,
    kind?: NoteKind,
  ): Promise<ReviewNote | undefined> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const input = await buildNoteInput(deps, doc, range, body, kind ?? config.defaultKind);
    if (!input) return undefined;
    const note = store.add(input);
    // The caller's own uri, not one resolved fresh — this is public API and must land on
    // whatever document the caller actually meant.
    host.ensureThread(note, uri);
    return note;
  }

  /**
   * Carry on the conversation from the widget.
   *
   * The reply bar was taken out of the widget when an answered note lost its widget: two
   * places asking for the same follow-up, one of which was about to disappear. The widget now
   * stays for as long as the code under it holds still, showing Claude's answer against the
   * lines it is about — and reading an answer is exactly when you want to reply to it.
   *
   * Recorded, not sent, which is what the card does too: a follow-up often wants a screenshot
   * attached before it goes, so sending stays a separate, deliberate act.
   */
  function replyToThread(arg: unknown): void {
    const reply = arg as vscode.CommentReply | undefined;
    const thread = reply?.thread;
    if (!thread) return;
    const text = typeof reply?.text === 'string' ? reply.text.trim() : '';
    if (!text) return;
    // A `CommentThread` only ever arrives here from the widget's own reply box.
    const id = host.noteIdFor(thread);
    const note = id ? store.getById(id) : undefined;
    if (!note) return;
    store.update(note.id, { addenda: [...note.addenda, text] });
    // The store event runs inside that call, and a note that goes `done` on the same tick has
    // had its thread disposed before we get back here — writing to a disposed one throws.
    // Re-ask the host: only the thread it still holds for this note is live.
    if (host.threadFor(note.id) !== thread) return;
    // The store change re-renders the thread with the new turn in it. Clearing the box is the
    // caller's job in VS Code's own reply flow and does not happen on its own here.
    thread.comments = [...thread.comments];
  }

  // ── editing ──────────────────────────────────────────────────────────

  async function editViaInputBox(note: ReviewNote): Promise<void> {
    const body = await vscode.window.showInputBox({ prompt: 'Edit note', value: note.body, ignoreFocusOut: true });
    if (body === undefined) return;
    if (!body.trim()) {
      void vscode.window.showWarningMessage('Redline: a note cannot be empty.');
      return;
    }
    store.update(note.id, { body: body.trim() });
  }

  async function editComment(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    let note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note to edit.');
      return;
    }
    if (note.anchor.orphaned) return editViaInputBox(note);
    if (!host.threadFor(note.id)) await revealNote(note.id);
    // `revealNote` awaits opening and showing the document; the live tracker can update the
    // note (its anchor, its body) in that window, so what is edited — and what the fallback
    // below prefills — has to be what is true now, not what was true before the reveal.
    note = store.getById(note.id) ?? note;
    const thread = host.threadFor(note.id);
    if (!thread) return editViaInputBox(note);
    const comment = thread.comments.find(isNoteComment);
    // A thread with no note comment in it is a broken widget, and the old behaviour was to
    // leave it alone rather than surprise you with a prompt. Kept.
    if (!comment) return;
    comment.beginEdit(note);
    thread.comments = [...thread.comments];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  function saveComment(arg: unknown): void {
    const comment = isNoteComment(arg) ? arg : undefined;
    const id = comment?.noteId ?? resolveNoteId(deps, arg);
    if (!id) return;
    // `Comment`/`CommentThread` objects only ever arrive from the widget's own edit flow.
    const thread = host.threadFor(id);
    const note = store.getById(id);
    if (!thread || !note) return;
    const c = comment ?? thread.comments.find(isNoteComment);
    if (!c) return;
    const text = c.editedText().trim();
    if (!text) {
      void vscode.window.showWarningMessage('Redline: a note cannot be empty.');
      return;
    }
    const updated = store.update(id, { body: text }) ?? note;
    // Same tick, same hazard as `replyToThread`: the store event has already run by the time
    // this line does, and the agent rewriting these lines while you typed is exactly what
    // disposes the thread. The body is saved either way — there is just nothing left to render
    // it into.
    if (host.threadFor(id) !== thread) return;
    c.endEdit(updated);
    thread.comments = [...thread.comments];
    // Out of edit mode, so the widget may be taken away again: the store event deliberately
    // leaves a thread alone while a draft is open in it, and nothing else revisits that.
    host.sync();
  }

  function cancelEdit(arg: unknown): void {
    const comment = isNoteComment(arg) ? arg : undefined;
    const id = comment?.noteId ?? resolveNoteId(deps, arg);
    if (!id) return;
    // Same as `saveComment`: only ever reached from the widget's own cancel action.
    const thread = host.threadFor(id);
    const note = store.getById(id);
    if (!thread || !note) return;
    const c = comment ?? thread.comments.find(isNoteComment);
    if (!c) return;
    c.endEdit(note);
    thread.comments = [...thread.comments];
    // As in `saveComment`: the draft is gone, so whatever the store said while it was open now
    // applies to this widget.
    host.sync();
  }

  /**
   * Accept the change a note asked for.
   *
   * Claude reporting a note as finished is a claim about the code, not a verdict on it — so a
   * note it has answered sits in "waiting for approval" until someone looks. This is the look.
   */
  function approveNote(arg: unknown): void {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note first.');
      return;
    }
    store.update(note.id, { done: true, rejected: undefined });
    void vscode.window.setStatusBarMessage(`Redline: #${note.seq} approved`, 4000);
  }

  /** Not good enough — reopen the note and ask for more, in the same thread. */
  function needsWork(arg: unknown): void {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note first.');
      return;
    }
    // Recorded, not inferred: "there is a follow-up after its answer" is also what asking a
    // further question looks like, and the card shows the two differently — one is waiting on
    // another attempt, the other is a conversation.
    //
    // Nothing is opened in the editor. Turning a change down used to reveal and focus the
    // widget's reply box, which took you out of the panel you were reading in order to type
    // into a second place that asked for the same thing. The card's own box is where the
    // reason goes, and the panel puts the cursor in it.
    store.update(note.id, { done: false, rejected: true });
  }

  function deleteNote(arg: unknown): void {
    const id = resolveNoteIdOrPick(deps, arg);
    if (!id) {
      void vscode.window.showInformationMessage('Redline: no note selected.');
      return;
    }
    // Offer Undo rather than a confirmation: ✕ sits on the card now, so this runs on a
    // single click and losing a note to a misclick should not be possible.
    const note = store.getById(id);
    store.delete([id]);
    if (!note) return;
    void vscode.window
      .showInformationMessage(`Redline: removed #${note.seq}.`, 'Undo')
      .then((choice) => {
        if (choice === 'Undo') {
          store.reinstate([note]);
          return;
        }
        // Gone for good, so its screenshots are too — every one of them, whether it was
        // attached to the note or to a follow-up on it. They are megabytes each and nothing
        // else refers to them; before this they sat in storage until the next window opened.
        deps.sweepAttachments?.();
      });
  }

  /**
   * Settle a note, or bring it back.
   *
   * Only `done` moves. A follow-up you wrote and never sent stops being owed while the note is
   * finished — `hasUnsentReply` reads `done` for that — and is owed again the moment you
   * reopen it. This used to move the sent mark forward instead, which cannot be undone: the
   * turn stayed in the thread looking delivered, and there was no way to send it.
   */
  function toggleDone(arg: unknown): void {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: no note selected.');
      return;
    }
    store.update(note.id, { done: !note.done });
  }

  // ── kinds ────────────────────────────────────────────────────────────

  async function setKind(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note first.');
      return;
    }
    const kind = await pickKind(note.kind);
    if (kind && kind !== note.kind) store.update(note.id, { kind });
  }

  /**
   * One-click kind buttons. Clicking the kind a note already has resets it to a plain
   * change request, and "change request" is itself a button so you can get back to the
   * default without having to remember which kind is currently set.
   */
  function quickKind(kind: NoteKind) {
    return (arg: unknown): void => {
      const id = resolveNoteIdOrPick(deps, arg);
      const note = id ? store.getById(id) : undefined;
      if (!note) {
        void vscode.window.showInformationMessage('Redline: select a note first.');
        return;
      }
      store.update(note.id, { kind: note.kind === kind ? 'comment' : kind });
    };
  }

  // ── navigation & anchors ─────────────────────────────────────────────

  async function revealNote(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) return;
    const uri = uriForNote(note.path, note.workspaceFolder);
    if (!uri) return;
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      void vscode.window.showWarningMessage(`Redline: cannot open ${note.path}.`);
      return;
    }
    const range = toRange(note.range);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.selection = new vscode.Selection(range.start, range.start);
    if (note.anchor.orphaned) return;
    // The one caller that means "put this in front of someone," not just "make sure it exists",
    // which is why this is the only `ensureThread` that expands what it finds.
    const thread = host.ensureThread(note, uri);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /** Move an orphaned note to the cursor / selection. */
  async function reanchorNote(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note first.');
      return;
    }
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      void vscode.window.showInformationMessage('Redline: put the cursor where the note belongs, then re-anchor.');
      return;
    }
    const input = await buildNoteInput(deps, ed.document, new vscode.Range(ed.selection.start, ed.selection.end), note.body, note.kind);
    if (!input) return;
    store.update(note.id, {
      path: input.path,
      workspaceFolder: input.workspaceFolder,
      languageId: input.languageId,
      range: input.range,
      anchor: input.anchor,
    });
    // The lines-changed verdict was about lines this note is no longer attached to. Left set,
    // `showsInEditor` stays false: the reveal below produces nothing at all while the command
    // reports success. The tracker recomputes both signals the next time it reads this file.
    deps.index.clearSentSignals(note.id);
    const updated = store.getById(note.id);
    if (updated) host.ensureThread(updated, ed.document.uri);
  }

  return {
    createNote,
    replyToThread,
    quickAddNote,
    addNoteHere,
    createNoteAt,
    editComment,
    saveComment,
    cancelEdit,
    approveNote,
    needsWork,
    deleteNote,
    toggleDone,
    setKind,
    kindChange: quickKind('comment'),
    kindBug: quickKind('bug'),
    kindIdea: quickKind('idea'),
    kindRefactor: quickKind('refactor'),
    kindQuestion: quickKind('question'),
    revealNote,
    reanchorNote,
  };
}

