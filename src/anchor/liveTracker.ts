import * as vscode from 'vscode';
import * as path from 'node:path';
import { Logger } from '../logger';
import { ReviewNote, SerialRange } from '../model/note';
import { ReviewStore } from '../store/reviewStore';
import { CommentHost } from '../comments/commentHost';
import { NoteIndex } from '../view/noteIndex';
import { locationForUri, noteKey, uriForNote } from '../comments/uriMapping';
import { createAnchor, hashSnippet, resolveAnchor, snippetAt } from './anchorService';

const REANCHOR_DEBOUNCE_MS = 500;
const WATCHER_THROTTLE_MS = 400;

/**
 * Keeps note ranges correct while files change:
 *  - live edits in open editors (range transforms + debounced re-anchor of dirty notes),
 *  - external changes on disk (Claude Code editing the file) via a FileSystemWatcher,
 *  - renames / deletes.
 * Never deletes a note: failures mark it orphaned.
 */
export class LiveTracker implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  /** Dirty note ids per document (keyed by uri string). */
  private readonly dirty = new Map<string, Set<string>>();
  private readonly reanchorTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingUris = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: ReviewStore,
    private readonly host: CommentHost,
    private readonly index: NoteIndex,
    private readonly logger: Logger,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', true, false, false);
    this.subs.push(
      watcher,
      watcher.onDidChange((uri) => this.onExternalChange(uri)),
      watcher.onDidDelete((uri) => this.onDeleted([uri])),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.workspace.onDidOpenTextDocument((d) => this.resolveDocument(d)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
      vscode.workspace.onDidRenameFiles((e) => this.onRenamed(e)),
      vscode.workspace.onDidDeleteFiles((e) => this.onDeleted(e.files)),
    );
    // Resolve everything already open.
    for (const d of vscode.workspace.textDocuments) this.resolveDocument(d);
  }

  // ─── live edits ─────────────────────────────────────────────────────────

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    const notes = this.notesFor(e.document.uri);
    if (notes.length === 0) return;
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    const docKey = e.document.uri.toString();
    const markDirty = (id: string): void => {
      const set = this.dirty.get(docKey) ?? new Set<string>();
      set.add(id);
      this.dirty.set(docKey, set);
    };
    for (const note of notes) {
      if (note.anchor.orphaned) continue;
      // If a thread exists VS Code already moves thread.range; treat it as authoritative.
      const thread = this.host.threadFor(note.id);
      if (thread?.range && thread.uri.toString() === docKey) {
        const r = thread.range;
        if (r.start.line !== note.range.startLine || r.end.line !== note.range.endLine) {
          patches.push({
            id: note.id,
            patch: {
              range: { startLine: r.start.line, startChar: r.start.character, endLine: r.end.line, endChar: r.end.character },
              anchor: { ...note.anchor, lineHint: r.start.line },
            },
          });
        }
        if (overlapsAny(e.contentChanges, note.range)) markDirty(note.id);
        continue;
      }
      let range = note.range;
      let touched = false;
      // Apply changes in reverse document order so earlier offsets stay valid.
      const changes = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start));
      for (const c of changes) {
        const linesDelta = countLines(c.text) - (c.range.end.line - c.range.start.line);
        if (c.range.end.line < range.startLine || (c.range.end.line === range.startLine && c.range.end.character === 0 && c.range.start.line < range.startLine)) {
          range = { ...range, startLine: range.startLine + linesDelta, endLine: range.endLine + linesDelta };
        } else if (c.range.start.line <= range.endLine && c.range.end.line >= range.startLine) {
          touched = true;
        }
      }
      if (touched) markDirty(note.id);
      else if (range !== note.range) {
        patches.push({ id: note.id, patch: { range, anchor: { ...note.anchor, lineHint: range.startLine } } });
      }
    }
    if (patches.length) this.store.updateMany(patches);
    if (this.dirty.has(docKey)) this.scheduleReanchor(e.document);
  }

  private scheduleReanchor(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.reanchorTimers.get(key);
    if (existing) clearTimeout(existing);
    this.reanchorTimers.set(
      key,
      setTimeout(() => {
        this.reanchorTimers.delete(key);
        const ids = [...(this.dirty.get(key) ?? [])];
        this.dirty.delete(key);
        if (!document.isClosed) this.refreshSnippets(document, ids);
      }, REANCHOR_DEBOUNCE_MS),
    );
  }

  /**
   * Notes whose anchored lines were edited. Two cases:
   *  - the note has a live thread in this editor → VS Code tracked the range through the edit,
   *    so the note is about *these lines* now: refresh the stored snippet from the thread range;
   *  - no thread → we only know the old range is unreliable: re-resolve the original anchor
   *    against the new text, and orphan on failure. Never overwrite the anchor with guesswork.
   */
  private refreshSnippets(document: vscode.TextDocument, ids: string[]): void {
    const text = document.getText();
    const docKey = document.uri.toString();
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    for (const id of ids) {
      const note = this.store.getById(id);
      if (!note || note.anchor.orphaned) continue;
      const thread = this.host.threadFor(id);
      if (thread?.range && thread.uri.toString() === docKey && thread.range.end.line < document.lineCount) {
        const range: SerialRange = {
          startLine: thread.range.start.line,
          startChar: thread.range.start.character,
          endLine: thread.range.end.line,
          endChar: thread.range.end.character,
        };
        const current = snippetAt(text, range);
        if (current.trim().length > 0) {
          patches.push({ id, patch: { range, anchor: createAnchor(text, range) } });
          continue;
        }
      }
      const resolved = resolveAnchor(text, note.anchor);
      if (resolved) {
        const fresh = createAnchor(text, resolved.range);
        patches.push({
          id,
          patch: {
            range: resolved.range,
            anchor: { ...note.anchor, contextBefore: fresh.contextBefore, contextAfter: fresh.contextAfter, lineHint: resolved.range.startLine },
          },
        });
      } else {
        patches.push({ id, patch: { anchor: { ...note.anchor, orphaned: true } } });
        this.logger.info(`note ${id} orphaned after edit in ${note.path}`);
      }
    }
    if (patches.length) this.store.updateMany(patches);
  }

  private onSave(document: vscode.TextDocument): void {
    this.host.reconcileRanges(document.uri);
    // A save produces a watcher event too; mark it handled by resolving now.
    this.resolveDocument(document);
  }

  // ─── external changes ───────────────────────────────────────────────────

  private onExternalChange(uri: vscode.Uri): void {
    if (this.notesFor(uri).length === 0) return;
    const key = uri.toString();
    const existing = this.pendingUris.get(key);
    if (existing) clearTimeout(existing);
    this.pendingUris.set(
      key,
      setTimeout(() => {
        this.pendingUris.delete(key);
        void this.resolveUri(uri);
      }, WATCHER_THROTTLE_MS),
    );
  }

  private async resolveUri(uri: vscode.Uri): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      // VS Code reloads the buffer for non-dirty docs; its change events drive the threads.
      // Still run content resolution so closed-thread notes are fixed too.
      this.resolveText(uri, open.getText());
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.resolveText(uri, Buffer.from(bytes).toString('utf8'));
    } catch (err) {
      this.logger.warn(`could not read ${uri.fsPath} for re-anchoring`, err);
    }
  }

  resolveDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') return;
    this.resolveText(document.uri, document.getText());
  }

  /** Re-resolve every note in the file against `text`. Public so commands can force it. */
  resolveText(uri: vscode.Uri, text: string): void {
    const notes = this.notesFor(uri);
    if (notes.length === 0) return;
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    const sentStatus = (note: ReviewNote, range: SerialRange | undefined, orphaned: boolean): void => {
      if (!note.sent) {
        this.index.clearChangedSinceSent(note.id);
        return;
      }
      // The file hash catches an edit *beside* the note — an agent told to add a comment
      // above a line leaves that line untouched, which the snippet check cannot see.
      const fileChanged = note.sent.fileHash !== undefined && hashSnippet(text) !== note.sent.fileHash;
      const snippetChanged =
        orphaned || !range ? true : hashSnippet(snippetAt(text, range)) !== note.sent.snippetHash;
      this.index.setChangedSinceSent(note.id, fileChanged || snippetChanged);
    };
    for (const note of notes) {
      let resolved: ReturnType<typeof resolveAnchor>;
      try {
        resolved = resolveAnchor(text, note.anchor);
      } catch (err) {
        this.logger.warn(`resolve failed for note ${note.id}`, err);
        continue;
      }
      if (resolved) {
        sentStatus(note, resolved.range, false);
        const moved =
          resolved.range.startLine !== note.range.startLine ||
          resolved.range.endLine !== note.range.endLine ||
          note.anchor.orphaned;
        if (!moved) continue;
        // Keep the stored snippet (it's the user's reference) but refresh context + hint.
        const fresh = createAnchor(text, resolved.range);
        patches.push({
          id: note.id,
          patch: {
            range: resolved.range,
            anchor: { ...note.anchor, contextBefore: fresh.contextBefore, contextAfter: fresh.contextAfter, lineHint: resolved.range.startLine, orphaned: false },
          },
        });
        this.logger.trace(`re-anchored ${note.id} via ${resolved.method} → L${resolved.range.startLine + 1}`);
      } else {
        sentStatus(note, undefined, true);
        if (!note.anchor.orphaned) {
          patches.push({ id: note.id, patch: { anchor: { ...note.anchor, orphaned: true } } });
          this.logger.info(`note ${note.id} orphaned in ${note.path}`);
        }
      }
    }
    if (patches.length) this.store.updateMany(patches);
  }

  // ─── rename / delete ────────────────────────────────────────────────────

  private onRenamed(e: vscode.FileRenameEvent): void {
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    for (const { oldUri, newUri } of e.files) {
      const oldLoc = locationForUri(oldUri);
      const newLoc = locationForUri(newUri);
      if (!oldLoc || !newLoc) continue;
      const oldKey = noteKey(oldLoc.path, oldLoc.workspaceFolder);
      for (const note of this.store.notes) {
        const key = noteKey(note.path, note.workspaceFolder);
        if (key === oldKey) {
          patches.push({ id: note.id, patch: { path: newLoc.path, workspaceFolder: newLoc.workspaceFolder } });
        } else if (note.path.startsWith(oldLoc.path + '/') && note.workspaceFolder === oldLoc.workspaceFolder) {
          // Directory rename.
          const rel = note.path.slice(oldLoc.path.length + 1);
          patches.push({ id: note.id, patch: { path: path.posix.join(newLoc.path, rel), workspaceFolder: newLoc.workspaceFolder } });
        }
      }
    }
    if (patches.length) this.store.updateMany(patches);
  }

  private onDeleted(uris: readonly vscode.Uri[]): void {
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    for (const uri of uris) {
      const loc = locationForUri(uri);
      if (!loc) continue;
      const key = noteKey(loc.path, loc.workspaceFolder);
      for (const note of this.store.notes) {
        const same = noteKey(note.path, note.workspaceFolder) === key;
        const inside = note.workspaceFolder === loc.workspaceFolder && note.path.startsWith(loc.path + '/');
        if ((same || inside) && !note.anchor.orphaned) {
          patches.push({ id: note.id, patch: { anchor: { ...note.anchor, orphaned: true } } });
        }
      }
    }
    if (patches.length) this.store.updateMany(patches);
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private notesFor(uri: vscode.Uri): ReviewNote[] {
    const loc = locationForUri(uri);
    if (!loc) return [];
    const key = noteKey(loc.path, loc.workspaceFolder);
    return this.store.notes.filter((n) => noteKey(n.path, n.workspaceFolder) === key);
  }

  /** Resolve all notes whose files are not open (used after restore / on activation). */
  async resolveAll(): Promise<void> {
    const seen = new Set<string>();
    for (const note of this.store.notes) {
      const key = noteKey(note.path, note.workspaceFolder);
      if (seen.has(key)) continue;
      seen.add(key);
      const uri = uriForNote(note.path, note.workspaceFolder);
      if (uri) await this.resolveUri(uri);
    }
  }

  dispose(): void {
    for (const t of this.reanchorTimers.values()) clearTimeout(t);
    for (const t of this.pendingUris.values()) clearTimeout(t);
    for (const s of this.subs) s.dispose();
  }
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function overlapsAny(changes: readonly vscode.TextDocumentContentChangeEvent[], r: SerialRange): boolean {
  return changes.some((c) => c.range.start.line <= r.endLine && c.range.end.line >= r.startLine);
}
