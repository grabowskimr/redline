import * as vscode from 'vscode';
import { GitContext, renderBatch, RenderOptions, SnippetSource } from './renderBatch';
import { ReviewNote } from '../model/note';
import { Config } from '../config';
import { Logger } from '../logger';
import { GitService } from '../git/gitApi';
import { ReviewRange } from '../git/reviewRange';
import { hashSnippet, resolveAnchor, snippetAt } from '../anchor/anchorService';
/**
 * The four things rendering a batch actually needs.
 *
 * Named here rather than taking the whole `Deps`, which is the commands layer's bag of
 * everything: importing it made `export/` and `commands/` point at each other, for four fields
 * out of nine. `Deps` satisfies this structurally, so callers pass it unchanged.
 */
export interface RenderDeps {
  config: Config;
  git: GitService;
  logger: Logger;
  range: ReviewRange;
}
import { deliveryToken } from '../claude/handover';
import { reportPath } from '../claude/reportFile';
import { uriForNote } from '../comments/uriMapping';

/** Reads current file text for snippet extraction: open documents first, then disk. */
export async function buildSnippetSource(notes: readonly ReviewNote[]): Promise<SnippetSource> {
  const cache = new Map<string, string | undefined>();
  await Promise.all(
    notes.map(async (n) => {
      const key = `${n.workspaceFolder ?? ''}::${n.path}`;
      if (cache.has(key)) return;
      cache.set(key, undefined);
      const uri = uriForNote(n.path, n.workspaceFolder);
      if (!uri) return;
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (open) {
        cache.set(key, open.getText());
        return;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        cache.set(key, Buffer.from(bytes).toString('utf8'));
      } catch {
        // unavailable → stored snippet is used
      }
    }),
  );
  const keyOf = (n: ReviewNote): string => `${n.workspaceFolder ?? ''}::${n.path}`;
  return {
    textFor: (n) => cache.get(keyOf(n)),
    // Looked for and not found, as opposed to never looked for.
    missing: (n) => cache.has(keyOf(n)) && cache.get(keyOf(n)) === undefined,
  };
}

/** What a note's code looked like when it was sent. */
export interface SentHashes {
  snippet: string;
  /** The containing file, so an edit *next to* the note still counts as a change. */
  file: string;
}

/**
 * Hashes of the code each note points at *right now* — what the batch actually contains.
 * Used as the sent-time reference for the ✏️ changed-since-sent badge.
 */
export async function currentHashes(notes: readonly ReviewNote[]): Promise<Map<string, SentHashes>> {
  const source = await buildSnippetSource(notes);
  const out = new Map<string, SentHashes>();
  for (const n of notes) {
    const text = source.textFor(n);
    if (text === undefined) continue;
    try {
      const resolved = resolveAnchor(text, n.anchor);
      out.set(n.id, {
        snippet: hashSnippet(snippetAt(text, resolved ? resolved.range : n.range)),
        file: hashSnippet(text),
      });
    } catch {
      // fall back to the anchor hash via markSent's default
    }
  }
  return out;
}

export async function gitContext(deps: RenderDeps, notes: readonly ReviewNote[]): Promise<GitContext | undefined> {
  if (!deps.config.includeGitContext) return undefined;
  const first = notes[0];
  const uri = first ? uriForNote(first.path, first.workspaceFolder) : vscode.workspace.workspaceFolders?.[0]?.uri;
  return deps.git.context(uri).catch(() => undefined);
}

export async function renderNotes(
  deps: RenderDeps,
  notes: readonly ReviewNote[],
  extra: Partial<RenderOptions> = {},
): Promise<string> {
  const source = await buildSnippetSource(notes);
  const git = await gitContext(deps, notes);
  const opts: RenderOptions = { config: deps.config.renderConfig(), source, ...extra };
  if (git) opts.git = git;
  // Only worth asking for when the plugin is here to have written the directory: the path is
  // its state directory, and pointing at one that does not exist invites a mkdir nobody asked
  // for. An explicit value wins, so a caller can suppress it.
  if (opts.reportPath === undefined) {
    const root = await deps.range.repoRoot();
    if (root && (await deliveryToken(root)) !== undefined) opts.reportPath = reportPath(root);
  }
  return renderBatch(notes, opts);
}

/** Write to the clipboard and verify by reading back. Falls back to an untitled document. */
export async function copyToClipboard(deps: RenderDeps, text: string): Promise<boolean> {
  try {
    await vscode.env.clipboard.writeText(text);
    const back = await vscode.env.clipboard.readText();
    // Some clipboards (Windows) normalise line endings; compare modulo CRLF.
    if (back.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n')) return true;
    deps.logger.warn('clipboard read-back mismatch');
  } catch (err) {
    deps.logger.error('clipboard write failed', err);
  }
  const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showWarningMessage(
    'Redline: could not write to the clipboard. The batch has been opened in a new document instead — copy it from there.',
  );
  return false;
}

export async function openPreview(text: string, language = 'markdown'): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument({ content: text, language });
  return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}
