import { Batch, isBatch, isReviewNote, ReviewNote } from './note';
import { newId, nowIso } from './ids';

export const SCHEMA_VERSION = 3;

export interface PersistedState {
  version: typeof SCHEMA_VERSION;
  active: Batch;
  /** Newest first. */
  archive: Batch[];
  /** Next `seq` to hand out. */
  nextSeq: number;
  /** Working-tree snapshot pinned by "Pin Baseline Here". */
  baseline?: {
    sha: string;
    at: string;
    headSha?: string;
    /** Files already untracked when the baseline was pinned (not part of the snapshot). */
    untracked?: string[];
  };
}

export function emptyBatch(name = 'default'): Batch {
  return { id: newId(), name, notes: [], createdAt: nowIso() };
}

export function emptyState(): PersistedState {
  return { version: SCHEMA_VERSION, active: emptyBatch(), archive: [], nextSeq: 1 };
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Drop malformed notes instead of failing the whole file. Returns the count dropped. */
function sanitiseBatch(raw: unknown): { batch: Batch; dropped: number } | undefined {
  if (!isBatch(raw)) return undefined;
  const notes: ReviewNote[] = [];
  let dropped = 0;
  for (const n of raw.notes) {
    if (isReviewNote(n)) notes.push(n);
    else dropped++;
  }
  const batch: Batch = {
    id: raw.id,
    name: raw.name,
    notes,
    createdAt: raw.createdAt,
  };
  if (raw.submittedAt) batch.submittedAt = raw.submittedAt;
  return { batch, dropped };
}

export interface MigrateResult {
  state: PersistedState;
  /** Number of notes that were dropped because they failed validation. */
  droppedNotes: number;
}

/**
 * Validate + migrate a parsed JSON document into the current schema.
 * Throws `SchemaError` for unknown/newer versions or structurally invalid files;
 * the caller quarantines the file and starts empty.
 */
function upgradeV1(raw: Record<string, unknown>): Record<string, unknown> {
  // v1 → v2: assign `seq` in creation order across active + archive.
  const batches: unknown[] = [raw['active'], ...(Array.isArray(raw['archive']) ? raw['archive'] : [])];
  const notes: Record<string, unknown>[] = [];
  for (const b of batches) {
    if (isObj(b) && Array.isArray(b['notes'])) for (const n of b['notes']) if (isObj(n)) notes.push(n);
  }
  notes.sort((a, b) => String(a['createdAt'] ?? '').localeCompare(String(b['createdAt'] ?? '')));
  let seq = 1;
  for (const n of notes) {
    if (typeof n['seq'] !== 'number') n['seq'] = seq++;
    else seq = Math.max(seq, (n['seq'] as number) + 1);
  }
  return { ...raw, version: 2, nextSeq: seq };
}

/**
 * v2 → v3: parked notes, file-level notes and diff-base notes were removed, and the
 * review range became session-derived — a baseline pinned under the old rules would
 * silently override the new default, so it is dropped (it can be re-pinned).
 */
function upgradeV2(raw: Record<string, unknown>): Record<string, unknown> {
  const batches: unknown[] = [raw['active'], ...(Array.isArray(raw['archive']) ? raw['archive'] : [])];
  for (const b of batches) {
    if (!isObj(b) || !Array.isArray(b['notes'])) continue;
    for (const n of b['notes']) {
      if (!isObj(n)) continue;
      // A parked note becomes an ordinary open note; the rest of the fields just go.
      delete n['included'];
      delete n['side'];
      const anchor = n['anchor'];
      if (isObj(anchor)) delete anchor['fileLevel'];
    }
  }
  const next: Record<string, unknown> = { ...raw, version: 3 };
  delete next['baseline'];
  return next;
}

export function migrate(raw: unknown): MigrateResult {
  if (!isObj(raw)) throw new SchemaError('root is not an object');
  if (raw['version'] === 1) raw = upgradeV1(raw);
  if (isObj(raw) && raw['version'] === 2) raw = upgradeV2(raw);
  if (!isObj(raw)) throw new SchemaError('root is not an object');
  const version = raw['version'];
  if (version !== SCHEMA_VERSION) {
    throw new SchemaError(`unsupported schema version ${String(version)} (expected ${SCHEMA_VERSION})`);
  }
  const active = sanitiseBatch(raw['active']);
  if (!active) throw new SchemaError('active batch is malformed');
  let dropped = active.dropped;
  const archive: Batch[] = [];
  const rawArchive = raw['archive'];
  if (Array.isArray(rawArchive)) {
    for (const b of rawArchive) {
      const s = sanitiseBatch(b);
      if (s) {
        archive.push(s.batch);
        dropped += s.dropped;
      } else {
        dropped++;
      }
    }
  }
  const allSeqs = [...active.batch.notes, ...archive.flatMap((b) => b.notes)].map((n) => n.seq);
  const nextSeq = Math.max(typeof raw['nextSeq'] === 'number' ? raw['nextSeq'] : 1, ...allSeqs.map((n) => n + 1), 1);
  /*
   * Backfill the waterline on notes written before it existed.
   *
   * `addendaAtSend` is how many turns had been written when a note was last sent; anything past
   * it is a reply the agent has not seen. Absent, the predicates fall back to "all of them
   * seen", which is right for the turns already on the note and wrong for the next one: a
   * follow-up typed on such a note counts as seen the moment it is typed, so it is never
   * offered for sending and the card does not even mark it. Stamping the count once, here, ends
   * that — every turn now on the note is history, and the next one is not.
   *
   * Done at load rather than in the predicates because "how many had been sent" is a fact about
   * the past. Deriving it live means it changes every time someone types.
   */
  for (const note of [...active.batch.notes, ...archive.flatMap((b) => b.notes)]) {
    if (note.sent && note.sent.addendaAtSend === undefined) {
      note.sent.addendaAtSend = note.addenda.length;
    }
  }
  const state: PersistedState = { version: SCHEMA_VERSION, active: active.batch, archive, nextSeq };
  const bl = raw['baseline'];
  if (isObj(bl) && typeof bl['sha'] === 'string' && typeof bl['at'] === 'string') {
    state.baseline = { sha: bl['sha'], at: bl['at'] };
    if (typeof bl['headSha'] === 'string') state.baseline.headSha = bl['headSha'];
    const untracked = bl['untracked'];
    if (Array.isArray(untracked)) {
      state.baseline.untracked = untracked.filter((u): u is string => typeof u === 'string');
    }
  }
  return { state, droppedNotes: dropped };
}
