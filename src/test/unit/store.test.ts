import * as assert from 'node:assert/strict';
import { input, makeStore } from './fixtures';
import { hasUnsentReply, isOnDeck, isOpen, ReviewNote } from '../../model/note';

import { StoreChange } from '../../store/reviewStore';

describe('ReviewStore', () => {
  it('adds notes with defaults and fires add', () => {
    const store = makeStore();
    const events: StoreChange[] = [];
    store.onDidChange((e) => events.push(e));
    const n = store.add(input({ body: 'hello' }));
    assert.equal(n.kind, 'comment');
    assert.equal(n.done, false);
    assert.equal(n.order, 0);
    assert.deepEqual(n.addenda, []);
    assert.equal(store.notes.length, 1);
    assert.deepEqual(events, [{ type: 'add', noteIds: [n.id] }]);
    assert.equal(store.add(input()).order, 1);
  });

  it('updates notes immutably and bumps updatedAt', async () => {
    const store = makeStore();
    const n = store.add(input());
    await new Promise((r) => setTimeout(r, 2));
    const next = store.update(n.id, { body: 'changed', kind: 'bug' });
    assert.ok(next);
    assert.equal(next.body, 'changed');
    assert.equal(next.kind, 'bug');
    assert.notEqual(next, n);
    assert.ok(next.updatedAt >= n.updatedAt);
    assert.equal(store.getById(n.id)?.body, 'changed');
    assert.equal(store.update('missing', { body: 'x' }), undefined);
  });

  it('removes undefined optional fields on update', () => {
    const store = makeStore();
    const n = store.add(input({ suggestion: 'x' }));
    const next = store.update(n.id, { suggestion: undefined });
    assert.ok(next && !('suggestion' in next));
  });

  it('deletes by ids and ignores unknown ids', () => {
    const store = makeStore();
    const a = store.add(input());
    const b = store.add(input());
    const events: StoreChange[] = [];
    store.onDidChange((e) => events.push(e));
    store.delete([a.id, 'nope']);
    assert.deepEqual(events, [{ type: 'delete', noteIds: [a.id] }]);
    assert.equal(store.notes.length, 1);
    assert.equal(store.getById(b.id), b);
    store.delete(['nope']);
    assert.equal(events.length, 1);
  });

  it('byPath filters by path and workspace folder', () => {
    const store = makeStore();
    store.add(input({ path: 'x.ts', workspaceFolder: 'a' }));
    store.add(input({ path: 'x.ts', workspaceFolder: 'b' }));
    store.add(input({ path: 'y.ts' }));
    assert.equal(store.byPath('x.ts').length, 2);
    assert.equal(store.byPath('x.ts', 'a').length, 1);
  });

  it('clear empties the batch without archiving', () => {
    const store = makeStore();
    store.add(input());
    store.clear();
    assert.equal(store.notes.length, 0);
    assert.equal(store.archive.length, 0);
  });
});

describe('ReviewStore archive', () => {
  it('archiveActive moves notes to the archive and starts a fresh batch', () => {
    const store = makeStore();
    const n = store.add(input());
    const oldBatchId = store.activeBatch.id;
    const batch = store.archiveActive();
    assert.equal(batch.id, oldBatchId);
    assert.ok(batch.submittedAt);
    assert.equal(batch.notes[0]?.id, n.id);
    assert.equal(store.notes.length, 0);
    assert.notEqual(store.activeBatch.id, oldBatchId);
    assert.equal(store.archive.length, 1);
    assert.equal(store.hasArchive, true);
  });

  it('restore puts the newest batch back verbatim', () => {
    const store = makeStore();
    const n = store.add(input({ kind: 'bug' }));
    store.update(n.id, { anchor: { ...n.anchor, lineHint: 99 } });
    const before = JSON.stringify(store.notes);
    store.archiveActive();
    const events: StoreChange[] = [];
    store.onDidChange((e) => events.push(e));
    store.restore();
    assert.equal(JSON.stringify(store.notes), before);
    assert.equal(store.archive.length, 0);
    assert.equal(events[0]?.type, 'restore');
    assert.equal(store.activeBatch.submittedAt, undefined);
  });

  it('restore merges current notes after restored ones', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'a' }));
    store.archiveActive();
    const b = store.add(input({ body: 'b' }));
    store.restore();
    assert.deepEqual(
      store.notes.map((n) => n.body),
      ['a', 'b'],
    );
    assert.equal(store.notes[0]?.id, a.id);
    assert.equal(store.notes[1]?.id, b.id);
    assert.ok((store.notes[1]?.order ?? 0) > (store.notes[0]?.order ?? 0));
  });

  it('restore by id and restore on empty archive', () => {
    const store = makeStore();
    store.add(input({ body: 'first' }));
    const first = store.archiveActive();
    store.add(input({ body: 'second' }));
    store.archiveActive();
    assert.equal(store.restore('nope'), undefined);
    store.restore(first.id);
    assert.equal(store.notes[0]?.body, 'first');
    assert.equal(store.archive.length, 1);
    store.archiveActive();
    store.restore();
    store.restore();
    assert.equal(store.restore(), undefined);
  });

  it('rotates the archive at the limit, newest first', () => {
    const store = makeStore(undefined, 3);
    for (let i = 0; i < 5; i++) {
      store.add(input({ body: `b${i}` }));
      store.archiveActive();
    }
    assert.equal(store.archive.length, 3);
    assert.deepEqual(
      store.archive.map((b) => b.notes[0]?.body),
      ['b4', 'b3', 'b2'],
    );
  });

  it('archiveCopy keeps the active batch intact', () => {
    const store = makeStore();
    store.add(input());
    store.archiveCopy();
    assert.equal(store.notes.length, 1);
    assert.equal(store.archive.length, 1);
    assert.notEqual(store.archive[0]?.id, store.activeBatch.id);
  });
});

describe('ReviewStore sent flow', () => {
  it('assigns increasing seq numbers', () => {
    const store = makeStore();
    assert.equal(store.add(input()).seq, 1);
    assert.equal(store.add(input()).seq, 2);
  });
  it('markSent keeps notes but excludes them from the active set; clearSent archives them', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'a' }));
    const b = store.add(input({ body: 'b' }));
    store.markSent([a.id]);
    assert.equal(store.getById(a.id)?.sent?.snippetHash, a.anchor.snippetHash);
    assert.deepEqual(store.notes.filter((n) => !n.done && !n.sent).map((n) => n.id), [b.id]);
    assert.equal(store.clearSent(), 1);
    assert.equal(store.notes.length, 1);
    assert.equal(store.archive[0]?.notes[0]?.id, a.id);
    assert.equal(store.clearSent(), 0);
  });
  it('baseline round-trips through the store', () => {
    const store = makeStore();
    store.setBaseline({ sha: 'x', at: 't' });
    assert.equal(store.baseline?.sha, 'x');
    store.setBaseline(undefined);
    assert.equal(store.baseline, undefined);
  });
});

describe('ReviewStore restore after archiveCopy (no duplication)', () => {
  it('keeps the live note when the archive holds a copy with the same id', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'a' }));
    store.archiveCopy();
    store.markSent([a.id]);
    store.restore();
    assert.equal(store.notes.length, 1, 'no duplicate');
    assert.equal(store.notes[0]?.id, a.id);
    assert.ok(store.notes[0]?.sent, 'live (sent) version kept');
    const seqs = store.notes.map((n) => n.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'seq unique');
  });
  it('a reply written after a send reopens the note', () => {
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    store.update(a.id, { sent: { ...store.getById(a.id)!.sent!, outcome: 'done' }, done: true });
    assert.equal(hasUnsentReply(store.getById(a.id)!), false, 'nothing said since it was sent');

    store.update(a.id, { addenda: ['that is not quite what I meant'] });
    assert.equal(hasUnsentReply(store.getById(a.id)!), true, 'the agent has not seen this yet');

    // Sending catches the agent up, and the note settles again.
    store.markSent([a.id]);
    assert.equal(hasUnsentReply(store.getById(a.id)!), false);
  });

  it('treats a note sent before replies were tracked as fully seen', () => {
    const store = makeStore();
    const a = store.add(input({ }));
    // An older note: sent, with turns, but no record of how many had been written.
    store.update(a.id, {
      addenda: ['one', 'two'],
      sent: { at: '2026-08-01T00:00:00.000Z', snippetHash: 'h' },
    });
    assert.equal(hasUnsentReply(store.getById(a.id)!), false, 'no false "unsent" on old notes');
  });

  it('reinstate puts a deleted note back with its identity intact', () => {
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id], 'orca:x');
    const before = store.getById(a.id);
    assert.ok(before);
    store.delete([a.id]);
    assert.equal(store.getById(a.id), undefined);

    store.reinstate([before]);
    const after = store.getById(a.id);
    assert.equal(after?.seq, before.seq, 'same number');
    assert.equal(after?.sent?.target, 'orca:x', 'sent record survives');
    assert.equal(store.notes.length, 1);

    store.reinstate([before]); // a stale Undo must not duplicate it
    assert.equal(store.notes.length, 1);
  });

  it('markSent prefers the supplied send-time hashes', () => {
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id], 'orca:x', new Map([[a.id, { snippet: 'fresh-hash', file: 'file-hash' }]]));
    assert.equal(store.getById(a.id)?.sent?.snippetHash, 'fresh-hash');
    assert.equal(store.getById(a.id)?.sent?.fileHash, 'file-hash');
    assert.equal(store.getById(a.id)?.sent?.target, 'orca:x');
  });

  it('falls back to the anchor hash and records no file hash when none is supplied', () => {
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    assert.equal(store.getById(a.id)?.sent?.snippetHash, a.anchor.snippetHash);
    assert.equal(store.getById(a.id)?.sent?.fileHash, undefined, 'stays absent for older notes');
  });
});

describe('note visibility', () => {
  it('a done note leaves the send set but stays on deck for the panel', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'a' }));
    const b = store.add(input({ body: 'b' }));
    store.update(a.id, { done: true });
    assert.deepEqual(store.notes.filter(isOpen).map((n) => n.body), ['b'], 'done note not sent');
    assert.deepEqual(store.notes.filter(isOnDeck).map((n) => n.body), ['a', 'b'], 'done note still listed');
    store.markSent([b.id]);
    assert.deepEqual(store.notes.filter(isOnDeck).map((n) => n.body), ['a'], 'sent note moves out of the deck');
  });
});

describe('what counts as an unsent follow-up', () => {
  it('does not treat Claude answering as a follow-up you owe it', () => {
    // The reported bug: applying a report added Claude's turn, which made every finished note
    // read "follow-up not sent" and stay live with nothing to send.
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    store.update(a.id, {
      addenda: ['Claude: done — added the comment above QuestionSwitch'],
      done: true,
    });
    assert.equal(hasUnsentReply(store.getById(a.id)!), false, 'the conversation is settled');
  });

  it('still notices your own follow-up written after that', () => {
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    store.update(a.id, { addenda: ['Claude: done — did the thing'] });
    assert.equal(hasUnsentReply(store.getById(a.id)!), false);
    store.update(a.id, { addenda: [...store.getById(a.id)!.addenda, 'not quite — put it above'] });
    assert.equal(hasUnsentReply(store.getById(a.id)!), true, 'yours is unsent');
  });

  it('counts a follow-up written before Claude replied', () => {
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    store.update(a.id, { addenda: ['one more thing', 'Claude: done — did it'] });
    assert.equal(hasUnsentReply(store.getById(a.id)!), true, 'yours was never sent');
  });
});

describe('marking a note done', () => {
  it('settles a conversation that still has a follow-up you never sent', () => {
    // The reported bug: type "ok" as a follow-up, then press done, and nothing happened —
    // the card could not collapse while an unsent turn existed, so done had no visible effect.
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    store.update(a.id, { addenda: ['Claude: done — added the comment', 'ok'] });
    assert.equal(hasUnsentReply(store.getById(a.id)!), true, 'yours is unsent');

    // What the ✓ button does.
    const note = store.getById(a.id)!;
    store.update(note.id, { done: true, sent: { ...note.sent!, addendaAtSend: note.addenda.length } });

    const after = store.getById(a.id)!;
    assert.equal(after.done, true);
    assert.equal(hasUnsentReply(after), false, 'nothing is owed once you are finished');
    assert.equal(after.addenda.length, 2, 'the turns stay in the thread');
  });

  it('notices a follow-up written after it was marked done', () => {
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    let note = store.getById(a.id)!;
    store.update(note.id, { done: true, sent: { ...note.sent!, addendaAtSend: note.addenda.length } });
    note = store.getById(a.id)!;
    store.update(note.id, { addenda: [...note.addenda, 'actually, one more thing'] });
    assert.equal(hasUnsentReply(store.getById(a.id)!), true, 'the conversation is live again');
  });
});

describe('sending a note again mid-thread', () => {
  it('keeps the notes being re-sent out of the archive sweep', () => {
    // Sending a second round archives the previous one — but a note carrying a follow-up is
    // *in* that round, and archiving it would delete the thing the follow-up is attached to.
    const store = makeStore();
    const answered = store.add(input({ body: 'remove this comment' }));
    const stale = store.add(input({ body: 'something else entirely' }));
    store.markSent([answered.id, stale.id]);

    const cleared = store.clearSent([answered.id]);
    assert.equal(cleared, 1, 'only the note with nothing pending was archived');
    assert.deepEqual(
      store.notes.map((n: ReviewNote) => n.id),
      [answered.id],
      'the one being replied to survives',
    );
    assert.equal(store.archive[0]?.notes.length, 1);
  });

  it('archives the whole round when nothing is being re-sent', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'one' }));
    const b = store.add(input({ body: 'two' }));
    store.markSent([a.id, b.id]);
    assert.equal(store.clearSent(), 2);
    assert.deepEqual(store.notes, []);
  });

  it('marks a re-sent note as sent again, so the follow-up stops counting', () => {
    const store = makeStore();
    const n = store.add(input({ body: 'remove this comment' }));
    store.markSent([n.id]);
    store.update(n.id, { addenda: ['Claude: removed it', 'not quite — the other one too'] });
    assert.ok(hasUnsentReply(store.getById(n.id) as ReviewNote), 'a follow-up is waiting');

    store.markSent([n.id]);
    assert.equal(hasUnsentReply(store.getById(n.id) as ReviewNote), false, 'and is no longer waiting');
    assert.equal(store.getById(n.id)?.sent?.addendaAtSend, 2);
  });
});

describe('undoing a send', () => {
  it('puts a re-sent note back to the round it was already in', () => {
    // Undo used to clear `sent` outright, which was right while a batch could only contain
    // notes that had never been sent. A note carrying a follow-up has a record worth keeping:
    // its outcome, the session it is talking to, and how far its thread had got.
    const store = makeStore();
    const answered = store.add(input({ body: 'remove this comment' }));
    store.markSent([answered.id], 'session-a');
    store.update(answered.id, { addenda: ['Claude: done', 'one more thing'], sent: { ...(store.getById(answered.id)?.sent as NonNullable<ReviewNote['sent']>), outcome: 'done' } });
    const before = store.getById(answered.id)?.sent;

    const fresh = store.add(input({ body: 'and this one' }));
    const ids = [fresh.id, answered.id];
    const wasSent = new Map(ids.map((id) => [id, store.getById(id)?.sent]));
    store.markSent(ids, 'session-a');

    // The undo the notification offers.
    store.updateMany(ids.map((id) => ({ id, patch: { sent: wasSent.get(id) } })));

    assert.equal(store.getById(fresh.id)?.sent, undefined, 'the new note goes back to unsent');
    assert.deepEqual(store.getById(answered.id)?.sent, before, 'the answered one keeps its round');
    assert.equal(store.getById(answered.id)?.sent?.outcome, 'done');
  });
});
