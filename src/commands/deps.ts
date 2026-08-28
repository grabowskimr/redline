import * as vscode from 'vscode';
import { Config } from '../config';
import { Logger } from '../logger';
import { ReviewStore } from '../store/reviewStore';
import { CommentHost } from '../comments/commentHost';
import { GitService } from '../git/gitApi';
import { NoteIndex } from '../view/noteIndex';
import { ReviewRange } from '../git/reviewRange';
import { SessionWatcher } from '../claude/sessionWatcher';
import { isNoteComment } from '../comments/noteComment';

export interface Deps {
  /** The hook's push channel, when it is available — used to tell whether the agent is busy. */
  signals?: { running: boolean };
  context: vscode.ExtensionContext;
  config: Config;
  logger: Logger;
  store: ReviewStore;
  host: CommentHost;
  git: GitService;
  index: NoteIndex;
  range: ReviewRange;
  watcher: SessionWatcher;
  /**
   * Send one note's whole conversation back to the agent. Assigned after the batch commands
   * exist, because a reply typed in the comment widget has to reach them and note commands
   * are built first.
   */
  replyToClaude?: (noteId: string) => Promise<void>;
}

function isThread(v: unknown): v is vscode.CommentThread {
  return typeof v === 'object' && v !== null && 'comments' in v && 'uri' in v && 'dispose' in v;
}

function isReply(v: unknown): v is vscode.CommentReply {
  return typeof v === 'object' && v !== null && 'thread' in v && 'text' in v;
}

/**
 * Commands arrive with different arguments depending on where they were triggered: a
 * plain note id (panel), `CommentReply` (widget submit), `Comment` (comment menu),
 * `CommentThread` (thread menu), or nothing at all (command palette).
 */
export function resolveNoteId(deps: Deps, arg: unknown): string | undefined {
  if (typeof arg === 'string') return deps.store.getById(arg) ? arg : undefined;
  if (isNoteComment(arg)) return arg.noteId;
  if (isReply(arg)) return deps.host.noteIdFor(arg.thread);
  if (isThread(arg)) return deps.host.noteIdFor(arg);
  if (typeof arg === 'object' && arg !== null) {
    const id = (arg as { noteId?: unknown }).noteId;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/**
 * Resolve from the argument, else from the note under the cursor. An argument that names
 * a specific note but no longer resolves (deleted, or an external reload) yields nothing:
 * silently retargeting the cursor's note would act on the wrong note.
 */
export function resolveNoteIdOrPick(deps: Deps, arg: unknown): string | undefined {
  const direct = resolveNoteId(deps, arg);
  if (direct) return direct;
  if (arg !== undefined && arg !== null) return undefined;
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const line = ed.selection.active.line;
  const here = deps.index
    .notesForUri(ed.document.uri)
    .find((n) => n.range.startLine <= line && line <= n.range.endLine);
  return here?.id;
}
