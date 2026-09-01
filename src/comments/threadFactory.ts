import * as vscode from 'vscode';
import { firstLine, KIND_META, ReviewNote, SerialRange } from '../model/note';
import { NoteComment, THREAD_CONTEXT } from './noteComment';

export function toRange(r: SerialRange): vscode.Range {
  return new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar);
}

export function fromRange(r: vscode.Range): SerialRange {
  return { startLine: r.start.line, startChar: r.start.character, endLine: r.end.line, endChar: r.end.character };
}

/**
 * Apply a note's current state to an existing thread, in place.
 *
 * The widget never takes a reply. A follow-up is written on the card, where the note, the
 * answer and the actions already are — the widget offering one too meant two boxes asking for
 * the same thing, in two places, one of which had to steal the editor's focus to be used.
 */
export function applyNoteToThread(thread: vscode.CommentThread, note: ReviewNote): void {
  thread.comments = [new NoteComment(note.id, note)];
  // The header is what a collapsed thread shows, so it has to say something on its own —
  // but it must not simply repeat the body, which sits right underneath when expanded.
  // Plain text only: a thread label is not rendered as markdown, so an icon would have to
  // be an emoji — and the widget already shows the kind's codicon next to the author.
  const kind = note.kind === 'comment' ? 'note' : KIND_META[note.kind].label;
  thread.label = `#${note.seq} · ${kind} · ${firstLine(note.body, 48)}`;
  // Always unresolved. An answer is not the end of a note — it is the point at which someone
  // has to agree with it — and a note you have settled has no widget at all, so nothing that
  // reaches here is ever a resolved thread to style.
  thread.state = vscode.CommentThreadState.Unresolved;
  thread.contextValue = THREAD_CONTEXT;
  /*
   * A reply bar, but only once there is something to reply to.
   *
   * It was off everywhere, because a widget disappeared the moment Claude answered and a reply
   * box in it was a second place asking for the same follow-up. The widget stays now, and
   * reading an answer against the code it is about is exactly when you want to write back.
   *
   * Still off on a note nobody has sent: the editor re-renders a thread it has not been told
   * otherwise about, so on a brand-new note this is a box that flashes into view before the
   * note is even saved. Nothing to continue there — the note itself is the message.
   */
  thread.canReply = !!note.sent;
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
