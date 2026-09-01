import * as assert from 'node:assert/strict';
import { input, makeStore } from './fixtures';
import { agentTurnThisRound, hasUnsentReply, isOnDeck, isOpen, ReviewNote, roundStart, showsInEditor } from '../../model/note';

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
    // Setting a field to `undefined` takes it off the note rather than storing the word, which
    // is what lets a rejection be cleared or a note's git snapshot be forgotten.
    const store = makeStore();
    const n = store.add(input({ body: 'x' }));
    store.update(n.id, { rejected: true });
    const next = store.update(n.id, { rejected: undefined });
    assert.ok(next && !('rejected' in next));
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
    // What applying a report does: it records the outcome and deliberately does not settle
    // the note — Claude saying it is finished is a claim about the code, not a verdict on it.
    store.update(a.id, { sent: { ...store.getById(a.id)!.sent!, outcome: 'done' } });
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

describe('when a note still belongs in the editor', () => {
  /*
   * The widget stays until it would be lying.
   *
   * It used to go the moment Claude said anything, on the reasoning that the conversation
   * belongs on the card. That was wrong for the common case: a question changes nothing, and
   * its answer is most useful sitting against the lines it is about — closing the widget sent
   * you to find a card to read a reply about code still in front of you.
   *
   * What takes it away is the code moving out from under it, which is what a change request
   * produces and a question does not. One rule, and the kinds differ because their effects do.
   */
  const note = (over: Partial<ReviewNote> = {}): ReviewNote =>
    ({ ...makeStore().add(input({ body: 'x' })), ...over }) as ReviewNote;

  it('shows a note nobody has answered', () => {
    assert.equal(showsInEditor(note()), true);
  });

  it('keeps showing one that has been sent but not answered', () => {
    // Sending is not an answer. Losing the widget the moment you press send would take the
    // note off the lines while it is being worked on, which is exactly when you want it.
    assert.equal(showsInEditor(note({ sent: { at: 'now', snippetHash: 'h' } })), true);
  });

  it('keeps the answer on the lines when the code did not move', () => {
    const answered = note({ sent: { at: 'now', snippetHash: 'h', outcome: 'answered' } });
    assert.equal(showsInEditor(answered, false), true);
  });

  it('takes it out once the code under it has changed', () => {
    // The answer is about code that is no longer there: the widget would be showing a reply
    // beside lines it is not about any more.
    const done = note({ sent: { at: 'now', snippetHash: 'h', outcome: 'done' } });
    assert.equal(showsInEditor(done, true), false);
  });

  it('takes out one whose lines are gone entirely', () => {
    const lost = note({ anchor: { ...note().anchor, orphaned: true } });
    assert.equal(showsInEditor(lost), false);
  });

  it('treats unknown as unmoved, so a closed file does not lose its widgets', () => {
    // Nothing has read the document yet, so nothing knows whether the lines moved. A widget
    // that vanished for that reason would come back on opening the file, which is worse.
    assert.equal(showsInEditor(note({ sent: { at: 'now', snippetHash: 'h', outcome: 'done' } })), true);
  });

  it('takes out one you have marked done, answered or not', () => {
    assert.equal(showsInEditor(note({ done: true })), false);
  });
});

describe('the code a note was written about', () => {
  /*
   * A note is a record of what you were looking at. The card used to show `anchor.snippet`,
   * which looks like that and is not: it is the key the note is found by, and the live tracker
   * rewrites it from the current file every time the code moves — so the lines under a comment
   * became whatever the agent had just written, and the question quietly changed.
   */
  it('is kept as it was, apart from the key the note is found by', () => {
    const store = makeStore();
    const a = store.add({
      ...input({ body: 'why this early return?' }),
      snapshot: { code: '  return base;', startLine: 12 },
    });
    // What the live tracker does when the agent edits the file under a note.
    store.update(a.id, {
      range: { startLine: 40, startChar: 0, endLine: 40, endChar: 0 },
      anchor: { ...store.getById(a.id)!.anchor, snippet: '  return applyTax(base);' },
    });

    const after = store.getById(a.id)!;
    assert.equal(after.snapshot?.code, '  return base;', 'the record does not move');
    assert.equal(after.snapshot?.startLine, 12, 'nor the line it was on');
    assert.equal(after.anchor.snippet, '  return applyTax(base);', 'the key follows the code');
  });

  it('is absent on notes written before it was recorded', () => {
    // Which is what the card falls back to `anchor.snippet` for.
    const store = makeStore();
    const a = store.add(input({ body: 'x' }));
    assert.equal(store.getById(a.id)?.snapshot, undefined);
  });
});

describe('when the round you are working through began', () => {
  /*
   * "The last run" is the last thing you asked for, read from the transcript. That is right
   * until you answer three cards one at a time: each answer becomes its own run, the diff
   * narrows to whatever the newest one touched, and the rest of the round disappears from it.
   * A review is a round, not a message.
   */
  it('is the oldest send still waiting on you', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'a' }));
    const b = store.add(input({ body: 'b' }));
    store.update(a.id, { sent: { at: '2026-08-30T10:00:00.000Z', snippetHash: 'h' } });
    store.update(b.id, { sent: { at: '2026-08-30T10:05:00.000Z', snippetHash: 'h' } });
    assert.equal(roundStart(store.notes), '2026-08-30T10:00:00.000Z');
  });

  it('ignores the ones you have settled', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'a' }));
    const b = store.add(input({ body: 'b' }));
    store.update(a.id, { done: true, sent: { at: '2026-08-30T10:00:00.000Z', snippetHash: 'h' } });
    store.update(b.id, { sent: { at: '2026-08-30T10:05:00.000Z', snippetHash: 'h' } });
    assert.equal(roundStart(store.notes), '2026-08-30T10:05:00.000Z', 'the round that is still open');
  });

  it('is nothing at all once everything is settled', () => {
    // Which puts the transcript back in charge: with no round open, the last run is again the
    // last thing you asked for.
    const store = makeStore();
    const a = store.add(input({ body: 'a' }));
    store.update(a.id, { done: true, sent: { at: '2026-08-30T10:00:00.000Z', snippetHash: 'h' } });
    assert.equal(roundStart(store.notes), undefined);
    assert.equal(roundStart([]), undefined, 'and with no notes at all');
  });

  it('ignores notes that were never sent', () => {
    const store = makeStore();
    store.add(input({ body: 'a draft' }));
    assert.equal(roundStart(store.notes), undefined);
  });
});

describe('which turn is this round\'s answer', () => {
  /*
   * The report is read while the run is still going, so a note is answered several times over
   * one turn as the agent refines what it wrote. The card showed every version — the same
   * answer twice, in slightly different words — until this decided which one to replace.
   */
  const note = (over: Partial<ReviewNote>): ReviewNote => {
    const store = makeStore();
    const a = store.add(input({ body: 'x' }));
    store.update(a.id, over);
    return store.getById(a.id)!;
  };

  it('is nowhere before Claude has said anything', () => {
    assert.equal(agentTurnThisRound(note({ addenda: [] })), -1);
    assert.equal(
      agentTurnThisRound(note({ addenda: ['a follow-up'], sent: { at: 'x', snippetHash: 'h', addendaAtSend: 0 } })),
      -1,
    );
  });

  it('finds the turn Claude added since the last send', () => {
    const n = note({
      addenda: ['Claude: an older round', 'my follow-up', 'Claude: this round'],
      sent: { at: 'x', snippetHash: 'h', addendaAtSend: 2 },
    });
    assert.equal(agentTurnThisRound(n), 2);
  });

  it('will not reach back into a round that is already on the record', () => {
    // Everything before the send is the history of an earlier exchange. Overwriting any of it
    // would rewrite what was actually said.
    const n = note({
      addenda: ['Claude: an older round', 'my follow-up'],
      sent: { at: 'x', snippetHash: 'h', addendaAtSend: 2 },
    });
    assert.equal(agentTurnThisRound(n), -1);
  });
});

describe('a note, all the way round and back again', () => {
  /*
   * The two questions that decide what the user sees, at every step of a real review: does the
   * editor still carry this note, and is a send owed on it? Each was wrong at exactly one step
   * here, and both were invisible in isolation — the bugs live in the transitions.
   *
   * This one is a change request that Claude carries out, so the lines it was written against
   * move — which is what takes its widget away. A note whose lines survive keeps its widget
   * through all of this; that is the case above.
   */
  it('answers both questions correctly at every step', () => {
    const store = makeStore();
    const a = store.add(input({ body: 'rename this prop' }));
    const now = (): ReviewNote => store.getById(a.id)!;
    // `moved` is the live tracker's verdict: has the code under this note changed since it was
    // sent. Nothing has been rewritten yet, so it starts false.
    let moved = false;
    const state = (): [boolean, boolean] => [showsInEditor(now(), moved), hasUnsentReply(now())];

    assert.deepEqual(state(), [true, false], 'written, never sent');

    store.markSent([a.id]);
    assert.deepEqual(state(), [true, false], 'sent, no answer yet — the note is still on its lines');

    store.update(a.id, {
      addenda: ['Claude: renamed it'],
      sent: { ...now().sent!, outcome: 'done' },
    });
    moved = true; // the rename landed: these are not the lines the note was written against
    assert.deepEqual(state(), [false, false], 'answered by rewriting the code — the widget goes');

    store.update(a.id, { rejected: true });
    assert.deepEqual(state(), [false, false], 'turned down, nothing written yet');

    store.update(a.id, { addenda: [...now().addenda, 'not that one'] });
    assert.deepEqual(state(), [false, true], 'the reason is written and owed');

    store.markSent([a.id]);
    // The step that used to put the widget back: sending builds a fresh `sent` with no
    // outcome on it, and the note briefly looked as though it had never been answered.
    assert.deepEqual(state(), [false, false], 'reason sent — and the widget stays gone');

    store.update(a.id, {
      addenda: [...now().addenda, 'Claude: fixed'],
      sent: { ...now().sent!, outcome: 'done' },
      rejected: undefined,
    });
    assert.deepEqual(state(), [false, false], 'answered again');

    store.update(a.id, { done: true });
    assert.deepEqual(state(), [false, false], 'approved');

    store.update(a.id, { addenda: [...now().addenda, 'one more thing'] });
    assert.deepEqual(state(), [false, false], 'nothing is owed on a note you have finished with');

    // The step that used to lose it: settling the note moved the sent mark over the turn,
    // which cannot be undone.
    store.update(a.id, { done: false });
    assert.deepEqual(state(), [false, true], 'reopened, and the turn is owed again');
    assert.ok(now().addenda.includes('one more thing'), 'word for word');
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

    // What the ✓ button does, and all it does.
    store.update(a.id, { done: true });

    const after = store.getById(a.id)!;
    assert.equal(after.done, true);
    assert.equal(hasUnsentReply(after), false, 'nothing is owed once you are finished');
    assert.equal(after.addenda.length, 2, 'the turns stay in the thread');
  });

  it('gives the unsent follow-up back when the note is reopened', () => {
    // It used to settle this by moving the sent mark forward over the turn, which cannot be
    // undone: reopening left the turn in the thread looking delivered, with no way to send it
    // and nothing saying so. The user believes they asked something Claude never saw.
    const store = makeStore();
    const a = store.add(input());
    store.markSent([a.id]);
    store.update(a.id, { addenda: ['Claude: done — added the comment', 'ok but also this'] });
    store.update(a.id, { done: true });
    assert.equal(hasUnsentReply(store.getById(a.id)!), false, 'settled');

    store.update(a.id, { done: false });
    assert.equal(hasUnsentReply(store.getById(a.id)!), true, 'and owed again, word for word');
    assert.ok(store.getById(a.id)!.addenda.includes('ok but also this'));
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
