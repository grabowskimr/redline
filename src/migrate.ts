import * as vscode from 'vscode';
import * as path from 'node:path';
import { Logger } from './logger';

/** Extension id this one was published under before the rename to Redline. */
const LEGACY_EXTENSION_ID = 'marcin.local-review';

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite absolute paths that point into the old storage directory. Attachment paths are
 * stored absolute, so they would keep resolving to the old extension's folder — which
 * `localResourceRoots` no longer allows the panel to read.
 */
function repoint(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.startsWith(from) ? to + value.slice(from.length) : value;
  if (Array.isArray(value)) return value.map((v) => repoint(v, from, to));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = repoint(v, from, to);
    return out;
  }
  return value;
}

/**
 * Carry notes over from the pre-rename extension. Workspace storage is keyed by extension
 * id, so `marcin.redline` starts with an empty directory next to the old one; without this
 * every note written before the rename would look lost.
 *
 * Runs once: it is a no-op as soon as this extension has a `notes.json` of its own.
 */
export async function migrateLegacyStorage(storage: vscode.Uri, logger: Logger): Promise<void> {
  try {
    const ours = vscode.Uri.joinPath(storage, 'notes.json');
    if (await exists(ours)) return;

    const legacyDir = vscode.Uri.file(path.join(path.dirname(storage.fsPath), LEGACY_EXTENSION_ID));
    const legacyNotes = vscode.Uri.joinPath(legacyDir, 'notes.json');
    if (!(await exists(legacyNotes))) return;

    const raw = Buffer.from(await vscode.workspace.fs.readFile(legacyNotes)).toString('utf8');
    const state = repoint(JSON.parse(raw) as unknown, legacyDir.fsPath, storage.fsPath);

    const legacyAttachments = vscode.Uri.joinPath(legacyDir, 'attachments');
    if (await exists(legacyAttachments)) {
      await vscode.workspace.fs.copy(legacyAttachments, vscode.Uri.joinPath(storage, 'attachments'), {
        overwrite: true,
      });
    }

    await vscode.workspace.fs.createDirectory(storage);
    await vscode.workspace.fs.writeFile(ours, Buffer.from(JSON.stringify(state), 'utf8'));

    const count = Array.isArray((state as { notes?: unknown[] }).notes)
      ? ((state as { notes: unknown[] }).notes.length ?? 0)
      : 0;
    logger.info(`migrated ${count} note(s) from ${legacyDir.fsPath}`);
    if (count > 0) {
      void vscode.window.showInformationMessage(
        `Redline: carried ${count} note${count === 1 ? '' : 's'} over from Local Review. You can uninstall the old extension.`,
      );
    }
  } catch (err) {
    // Never block activation over this: the worst case is starting with an empty batch,
    // and the old directory is left untouched either way.
    logger.warn('could not migrate notes from the previous extension id', err);
  }
}
