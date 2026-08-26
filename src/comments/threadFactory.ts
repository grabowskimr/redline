import * as vscode from 'vscode';
import { firstLine, KIND_META, ReviewNote, SerialRange } from '../model/note';
import { NoteComment, THREAD_CONTEXT } from './noteComment';

export function toRange(r: SerialRange): vscode.Range {
  return new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar);
}

export function fromRange(r: vscode.Range): SerialRange {
  return { startLine: r.start.line, startChar: r.start.character, endLine: r.end.line, endChar: r.end.character };
}

/** Apply a note's current state to an existing thread, in place. */
export function applyNoteToThread(thread: vscode.CommentThread, note: ReviewNote): void {
  thread.comments = [new NoteComment(note.id, note)];
  // The header is what a collapsed thread shows, so it has to say something on its own —
  // but it must not simply repeat the body, which sits right underneath when expanded.
  // Plain text only: a thread label is not rendered as markdown, so an icon would have to
  // be an emoji — and the widget already shows the kind's codicon next to the author.
  const kind = note.kind === 'comment' ? 'note' : KIND_META[note.kind].label;
  thread.label = `#${note.seq} · ${kind} · ${firstLine(note.body, 48)}`;
  // Done notes take the resolved styling; open ones keep the accent border.
  thread.state = note.done || note.sent?.outcome === 'done'
    ? vscode.CommentThreadState.Resolved
    : vscode.CommentThreadState.Unresolved;
  thread.contextValue = THREAD_CONTEXT;
  // No reply box once the note has been sent or parked — nothing more to add there.
  // Follow-ups come from the panel or the thread menu; the native reply field stays off.
  thread.canReply = false;
  const r = toRange(note.range);
  if (!thread.range || !thread.range.isEqual(r)) thread.range = r;
}

export function createThread(
  controller: vscode.CommentController,
  uri: vscode.Uri,
  note: ReviewNote,
): vscode.CommentThread {
  const thread = controller.createCommentThread(uri, toRange(note.range), []);
  // Do not touch `collapsibleState` here: the main thread defaults to Collapsed, and setting
  // it during creation trips a setter loop in VS Code ≥ 1.13x.
  applyNoteToThread(thread, note);
  return thread;
}
