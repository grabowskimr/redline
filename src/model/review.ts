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

export type ReviewScope = 'recent' | 'unreviewed';
export interface ReviewContext {
  root: string;
  scope: ReviewScope;
  label: string;
  files: string[];
  before?: string;
  after?: string;
}
