import * as assert from 'node:assert/strict';
import { emptyState, migrate, SchemaError } from '../../model/schema';
import { note } from './fixtures';
import { hasUnsentReply } from '../../model/note';

describe('schema.migrate', () => {
  it('accepts a valid v1 document', () => {
    const state = emptyState();
    state.active.notes.push(note());
    const r = migrate(JSON.parse(JSON.stringify(state)));
    assert.equal(r.droppedNotes, 0);
    assert.equal(r.state.active.notes.length, 1);
  });

  it('throws SchemaError on non-objects and newer versions', () => {
    assert.throws(() => migrate(null), SchemaError);
    assert.throws(() => migrate('x'), SchemaError);
    assert.throws(() => migrate({ version: 2, active: {} }), SchemaError);
    assert.throws(() => migrate({ version: 1 }), SchemaError);
  });

  it('drops malformed notes but keeps the rest', () => {
    const state = emptyState();
    state.active.notes.push(note(), { id: 'broken' } as never);
    const r = migrate(state);
    assert.equal(r.droppedNotes, 1);
    assert.equal(r.state.active.notes.length, 1);
  });

  it('tolerates a missing or malformed archive', () => {
    const s = emptyState();
    const r = migrate({ version: 1, active: s.active, archive: ['junk', s.active] });
    assert.equal(r.state.archive.length, 1);
    assert.equal(r.droppedNotes, 1);
    const r2 = migrate({ version: 1, active: s.active });
    assert.deepEqual(r2.state.archive, []);
  });
});

describe('schema.migrate element validation', () => {
  it('drops notes whose context/addenda arrays contain non-strings', () => {
    const state = emptyState();
    const bad = note();
    (bad.anchor.contextBefore as unknown[]).push(null);
    state.active.notes.push(note(), bad, { ...note(), addenda: [1] } as never);
    const r = migrate(JSON.parse(JSON.stringify(state)));
    assert.equal(r.droppedNotes, 2);
    assert.equal(r.state.active.notes.length, 1);
  });
});

describe('schema migration', () => {
  it('assigns seq in creation order and sets nextSeq', () => {
    const v1 = {
      version: 1,
      active: { id: 'a', name: 'default', createdAt: 't', notes: [
        { ...note({ id: 'x', createdAt: '2026-01-02T00:00:00Z' }), seq: undefined },
        { ...note({ id: 'y', createdAt: '2026-01-01T00:00:00Z' }), seq: undefined },
      ] },
      archive: [{ id: 'b', name: 'default', createdAt: 't', notes: [{ ...note({ id: 'z', createdAt: '2025-12-31T00:00:00Z' }), seq: undefined }] }],
    };
    const r = migrate(JSON.parse(JSON.stringify(v1)));
    const seqOf = (id: string) => [...r.state.active.notes, ...r.state.archive.flatMap((b) => b.notes)].find((n) => n.id === id)?.seq;
    assert.equal(seqOf('z'), 1);
    assert.equal(seqOf('y'), 2);
    assert.equal(seqOf('x'), 3);
    assert.equal(r.state.nextSeq, 4);
    assert.equal(r.state.version, 3);
  });
  it('keeps baseline', () => {
    const s = emptyState();
    s.baseline = { sha: 'abc', at: 't' };
    assert.deepEqual(migrate(JSON.parse(JSON.stringify(s))).state.baseline, { sha: 'abc', at: 't' });
  });
});

describe('schema v2 → v3', () => {
  it('drops parked/file-level/base-side fields and keeps the note', () => {
    const s = emptyState();
    const n = { ...note({ id: 'p' }), included: false, side: 'base' } as unknown as Record<string, unknown>;
    (n['anchor'] as Record<string, unknown>)['fileLevel'] = true;
    const v2 = { version: 2, nextSeq: 5, active: { ...s.active, notes: [n] }, archive: [] };
    const r = migrate(JSON.parse(JSON.stringify(v2)));
    assert.equal(r.state.version, 3);
    assert.equal(r.state.active.notes.length, 1);
    const kept = r.state.active.notes[0] as unknown as Record<string, unknown>;
    assert.equal(kept['included'], undefined);
    assert.equal(kept['side'], undefined);
    assert.equal((kept['anchor'] as Record<string, unknown>)['fileLevel'], undefined);
  });
});

describe('the reply waterline on notes that predate it', () => {
  /*
   * `addendaAtSend` records how many turns had been written when a note was last sent, and
   * everything past it is a reply the agent has not seen. Notes written before that field
   * existed have none, and the predicates then treat every turn as seen — correct for the
   * turns already there, and wrong for the next one: a follow-up typed on such a note counted
   * as seen the moment it was typed, so it was never offered for sending and the card never
   * marked it. Stamping it once at load is what separates "what has already been said" from
   * "what I am asking now".
   */
  it('stamps it once, so a later follow-up still counts as unsent', () => {
    const legacy = {
      ...note({ id: 'n1', seq: 1, addenda: ['one', 'Claude: two'] }),
      // An older note: sent, with turns, and no record of how many had been written.
      sent: { at: '2026-08-01T00:00:00.000Z', snippetHash: 'h' },
    };
    const raw = {
      version: 3,
      nextSeq: 2,
      active: { id: 'b1', name: 'active', createdAt: '2026-08-01T00:00:00.000Z', notes: [legacy] },
      archive: [],
    };

    const { state } = migrate(raw);
    const migrated = state.active.notes[0]!;
    assert.equal(migrated.sent?.addendaAtSend, 2, 'both existing turns are history');
    assert.equal(hasUnsentReply(migrated), false, 'nothing is owed on it yet');

    const withReply = { ...migrated, addenda: [...migrated.addenda, 'and one more thing'] };
    assert.equal(hasUnsentReply(withReply), true, 'and the next thing typed is');
  });
});
