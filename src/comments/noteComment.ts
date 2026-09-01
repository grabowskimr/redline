import * as vscode from 'vscode';
import { AGENT_TURN_PREFIX, formatLineRange, hasUnsentReply, isAgentTurn, KIND_META, NoteKind, ReviewNote } from '../model/note';
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

/**
 * The dimmed text next to the author: where the note points, and how it is doing.
 *
 * It used to have almost nothing to say, because a widget only existed while a note was
 * unanswered — one of "sent" or nothing. Now that an answered note keeps its widget for as
 * long as its lines hold still, the answer is read here rather than on the card, and the label
 * has to carry the state that goes with it. The words are the card's own, so the two surfaces
 * never describe the same note differently.
 *
 * Two states normally cannot appear here, because both take the widget away: `done`, and an
 * orphaned anchor. `⚠ stale` below is kept for the one window where a widget outlives the
 * transition — a note that orphans while a draft is open in its box is deliberately not
 * disposed (`CommentHost.isBeingEdited`), and finishing that edit relabels it in place. Without
 * the branch the widget would sit there claiming to point at code that is gone.
 */
export function commentLabel(note: ReviewNote): string {
  const bits = [formatLineRange(note.range)];
  // An unsent reply comes first: the conversation is waiting on you to send what you just
  // wrote, which is the more useful thing to know than that it has been sent once already.
  if (hasUnsentReply(note)) bits.push('✎ follow-up not sent');
  else if (note.rejected) bits.push('turned down');
  // Claude has reported back and nobody has agreed with it yet — the same "needs approval" the
  // card shows, and the reason the answer is worth reading right here.
  else if (note.sent?.outcome) bits.push('needs approval');
  else if (note.sent?.route === 'clipboard') bits.push('on your clipboard');
  else if (note.sent?.route === 'staged') bits.push('staged');
  else if (note.sent) bits.push('sent');
  if (note.anchor.orphaned) bits.push('⚠ stale');
  return bits.join(' · ');
}

/** Just the note. Metadata lives in the author and label slots, not in the body. */
export function renderCommentBody(note: ReviewNote): vscode.MarkdownString {
  const parts: string[] = [note.body];
  // Claude's turns are stored with a "Claude:" prefix; showing who said what is the whole
  // point once a note has become a conversation.
  for (const a of note.addenda) {
    parts.push(
      '',
      isAgentTurn(a) ? `↳ **Claude:** ${a.slice(AGENT_TURN_PREFIX.length).trim()}` : `↳ **You:** ${a}`,
    );
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
