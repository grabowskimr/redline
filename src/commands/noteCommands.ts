import * as vscode from 'vscode';
import { createAnchor, resolveAnchor } from '../anchor/anchorService';
import { isNoteComment } from '../comments/noteComment';
import { fromRange, toRange } from '../comments/threadFactory';
import { locationForUri, uriForNote } from '../comments/uriMapping';
import { firstLine, KIND_META, KINDS_BY_WEIGHT, NewNoteInput, NoteKind, ReviewNote } from '../model/note';
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
  const input: NewNoteInput = {
    path: loc.path,
    languageId: document.languageId,
    range: serial,
    anchor: createAnchor(document.getText(), serial),
    body,
    kind,
  };
  if (loc.workspaceFolder !== undefined) input.workspaceFolder = loc.workspaceFolder;
  const git = await deps.git.snapshot(loc.fileUri).catch(() => undefined);
  if (git) input.git = git;
  return input;
}

export function noteCommands(deps: Deps) {
  const { store, host, config } = deps;

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

    // Replying in a thread that already holds a note continues that conversation instead of
    // starting a second note on the same line. This is how a discussion carries on after
    // Claude has answered: click the marker, type, and it goes back with the whole exchange.
    const existingId = host.noteIdFor(thread);
    const existing = existingId ? store.getById(existingId) : undefined;
    if (existing) {
      // The reply is recorded and the note becomes active again; sending is a separate,
      // deliberate step, so a screenshot can be attached to it first.
      store.update(existing.id, { addenda: [...existing.addenda, raw] });
      void vscode.window.setStatusBarMessage(
        `Redline: added to #${existing.seq} — send it with ➤ in the panel, or ⌘⌥S`,
        6000,
      );
      return;
    }

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
    host.ensureThread(note, uri);
    return note;
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
    note = store.getById(note.id) ?? note;
    const thread = host.threadFor(note.id);
    if (!thread) return editViaInputBox(note);
    const comment = thread.comments.find(isNoteComment);
    if (!comment) return;
    comment.beginEdit(note);
    thread.comments = [...thread.comments];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  function saveComment(arg: unknown): void {
    const comment = isNoteComment(arg) ? arg : undefined;
    const id = comment?.noteId ?? resolveNoteId(deps, arg);
    if (!id) return;
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
    c.endEdit(updated);
    thread.comments = [...thread.comments];
  }

  function cancelEdit(arg: unknown): void {
    const comment = isNoteComment(arg) ? arg : undefined;
    const id = comment?.noteId ?? resolveNoteId(deps, arg);
    if (!id) return;
    const thread = host.threadFor(id);
    const note = store.getById(id);
    if (!thread || !note) return;
    const c = comment ?? thread.comments.find(isNoteComment);
    if (!c) return;
    c.endEdit(note);
    thread.comments = [...thread.comments];
  }

  /** Escape in the comment editor: close the reply box, keep the note visible. */
  /**
   * Close the reply box, discarding whatever was typed in it.
   *
   * Reachable from the box's own Cancel button as well as Escape: the keybinding only fires
   * while the editor inside the box has focus, so clicking the bar by accident and then
   * clicking elsewhere left it open with no way out.
   *
   * The argument is whatever the menu passed — a `CommentReply` when it comes from the box —
   * which is more reliable than the active editor for finding the thread.
   */
  async function cancelReply(arg?: unknown): Promise<void> {
    const reply = arg as vscode.CommentReply | undefined;
    const uri = reply?.thread?.uri ?? vscode.window.activeTextEditor?.document.uri;
    const handled = uri ? host.cancelReply(uri, reply?.thread) : false;
    if (!handled) await vscode.commands.executeCommand('workbench.action.hideComment');
  }

  /**
   * Submit the comment widget's reply box on a note that already exists.
   *
   * `createNote` only answers for an empty thread, so without this the reply box on an
   * existing note had no submit action bound to it at all — typing and pressing ⌘⏎ did
   * nothing, which is not a state anyone can diagnose from the outside.
   *
   * The turn is recorded, not sent: a reply often wants a screenshot attached first, and ➤
   * is the deliberate act that sends it.
   */
  async function replyToNote(arg: unknown): Promise<void> {
    const reply = arg as vscode.CommentReply | undefined;
    const raw = typeof reply?.text === 'string' ? reply.text.trim() : '';
    if (!reply?.thread || !raw) return;
    const id = host.noteIdFor(reply.thread);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      // The thread has no note behind it: treat this as a new one rather than losing the text.
      await createNote(arg);
      return;
    }
    store.update(note.id, { addenda: [...note.addenda, raw] });
    host.cancelReply(reply.thread.uri);
    void vscode.window.setStatusBarMessage(
      note.sent ? `Redline: follow-up added to #${note.seq} — send it with ➤` : `Redline: added to #${note.seq}`,
      6000,
    );
  }

  /**
   * Open the follow-up box on the note this widget is showing.
   *
   * The box used to sit under every note whether or not anything was being written in it,
   * which put a second input below a card that already carries the note, the answer and a row
   * of actions. It is opened deliberately now, from the widget's own toolbar.
   */
  async function followUpHere(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    if (!id) {
      void vscode.window.showInformationMessage('Redline: no note here to follow up on.');
      return;
    }
    if (!(await host.openReply(id))) {
      // No widget for it — the file is not open, or the note is being acted on from the panel.
      // The prompt is the next best thing; losing the click would be worse.
      await addFollowUp(id);
    }
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
    store.update(note.id, { done: true });
    void vscode.window.setStatusBarMessage(`Redline: #${note.seq} approved`, 4000);
  }

  /** Not good enough — reopen the note and ask for more, in the same thread. */
  async function needsWork(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note first.');
      return;
    }
    store.update(note.id, { done: false });
    await followUpHere(note.id);
  }

  async function addFollowUp(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note first.');
      return;
    }
    // Two different acts, and calling both "follow-up" made the second one confusing: before
    // Claude has said anything you are still adding to your own note; afterwards you are
    // answering it.
    const answered = !!note.sent;
    const text = await vscode.window.showInputBox({
      prompt: `Follow-up on #${note.seq} — ${firstLine(note.body, 60)}`,
      placeHolder: answered
        ? 'Answer its question, or say what it got wrong…'
        : 'Extra context, a correction, a narrowing…',
      ignoreFocusOut: true,
    });
    if (text?.trim()) store.update(note.id, { addenda: [...note.addenda, text.trim()] });
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
        if (choice === 'Undo') store.reinstate([note]);
      });
  }

  function toggleDone(arg: unknown): void {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: no note selected.');
      return;
    }
    const done = !note.done;
    const patch: Partial<ReviewNote> = { done };

    // Marking a note done settles the conversation with it.
    //
    // A follow-up you typed and never sent otherwise keeps the note live for ever: the card
    // could not collapse, the status went on reading "follow-up not sent", and pressing done
    // looked like it did nothing. Deciding you are finished is exactly the case where an
    // unsent turn stops mattering — it stays in the thread, it just no longer counts as owed.
    if (done && note.sent) {
      patch.sent = { ...note.sent, addendaAtSend: note.addenda.length };
    }
    store.update(note.id, patch);
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

  // ── suggestions ──────────────────────────────────────────────────────

  async function addSuggestion(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note first.');
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: 'Suggested replacement for these lines (empty removes the suggestion)',
      value: note.suggestion ?? note.anchor.snippet,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    store.update(note.id, { suggestion: value.length ? value : undefined });
  }

  /** Apply the suggestion to the file directly — no agent round-trip. */
  async function applySuggestion(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note?.suggestion) {
      void vscode.window.showInformationMessage('Redline: this note has no suggested change.');
      return;
    }
    const uri = uriForNote(note.path, note.workspaceFolder);
    if (!uri) return;
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      void vscode.window.showWarningMessage(`Redline: cannot open ${note.path}.`);
      return;
    }
    let range = note.range;
    const resolved = resolveAnchor(doc.getText(), note.anchor);
    if (resolved) range = resolved.range;
    else if (note.anchor.orphaned) {
      void vscode.window.showWarningMessage('Redline: the original code could not be found — re-anchor the note first.');
      return;
    }
    const endLine = Math.min(range.endLine, Math.max(doc.lineCount - 1, 0));
    const target = new vscode.Range(range.startLine, 0, endLine, doc.lineAt(endLine).text.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, target, note.suggestion);
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showWarningMessage('Redline: could not apply the suggestion.');
      return;
    }
    store.update(note.id, { done: true });
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    void vscode.window.setStatusBarMessage(`Redline: applied the suggestion of #${note.seq} (⌘Z in the file to undo)`, 4000);
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
    const updated = store.getById(note.id);
    if (updated) host.ensureThread(updated, ed.document.uri);
  }

  /** "That isn't what I meant": a new note at the same spot, for the next round. */
  async function reviseNote(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) return;
    const uri = uriForNote(note.path, note.workspaceFolder);
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    let range = note.range;
    const resolved = resolveAnchor(doc.getText(), note.anchor);
    if (resolved) range = resolved.range;
    const seed = `Re #${note.seq}: not quite — `;
    const body = await vscode.window.showInputBox({
      prompt: `Revision of #${note.seq}`,
      value: seed,
      valueSelection: [seed.length, seed.length],
      ignoreFocusOut: true,
    });
    if (!body?.trim()) return;
    const created = await createNoteAt(
      uri,
      new vscode.Range(range.startLine, 0, range.endLine, 0),
      body.trim(),
      note.kind === 'question' ? 'question' : 'comment',
    );
    if (created) void vscode.window.setStatusBarMessage(`Redline: #${created.seq} added for the next round`, 3000);
  }

  return {
    createNote,
    quickAddNote,
    createNoteAt,
    editComment,
    saveComment,
    cancelEdit,
    cancelReply,
    addFollowUp,
    followUpHere,
    approveNote,
    needsWork,
    replyToNote,
    deleteNote,
    toggleDone,
    setKind,
    kindChange: quickKind('comment'),
    kindBug: quickKind('bug'),
    kindSecurity: quickKind('security'),
    kindPerf: quickKind('perf'),
    kindIdea: quickKind('idea'),
    kindRefactor: quickKind('refactor'),
    kindQuestion: quickKind('question'),
    kindTodo: quickKind('todo'),
    kindNit: quickKind('nit'),
    kindPraise: quickKind('praise'),
    addSuggestion,
    applySuggestion,
    revealNote,
    reanchorNote,
    reviseNote,
  };
}

export type NoteCommands = ReturnType<typeof noteCommands>;
