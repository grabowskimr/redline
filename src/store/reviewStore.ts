import { Batch, NewNoteInput, ReviewNote } from '../model/note';
import { newId, nowIso } from '../model/ids';
import { emptyBatch, PersistedState } from '../model/schema';
import { Emitter, Disposable } from './emitter';
import { Persistence } from './persistence';

export interface StoreChange {
  type: 'add' | 'update' | 'delete' | 'clear' | 'restore' | 'reload';
  noteIds: string[];
}

export interface StoreOptions {
  /** Max archived batches to keep. Read live so config changes apply. */
  archiveLimit: () => number;
}

/**
 * Single source of truth for notes. Everything else subscribes to `onDidChange`.
 * In-memory state is authoritative; every mutation schedules a debounced save.
 * No `vscode` imports — unit-testable.
 */
export class ReviewStore implements Disposable {
  private readonly _onDidChange = new Emitter<StoreChange>();
  readonly onDidChange = this._onDidChange.event;

  private state: PersistedState;
  private byId = new Map<string, ReviewNote>();

  constructor(
    initial: PersistedState,
    private readonly persistence: Persistence | undefined,
    private readonly options: StoreOptions,
  ) {
    this.state = initial;
    this.reindex();
  }

  // ─── read ─────────────────────────────────────────────────────────────

  get notes(): readonly ReviewNote[] {
    return this.state.active.notes;
  }

  get activeBatch(): Batch {
    return this.state.active;
  }

  get archive(): readonly Batch[] {
    return this.state.archive;
  }

  get hasArchive(): boolean {
    return this.state.archive.length > 0;
  }

  getById(id: string): ReviewNote | undefined {
    return this.byId.get(id);
  }

  byPath(path: string, workspaceFolder?: string): ReviewNote[] {
    return this.state.active.notes.filter(
      (n) => n.path === path && (workspaceFolder === undefined || n.workspaceFolder === workspaceFolder),
    );
  }

  /** Snapshot for persistence / tests. */
  snapshot(): PersistedState {
    return this.state;
  }

  // ─── write ────────────────────────────────────────────────────────────

  add(input: NewNoteInput): ReviewNote {
    const ts = nowIso();
    const maxOrder = this.state.active.notes.reduce((m, n) => Math.max(m, n.order), -1);
    const note: ReviewNote = {
      id: newId(),
      seq: this.state.nextSeq++,
      path: input.path,
      range: { ...input.range },
      anchor: { ...input.anchor },
      body: input.body,
      addenda: [],
      kind: input.kind ?? 'comment',
      done: false,
      order: maxOrder + 1,
      createdAt: ts,
      updatedAt: ts,
    };
    if (input.workspaceFolder !== undefined) note.workspaceFolder = input.workspaceFolder;
    if (input.languageId !== undefined) note.languageId = input.languageId;
    if (input.suggestion !== undefined) note.suggestion = input.suggestion;
    if (input.git !== undefined) note.git = input.git;

    this.state.active.notes.push(note);
    this.byId.set(note.id, note);
    this.commit({ type: 'add', noteIds: [note.id] });
    return note;
  }

  update(id: string, patch: Partial<Omit<ReviewNote, 'id'>>): ReviewNote | undefined {
    const note = this.byId.get(id);
    if (!note) return undefined;
    const idx = this.state.active.notes.indexOf(note);
    const next: ReviewNote = { ...note, ...patch, id: note.id, updatedAt: nowIso() };
    // Drop explicitly-undefined optional fields so they don't persist as null-ish.
    for (const k of Object.keys(next) as (keyof ReviewNote)[]) {
      if (next[k] === undefined) delete next[k];
    }
    this.state.active.notes[idx] = next;
    this.byId.set(id, next);
    this.commit({ type: 'update', noteIds: [id] });
    return next;
  }

  /** Batched update without intermediate events (used by the live tracker). */
  updateMany(patches: Array<{ id: string; patch: Partial<Omit<ReviewNote, 'id'>> }>): void {
    const ids: string[] = [];
    for (const { id, patch } of patches) {
      const note = this.byId.get(id);
      if (!note) continue;
      const idx = this.state.active.notes.indexOf(note);
      const next: ReviewNote = { ...note, ...patch, id: note.id, updatedAt: nowIso() };
      for (const k of Object.keys(next) as (keyof ReviewNote)[]) {
        if (next[k] === undefined) delete next[k];
      }
      this.state.active.notes[idx] = next;
      this.byId.set(id, next);
      ids.push(id);
    }
    if (ids.length > 0) this.commit({ type: 'update', noteIds: ids });
  }

  delete(ids: string[]): void {
    const set = new Set(ids);
    const removed: string[] = [];
    this.state.active.notes = this.state.active.notes.filter((n) => {
      if (set.has(n.id)) {
        removed.push(n.id);
        this.byId.delete(n.id);
        return false;
      }
      return true;
    });
    if (removed.length > 0) this.commit({ type: 'delete', noteIds: removed });
  }

  /**
   * Put deleted notes back exactly as they were — same id, seq, sent record and
   * attachments. `add` would mint a new identity, which is not what Undo means.
   *
   * Notes whose id is present again are skipped, so a stale Undo cannot duplicate one.
   */
  reinstate(notes: readonly ReviewNote[]): void {
    const fresh = notes.filter((n) => !this.byId.has(n.id));
    if (fresh.length === 0) return;
    for (const n of fresh) {
      this.state.active.notes.push(n);
      this.byId.set(n.id, n);
    }
    this.state.active.notes.sort((a, b) => a.seq - b.seq);
    this.commit({ type: 'add', noteIds: fresh.map((n) => n.id) });
  }

  /** Remove every note without archiving. Prefer `archiveActive()` for user-facing flows. */
  clear(): void {
    const ids = this.state.active.notes.map((n) => n.id);
    this.state.active = emptyBatch(this.state.active.name);
    this.byId.clear();
    this.commit({ type: 'clear', noteIds: ids });
  }

  /**
   * Moves the active batch (all notes, including parked/done) to the archive and starts a
   * fresh empty batch. Returns the archived batch.
   */
  archiveActive(): Batch {
    const batch = this.state.active;
    batch.submittedAt = nowIso();
    const ids = batch.notes.map((n) => n.id);
    this.state.archive.unshift(batch);
    this.trimArchive();
    this.state.active = emptyBatch(batch.name);
    this.byId.clear();
    this.commit({ type: 'clear', noteIds: ids });
    return batch;
  }

  /**
   * Archive a copy of the active batch without clearing it, so what was sent stays
   * recoverable while the notes themselves remain visible as "sent".
   */
  archiveCopy(): Batch {
    const copy: Batch = {
      ...this.state.active,
      id: newId(),
      notes: this.state.active.notes.map((n) => ({ ...n })),
      submittedAt: nowIso(),
    };
    this.state.archive.unshift(copy);
    this.trimArchive();
    this.commit({ type: 'update', noteIds: [] });
    return copy;
  }

  /**
   * Restore an archived batch (default: newest) as the active batch. If the active batch
   * has notes, they are merged *after* the restored notes (restored notes keep their ids;
   * conflicting ids in the current batch are regenerated).
   */
  restore(batchId?: string): Batch | undefined {
    const idx = batchId ? this.state.archive.findIndex((b) => b.id === batchId) : 0;
    if (idx < 0 || idx >= this.state.archive.length) return undefined;
    const [batch] = this.state.archive.splice(idx, 1);
    if (!batch) return undefined;
    delete batch.submittedAt;
    // An id present in BOTH the archive and the active batch is the same note (the archive
    // entry is a copy from a non-clearing submit) — keep the live one, don't duplicate.
    const activeIds = new Set(this.state.active.notes.map((n) => n.id));
    const restored = batch.notes.filter((n) => !activeIds.has(n.id));
    const carried = [...this.state.active.notes];
    const maxOrder = restored.reduce((m, n) => Math.max(m, n.order), -1);
    carried.forEach((n, i) => (n.order = maxOrder + 1 + i));
    this.state.active = { ...batch, notes: [...restored, ...carried] };
    this.reindex();
    this.commit({ type: 'restore', noteIds: this.state.active.notes.map((n) => n.id) });
    return this.state.active;
  }

  get baseline(): PersistedState['baseline'] {
    return this.state.baseline;
  }

  setBaseline(b: PersistedState['baseline']): void {
    if (b) this.state.baseline = b;
    else delete this.state.baseline;
    this.commit({ type: 'update', noteIds: [] });
  }

  /**
   * Mark the given notes as sent (kept visible, excluded from the next submit).
   * `hashes` carries the hash of the code as actually rendered into the batch — the
   * creation-time anchor hash may be stale if the file drifted before sending.
   */
  markSent(
    ids: string[],
    targetKey?: string,
    hashes?: ReadonlyMap<string, { snippet: string; file: string }>,
  ): void {
    const at = nowIso();
    this.updateMany(
      ids
        .map((id) => this.byId.get(id))
        .filter((n): n is ReviewNote => !!n)
        .map((n) => {
          const h = hashes?.get(n.id);
          const sent: NonNullable<ReviewNote['sent']> = {
            at,
            snippetHash: h?.snippet ?? n.anchor.snippetHash,
            addendaAtSend: n.addenda.length,
          };
          if (h?.file) sent.fileHash = h.file;
          if (targetKey) sent.target = targetKey;
          return { id: n.id, patch: { sent } };
        }),
    );
  }

  /** Archive and remove every sent note (the previous round) — returns how many. */
  clearSent(): number {
    const sent = this.state.active.notes.filter((n) => n.sent);
    if (sent.length === 0) return 0;
    const batch: Batch = {
      id: newId(),
      name: this.state.active.name,
      notes: sent,
      createdAt: sent[0]?.createdAt ?? nowIso(),
      submittedAt: nowIso(),
    };
    this.state.archive.unshift(batch);
    this.trimArchive();
    this.delete(sent.map((n) => n.id));
    return sent.length;
  }

  /** Replace the whole state (e.g. storage location changed). */
  reload(state: PersistedState): void {
    this.state = state;
    this.reindex();
    this._onDidChange.fire({ type: 'reload', noteIds: this.state.active.notes.map((n) => n.id) });
  }

  async flush(): Promise<void> {
    await this.persistence?.flush();
  }

  // ─── internals ────────────────────────────────────────────────────────

  private trimArchive(): void {
    const limit = this.options.archiveLimit();
    if (this.state.archive.length > limit) this.state.archive.length = limit;
  }

  private reindex(): void {
    this.byId = new Map(this.state.active.notes.map((n) => [n.id, n]));
  }

  private commit(change: StoreChange): void {
    this.persist();
    this._onDidChange.fire(change);
  }

  private persist(): void {
    this.persistence?.save(this.state);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
