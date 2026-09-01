import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { emptyState, migrate, PersistedState, SchemaError } from '../model/schema';

export interface PersistenceLogger {
  info(msg: string, ...d: unknown[]): void;
  warn(msg: string, ...d: unknown[]): void;
  error(msg: string, err?: unknown): void;
}

export interface LoadResult {
  state: PersistedState;
  /** Present when the on-disk file was unreadable and was quarantined. */
  quarantinedTo?: string;
  /**
   * Present when the file is there but could not be read at all — EACCES, EBUSY, EIO, a
   * network share that blinked. `state` is empty in that case only because there is nothing
   * to put in it, and it must not be treated as the user's notes.
   */
  unreadable?: string;
  droppedNotes: number;
}

const noopLogger: PersistenceLogger = { info() {}, warn() {}, error() {} };

/**
 * Async JSON persistence with debounced, atomic writes and corrupt-file quarantine.
 * Pure Node — no `vscode` dependency.
 */
export class Persistence {
  private timer: NodeJS.Timeout | undefined;
  private pending: PersistedState | undefined;
  private writing: Promise<void> = Promise.resolve();
  /**
   * Set when a load failed for any reason other than the file not being there, and cleared
   * only by a load that works.
   *
   * "I could not read it" used to be answered with the same empty state as "there is nothing
   * here": the panel came up blank, the user typed one note, and the debounced write put a
   * one-note document over a notes file that still held everything they had written. Writing
   * is refused until a load succeeds, so the file on disk stays the record.
   */
  private unreadable: string | undefined;

  constructor(
    private filePath: string,
    private readonly logger: PersistenceLogger = noopLogger,
    private readonly debounceMs = 300,
  ) {}

  get path(): string {
    return this.filePath;
  }

  /** mtime (ms) of the file as last read or written by us; used to detect external writes. */
  private knownMtime: number | undefined;

  /**
   * Change target file (e.g. storage mode switched). Any pending debounced write of the
   * *old* state is discarded — the caller reloads from the new path right after.
   */
  setPath(p: string): void {
    this.discardPending();
    this.knownMtime = undefined;
    this.unreadable = undefined; // a different file; nothing is known about it yet
    this.filePath = p;
  }

  /** Drop a not-yet-written debounced save (the caller is about to replace the state). */
  discardPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  /** True if the file on disk was modified by someone else since we last read/wrote it. */
  async changedExternally(): Promise<boolean> {
    try {
      const st = await fs.stat(this.filePath);
      return this.knownMtime !== undefined && st.mtimeMs !== this.knownMtime;
    } catch {
      return false;
    }
  }

  /** True while a failed read is holding writes back; the caller must not treat the store as sound. */
  get suspended(): boolean {
    return this.unreadable !== undefined;
  }

  async load(): Promise<LoadResult> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
      this.knownMtime = (await fs.stat(this.filePath)).mtimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // No file is a genuine empty state — a first run. Anything else is a file we cannot see
      // into, and answering with an empty state made the next save delete its contents.
      if (code === 'ENOENT') {
        this.unreadable = undefined;
        return { state: emptyState(), droppedNotes: 0 };
      }
      this.logger.error(`failed to read ${this.filePath}`, err);
      this.unreadable = `${code ?? 'read failed'}: ${String(err)}`;
      return { state: emptyState(), droppedNotes: 0, unreadable: this.unreadable };
    }
    this.unreadable = undefined;
    if (text.trim().length === 0) return { state: emptyState(), droppedNotes: 0 };
    try {
      const raw: unknown = JSON.parse(text);
      const { state, droppedNotes } = migrate(raw);
      if (droppedNotes > 0) this.logger.warn(`dropped ${droppedNotes} malformed note(s) while loading`);
      return { state, droppedNotes };
    } catch (err) {
      const reason = err instanceof SchemaError ? err.message : 'invalid JSON';
      const quarantinedTo = await this.quarantine(text);
      this.logger.error(`notes file unreadable (${reason}); quarantined to ${quarantinedTo}`, err);
      return { state: emptyState(), quarantinedTo, droppedNotes: 0 };
    }
  }

  private async quarantine(text: string): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath, '.json');
    const target = path.join(dir, `${base}.corrupt-${ts}.json`);
    try {
      await fs.writeFile(target, text, 'utf8');
    } catch (err) {
      this.logger.error('failed to write quarantine file', err);
    }
    return target;
  }

  /** Debounced save. Multiple calls within the window collapse into one write. */
  save(state: PersistedState): void {
    // Whatever is in memory was not loaded from this file, so it cannot be allowed to replace it.
    if (this.unreadable !== undefined) {
      this.logger.warn(`not saving over ${this.filePath}: it could not be read (${this.unreadable})`);
      return;
    }
    this.pending = state;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  /** Write immediately (used on deactivate). Resolves once the file is on disk. */
  async flush(): Promise<void> {
    if (this.unreadable !== undefined) {
      // Deactivate flushes; the same rule applies there, and more so — it is the last write.
      this.discardPending();
      return this.writing;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const state = this.pending;
    this.pending = undefined;
    if (!state) return this.writing;
    this.writing = this.writing.then(() => this.writeAtomic(state)).catch((err) => {
      this.logger.error(`failed to save ${this.filePath}`, err);
    });
    return this.writing;
  }

  private async writeAtomic(state: PersistedState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const json = JSON.stringify(state, null, 2);
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, this.filePath);
    this.knownMtime = (await fs.stat(this.filePath)).mtimeMs;
  }
}
