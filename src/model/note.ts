/**
 * Core data model. This module must stay free of `vscode` imports so that the store,
 * anchor and export layers are unit-testable without an extension host.
 */

export const NOTE_KINDS = [
  'comment',
  'bug',
  'nit',
  'question',
  'refactor',
  'perf',
  'security',
  'todo',
  'praise',
  'idea',
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value);
}

export interface KindMeta {
  /**
   * The kind's own colour, used for its icon on a card.
   *
   * Fixed rather than themed: a kind is recognised by its colour before its shape at 13px, and
   * ten of them have to stay apart from each other, which a theme's palette does not promise.
   */
  color: string;
  /** Emoji used in markdown output and the inline badge. */
  icon: string;
  /** Codicon id used for ThemeIcon. */
  themeIcon: string;
  /** Display order, shared by the widget toolbar, the kind picker and the panel menu. */
  weight: number;
  /** Human label. */
  label: string;
  /** One-line explanation shown in the picker. */
  description: string;
}

export const KIND_META: Record<NoteKind, KindMeta> = {
  comment: { icon: '💬', themeIcon: 'request-changes', color: '#e0894a', weight: 1, label: 'change request', description: 'Change this the way I describe' },
  bug: { icon: '🐞', themeIcon: 'bug', color: '#e08d8d', weight: 2, label: 'bug', description: 'Something is wrong — fix it' },
  security: { icon: '🔒', themeIcon: 'shield', color: '#d9b169', weight: 3, label: 'security', description: 'Vulnerability or unsafe handling of data' },
  perf: { icon: '⚡', themeIcon: 'dashboard', color: '#d9c46a', weight: 4, label: 'perf', description: 'Too slow, too much work, too much memory' },
  idea: { icon: '💡', themeIcon: 'lightbulb', color: '#a8c97f', weight: 5, label: 'idea', description: 'Improve / extend this — build on what is here' },
  refactor: { icon: '🔧', themeIcon: 'wrench', color: '#7fc4b8', weight: 6, label: 'refactor', description: 'Same behaviour, better structure' },
  question: { icon: '💭', themeIcon: 'question', color: '#8ab4d8', weight: 7, label: 'question', description: 'Explain this to me before changing anything' },
  todo: { icon: '📌', themeIcon: 'checklist', color: '#a99bd6', weight: 8, label: 'todo', description: 'Follow-up work, can be done later' },
  nit: { icon: '✂️', themeIcon: 'edit', color: '#9a9793', weight: 9, label: 'nit', description: 'Tiny thing: naming, formatting, style' },
  praise: { icon: '✨', themeIcon: 'heart', color: '#d89ab4', weight: 10, label: 'praise', description: 'This is good — keep it (no action)' },
};

/** Kinds ordered by output weight. */
export const KINDS_BY_WEIGHT: readonly NoteKind[] = [...NOTE_KINDS].sort(
  (a, b) => KIND_META[a].weight - KIND_META[b].weight,
);

export interface SerialRange {
  /** 0-based, matches vscode.Position. */
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface NoteAnchor {
  /** Exact text of the anchored lines at creation time. */
  snippet: string;
  /** sha1 of `snippet` after whitespace normalisation. */
  snippetHash: string;
  /** Up to 3 lines above/below, used for disambiguation when snippet repeats. */
  contextBefore: string[];
  contextAfter: string[];
  /** Line where it was last successfully resolved — the search starting point. */
  lineHint: number;
  /** Set when resolution failed: the snippet could not be found in the file any more. */
  orphaned?: boolean;
}

export interface GitSnapshot {
  branch?: string;
  sha?: string;
  dirty?: boolean;
}

export interface ReviewNote {
  id: string;
  /** Stable, human-facing sequence number (`#12`), unique per workspace. */
  seq: number;
  /** Workspace-folder-relative posix path. */
  path: string;
  /** Name of the workspace folder (multi-root disambiguation). */
  workspaceFolder?: string;
  /** Language id of the document at creation time (for snippet fences). */
  languageId?: string;
  range: SerialRange;
  anchor: NoteAnchor;
  /** Markdown. May be multi-paragraph. */
  body: string;
  /** Follow-up comments added inside the same thread; appended on export. */
  addenda: string[];
  kind: NoteKind;
  /** Fenced code the agent should apply verbatim at `range`. */
  suggestion?: string;
  /** Absolute paths of attached images (screenshots), stored in extension storage. */
  attachments?: string[];
  /**
   * Set when the change Claude made was turned down.
   *
   * Not derivable: "there is a follow-up after its answer" is also what asking a further
   * question looks like, and the two want different things on the card — one is waiting for
   * another attempt, the other is a conversation.
   */
  rejected?: boolean;
  done: boolean;
  /** For manual reordering. */
  order: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Git snapshot at creation, best-effort. */
  git?: GitSnapshot;
  /** Set when the note has been sent to the agent; the note stays visible until cleared. */
  sent?: {
    at: string;
    /** snippetHash at send time — compared against current code to show "changed". */
    snippetHash: string;
    /**
     * Hash of the whole file at send time. The snippet alone is not enough: an agent asked
     * to add something *near* a line leaves that line byte-identical, and the note would
     * report no change at all. Absent on notes sent before this was recorded.
     */
    fileHash?: string;
    /** SessionTarget key of the session this note went to. */
    target?: string;
    /** Filled in from the agent's report-back. */
    outcome?: 'done' | 'skipped' | 'answered';
    reply?: string;
    /**
     * How many conversation turns had been written when this was sent. Anything added since
     * is a reply the agent has not seen — which is what makes a finished note active again.
     * Absent on notes sent before this was recorded; treated as "all of them seen".
     */
    addendaAtSend?: number;
  };
}

export interface Batch {
  id: string;
  name: string;
  notes: ReviewNote[];
  createdAt: string;
  submittedAt?: string;
}

/** Input shape for `ReviewStore.add`. Everything derivable is filled in by the store. */
export interface NewNoteInput {
  path: string;
  workspaceFolder?: string;
  languageId?: string;
  range: SerialRange;
  anchor: NoteAnchor;
  body: string;
  kind?: NoteKind;
  suggestion?: string;
  git?: GitSnapshot;
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function isSingleLine(r: SerialRange): boolean {
  return r.startLine === r.endLine;
}

/** `L142` or `L142-150`, 1-based. */
export function formatLineRange(r: SerialRange): string {
  const s = r.startLine + 1;
  const e = r.endLine + 1;
  return s === e ? `L${s}` : `L${s}-${e}`;
}

export function firstLine(text: string, max = 80): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

/** Notes still waiting to be sent — what a submit picks up. */
export function isOpen(n: ReviewNote): boolean {
  return !n.done && !n.sent;
}

/** Prefix on a turn written by the agent rather than by you. */
export const AGENT_TURN_PREFIX = 'Claude:';

/** Whether a conversation turn came from the agent. */
export function isAgentTurn(turn: string): boolean {
  return turn.startsWith(AGENT_TURN_PREFIX);
}

/**
 * A follow-up *you* wrote after the last send: the agent has not seen it yet.
 *
 * This is what reopens a finished note. Only your own turns count — the agent's report is
 * stored as a turn too, so counting every turn made applying a report look like an unsent
 * follow-up, leaving a finished note permanently live and offering to send nothing.
 */
export function hasUnsentReply(n: ReviewNote): boolean {
  if (!n.sent) return false;
  const seen = n.sent.addendaAtSend ?? n.addenda.length;
  return n.addenda.slice(seen).some((turn) => !isAgentTurn(turn));
}

/**
 * Notes the panel lists above the "sent" section. Done notes belong here too: they are
 * excluded from a submit but must stay visible so they can be reopened or deleted.
 */
export function isOnDeck(n: ReviewNote): boolean {
  return !n.sent;
}

export function isSent(n: ReviewNote): boolean {
  return n.sent !== undefined;
}

/** Intent the prompt communicates to the agent, derived from the kind. */
export type Intent = 'change' | 'idea' | 'question' | 'fyi';
export function intentOf(n: ReviewNote): Intent {
  if (n.kind === 'question') return 'question';
  if (n.kind === 'idea') return 'idea';
  if (n.kind === 'praise') return 'fyi';
  return 'change';
}

export function compareByPathThenLine(a: ReviewNote, b: ReviewNote): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
  if (a.range.startChar !== b.range.startChar) return a.range.startChar - b.range.startChar;
  return a.order - b.order;
}

// ─── type guards (used by schema migration) ─────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function isSerialRange(v: unknown): v is SerialRange {
  return (
    isObj(v) &&
    typeof v['startLine'] === 'number' &&
    typeof v['startChar'] === 'number' &&
    typeof v['endLine'] === 'number' &&
    typeof v['endChar'] === 'number'
  );
}

export function isNoteAnchor(v: unknown): v is NoteAnchor {
  return (
    isObj(v) &&
    typeof v['snippet'] === 'string' &&
    typeof v['snippetHash'] === 'string' &&
    isStringArray(v['contextBefore']) &&
    isStringArray(v['contextAfter']) &&
    typeof v['lineHint'] === 'number'
  );
}

export function isReviewNote(v: unknown): v is ReviewNote {
  if (!isObj(v)) return false;
  const att = v['attachments'];
  if (att !== undefined && !isStringArray(att)) return false;
  return (
    isObj(v) &&
    typeof v['id'] === 'string' &&
    typeof v['seq'] === 'number' &&
    typeof v['path'] === 'string' &&
    isSerialRange(v['range']) &&
    isNoteAnchor(v['anchor']) &&
    typeof v['body'] === 'string' &&
    isStringArray(v['addenda']) &&
    isNoteKind(v['kind']) &&
    typeof v['done'] === 'boolean' &&
    typeof v['order'] === 'number' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['updatedAt'] === 'string'
  );
}

export function isBatch(v: unknown): v is Batch {
  return (
    isObj(v) &&
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    Array.isArray(v['notes']) &&
    typeof v['createdAt'] === 'string'
  );
}
