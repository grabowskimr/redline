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

  async load(): Promise<LoadResult> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
      this.knownMtime = (await fs.stat(this.filePath)).mtimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { state: emptyState(), droppedNotes: 0 };
      this.logger.error(`failed to read ${this.filePath}`, err);
      return { state: emptyState(), droppedNotes: 0 };
    }
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
    this.pending = state;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  /** Write immediately (used on deactivate). Resolves once the file is on disk. */
  async flush(): Promise<void> {
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
