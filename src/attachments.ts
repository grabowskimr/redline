import * as vscode from 'vscode';
import * as path from 'node:path';
import { Logger } from './logger';
import { ReviewStore } from './store/reviewStore';
import { isImagePath } from './dnd/dropPayload';

const MAX_BYTES = 20 * 1024 * 1024;
/** One drop should not queue hundreds of file reads. */
const MAX_DROPPED_FILES = 20;
const ALLOWED = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff']);

/** Screenshots attached to notes, stored in extension storage (never in the repo). */
export class Attachments {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReviewStore,
    private readonly logger: Logger,
  ) {}

  get dir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, 'attachments');
  }

  /** Persist image bytes for a note; returns the stored absolute path, or undefined. */
  async add(noteId: string, fileName: string, bytes: Uint8Array): Promise<string | undefined> {
    const note = this.store.getById(noteId);
    if (!note) return undefined;
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
      void vscode.window.showWarningMessage(
        `Redline: image is ${bytes.byteLength === 0 ? 'empty' : 'larger than 20 MB'} — not attached.`,
      );
      return undefined;
    }
    // A capture tool can hand over a name with no extension at all; default to png rather
    // than refusing a file the panel already accepted.
    const ext = (fileName.includes('.') ? (fileName.split('.').pop() ?? 'png') : 'png').toLowerCase();
    if (!ALLOWED.has(ext)) {
      void vscode.window.showWarningMessage(`Redline: only images can be attached (got .${ext}).`);
      return undefined;
    }
    const safeBase = (fileName.split('/').pop() ?? 'image')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w.-]+/g, '-')
      .slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = vscode.Uri.joinPath(this.dir, `${note.seq}-${stamp}-${safeBase}.${ext}`);
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(target, bytes);
    this.store.update(noteId, {
      attachments: [...(note.attachments ?? []), target.fsPath],
      // Recorded now, because after the next turn there is no way back to it.
      attachmentTurns: [...(note.attachmentTurns ?? []), note.addenda.length],
    });
    this.logger.info(`attached ${target.fsPath} to #${note.seq}`);
    return target.fsPath;
  }

  /**
   * Attach files the user dropped onto a card. Paths arrive from the webview as data, so
   * every one is validated here: images only, files only, size checked before reading (a
   * dropped video must not be pulled into memory just to be rejected).
   */
  async addFromPaths(noteId: string, paths: readonly string[]): Promise<string[]> {
    if (!this.store.getById(noteId)) return [];
    const stored: string[] = [];
    const rejected: string[] = [];
    for (const p of paths.slice(0, MAX_DROPPED_FILES)) {
      const name = path.basename(p);
      if (!isImagePath(p)) {
        rejected.push(`${name} (not an image)`);
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(p));
        if (stat.type & vscode.FileType.Directory) {
          rejected.push(`${name} (folder)`);
          continue;
        }
        if (stat.size > MAX_BYTES) {
          rejected.push(`${name} (larger than 20 MB)`);
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
        const saved = await this.add(noteId, name, bytes);
        if (saved) stored.push(saved);
        else rejected.push(name);
      } catch (err) {
        this.logger.warn(`could not read dropped file ${p}`, err);
        rejected.push(`${name} (unreadable)`);
      }
    }
    if (paths.length > MAX_DROPPED_FILES) {
      rejected.push(`${paths.length - MAX_DROPPED_FILES} more not attached`);
    }
    if (rejected.length > 0) {
      void vscode.window.showWarningMessage(`Redline: skipped ${rejected.join(', ')}.`);
    }
    return stored;
  }

  /** Attach via file-picker (the 📎 button / command). */
  async pick(noteId: string): Promise<void> {
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: [...ALLOWED] },
      openLabel: 'Attach to note',
    });
    for (const uri of chosen ?? []) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      await this.add(noteId, path.basename(uri.fsPath), bytes);
    }
  }

  async remove(noteId: string, fsPath: string): Promise<void> {
    const note = this.store.getById(noteId);
    if (!note) return;
    // Only detach paths that are actually on this note — the webview message is data,
    // not a trusted instruction to delete an arbitrary file.
    const paths = note.attachments ?? [];
    const at = paths.indexOf(fsPath);
    if (at < 0) return;
    // Both arrays, by index. Filtering only the paths would shift every turn after this one
    // onto the wrong attachment, and the card would start captioning them wrongly.
    const turns = note.attachmentTurns ?? [];
    this.store.update(noteId, {
      attachments: paths.filter((_, i) => i !== at),
      ...(turns.length === paths.length ? { attachmentTurns: turns.filter((_, i) => i !== at) } : {}),
    });
    // Delete the file only if we own it and no other (e.g. archived) note references it.
    if (!fsPath.startsWith(this.dir.fsPath)) return;
    const stillReferenced =
      this.store.notes.some((n) => n.attachments?.includes(fsPath)) ||
      this.store.archive.some((b) => b.notes.some((n) => n.attachments?.includes(fsPath)));
    if (stillReferenced) return;
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(fsPath));
    } catch {
      // already gone
    }
  }

  /** Delete stored files no note (active or archived) references any more. */
  async cleanupOrphans(): Promise<void> {
    try {
      const referenced = new Set<string>();
      const collect = (notes: readonly { attachments?: string[] }[]): void => {
        for (const n of notes) for (const a of n.attachments ?? []) referenced.add(a);
      };
      collect(this.store.notes);
      for (const b of this.store.archive) collect(b.notes);
      const entries = await vscode.workspace.fs.readDirectory(this.dir).then(
        (e) => e,
        () => [] as [string, vscode.FileType][],
      );
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) continue;
        const full = vscode.Uri.joinPath(this.dir, name);
        if (!referenced.has(full.fsPath)) await vscode.workspace.fs.delete(full);
      }
    } catch (err) {
      this.logger.warn('attachment cleanup failed', err);
    }
  }
}
