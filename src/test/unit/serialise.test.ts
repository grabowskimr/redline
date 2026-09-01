import * as assert from 'node:assert/strict';
import { serialiser } from '../../commands/serialise';

describe('running sends one at a time', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('never lets one send finish inside another', async () => {
    /*
     * The interleaving this exists to stop: a queue flush and a manual send both in flight.
     * Each ends by archiving every note it did not itself send, on the understanding that
     * those are the previous round — so the second one deletes the first one's notes seconds
     * after they went, and the answer that comes back names notes that are no longer here.
     */
    const run = serialiser();
    const log: string[] = [];
    const send = (name: string, ms: number): Promise<void> =>
      run(async () => {
        log.push(`${name}:start`);
        await wait(ms);
        log.push(`${name}:finish`);
      });

    // The slow one first, so an unserialised pair would certainly interleave.
    await Promise.all([send('flush', 30), send('manual', 1)]);
    assert.deepEqual(log, ['flush:start', 'flush:finish', 'manual:start', 'manual:finish']);
  });

  it('keeps the order they were asked for', async () => {
    const run = serialiser();
    const log: number[] = [];
    await Promise.all([1, 2, 3].map((n) => run(async () => {
      await wait(4 - n);
      log.push(n);
    })));
    assert.deepEqual(log, [1, 2, 3]);
  });

  it('carries a result back to its own caller', async () => {
    const run = serialiser();
    assert.equal(await run(async () => 'sent'), 'sent');
  });

  it('does not wedge every send after one that failed', async () => {
    // A send can fail for any number of ordinary reasons — no session, a terminal that closed.
    // If a rejection stayed on the chain, the next one would never run at all.
    const run = serialiser();
    await assert.rejects(run(async () => {
      throw new Error('no session');
    }));
    assert.equal(await run(async () => 'still works'), 'still works');
  });
});
