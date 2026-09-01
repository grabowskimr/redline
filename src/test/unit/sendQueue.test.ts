import * as assert from 'node:assert/strict';
import { SendQueue } from '../../commands/sendQueue';

describe('notes held until the agent goes quiet', () => {
  const here = (): ((id: string) => boolean) => () => true;

  it('holds two follow-ups written before the first was answered', () => {
    /*
     * The reported case, and the one a bare `true` could not represent: reply to one card,
     * send it while Claude is working, then reply to a second and send that too. Both are
     * held, both go, and they go together.
     */
    const q = new SendQueue();
    q.hold(['a']);
    q.hold(['b']);
    assert.equal(q.size, 2);
    assert.deepEqual(q.take(here()), ['a', 'b'], 'in the order they were asked for');
    assert.equal(q.size, 0, 'and the queue is empty afterwards');
  });

  it('holds a note once however many times send is pressed', () => {
    // Pressing send again on a card that is already waiting is someone checking it is still
    // there, not a second request — and sending the same note twice in one message is nonsense.
    const q = new SendQueue();
    q.hold(['a']);
    q.hold(['a']);
    assert.deepEqual(q.take(here()), ['a']);
  });

  it('drops a note that has gone since it was queued', () => {
    // Deleted, or cleared with the round. Sending an id the store no longer has produces an
    // empty message, which reads to the agent as a request with nothing in it.
    const q = new SendQueue();
    q.hold(['a', 'b']);
    assert.deepEqual(q.take((id) => id !== 'a'), ['b']);
  });

  it('sends nothing at all when everything queued has gone', () => {
    const q = new SendQueue();
    q.hold(['a']);
    assert.deepEqual(q.take(() => false), []);
  });

  it('tells the panel when it starts and stops holding, and not otherwise', () => {
    // The card says it is waiting; without a signal it looked exactly as it did before the
    // click, which reads as a button that does nothing.
    let changes = 0;
    const q = new SendQueue(() => {
      changes += 1;
    });
    q.hold(['a']);
    assert.equal(changes, 1);
    q.hold(['a']);
    assert.equal(changes, 1, 'nothing changed, so nothing is announced');
    q.hold(['b']);
    assert.equal(changes, 2);
    q.take(here());
    assert.equal(changes, 3);
    q.take(here());
    assert.equal(changes, 3, 'an empty queue emptied again is not news');
  });

  it('lets whoever sends a note first claim it', () => {
    /*
     * A held note carries no mark of its own — nothing is written on the note itself — so it
     * is an ordinary unsent note to every other send path. "Send all" took one while it was
     * waiting, and the flush that came afterwards sent it a second time, to an agent that had
     * just been given it.
     */
    const q = new SendQueue();
    q.hold(['a', 'b']);
    q.drop(['a']);
    assert.deepEqual(q.take(here()), ['b'], 'the one that was claimed does not go twice');
  });

  it('says nothing when asked to drop something it was not holding', () => {
    let changes = 0;
    const q = new SendQueue(() => {
      changes += 1;
    });
    q.drop(['a']);
    assert.equal(changes, 0);
  });

  it('can be called off, and says whether there was anything to call off', () => {
    const q = new SendQueue();
    assert.equal(q.cancel(), false, 'nothing was waiting');
    q.hold(['a']);
    assert.equal(q.cancel(), true);
    assert.equal(q.size, 0);
  });

  it('knows whether a particular card is holding', () => {
    const q = new SendQueue();
    q.hold(['a']);
    assert.equal(q.has('a'), true);
    assert.equal(q.has('b'), false);
  });
});
