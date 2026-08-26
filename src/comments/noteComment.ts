import * as vscode from 'vscode';
import { formatLineRange, hasUnsentReply, KIND_META, NoteKind, ReviewNote } from '../model/note';
import { fenceFor } from '../export/renderBatch';
import { KIND_GLYPH } from '../model/kindGlyphs';

export const COMMENT_CONTEXT = 'redline.comment';
export const THREAD_CONTEXT = 'redline.note';

/** Claude brand orange, used when a kind has no colour of its own. */
const ACCENT = '#D97757';

const KIND_COLOR: Partial<Record<NoteKind, string>> = {
  bug: '#F14C4C',
  security: '#F14C4C',
  perf: '#E8A33D',
  question: '#3794FF',
  idea: '#E5C07B',
  praise: '#89D185',
  nit: '#C586C0',
  todo: '#C586C0',
  refactor: '#C586C0',
};

/**
 * The kind's codicon, in the kind's colour, drawn where the author's avatar would go —
 * the same glyph the widget toolbar and the panel use.
 */
function avatar(kind: NoteKind): vscode.Uri {
  const color = KIND_COLOR[kind] ?? ACCENT;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="${color}">` +
    `${KIND_GLYPH[kind]}</svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/** `#4 · bug`, with the kind's codicon as the avatar — no "You", no stray emoji. */
export function authorFor(note: ReviewNote): vscode.CommentAuthorInformation {
  const name = note.kind === 'comment' ? `#${note.seq}` : `#${note.seq} · ${KIND_META[note.kind].label}`;
  return { name, iconPath: avatar(note.kind) };
}

/** The dimmed text next to the author: where the note points, and how it is doing. */
export function commentLabel(note: ReviewNote): string {
  const bits = [formatLineRange(note.range)];
  // An unsent reply comes first: the note may say "done", but the conversation is waiting on
  // you to send what you just wrote, and that is the more useful thing to know.
  if (hasUnsentReply(note)) bits.push('✎ reply not sent');
  else if (note.sent?.outcome === 'done') bits.push('✅ done');
  else if (note.sent?.outcome === 'skipped') bits.push('⛔ skipped');
  else if (note.sent) bits.push('sent');
  else if (note.done) bits.push('✓ done');
  if (note.anchor.orphaned) bits.push('⚠ stale');
  return bits.join(' · ');
}

/** Just the note. Metadata lives in the author and label slots, not in the body. */
export function renderCommentBody(note: ReviewNote): vscode.MarkdownString {
  const parts: string[] = [note.body];
  // Claude's turns are stored with a "Claude:" prefix; showing who said what is the whole
  // point once a note has become a conversation.
  for (const a of note.addenda) {
    const fromAgent = a.startsWith('Claude:');
    parts.push('', fromAgent ? `↳ **Claude:** ${a.slice('Claude:'.length).trim()}` : `↳ **You:** ${a}`);
  }
  if (note.suggestion !== undefined) {
    const fence = fenceFor(note.suggestion);
    parts.push('', '**Suggested change**', '', `${fence}${note.languageId ?? ''}`, note.suggestion, fence);
  }
  const shots = note.attachments ?? [];
  if (shots.length) {
    parts.push('', `📎 ${shots.length} screenshot${shots.length === 1 ? '' : 's'} attached`);
  }
  const md = new vscode.MarkdownString(parts.join('\n'));
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

export class NoteComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue = COMMENT_CONTEXT;

  /** Body text prior to entering edit mode, restored on cancel. */
  savedBody: string;

  constructor(
    public readonly noteId: string,
    note: ReviewNote,
  ) {
    this.body = renderCommentBody(note);
    this.savedBody = note.body;
    this.author = authorFor(note);
    this.label = commentLabel(note);
    // No timestamp: "now" next to a note you just wrote is noise, and the panel already
    // carries the history.
  }

  /** Switch to editing: the body becomes raw markdown so the textarea shows it. */
  beginEdit(note: ReviewNote): void {
    this.savedBody = note.body;
    this.body = note.body;
    this.mode = vscode.CommentMode.Editing;
  }

  endEdit(note: ReviewNote): void {
    this.body = renderCommentBody(note);
    this.author = authorFor(note);
    this.label = commentLabel(note);
    this.mode = vscode.CommentMode.Preview;
  }

  /** Raw text currently in the editor textarea (VS Code writes it back into `body`). */
  editedText(): string {
    return typeof this.body === 'string' ? this.body : this.body.value;
  }
}

export function isNoteComment(v: unknown): v is NoteComment {
  return v instanceof NoteComment;
}
