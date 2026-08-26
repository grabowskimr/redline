import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deliveryToken, discardHandover, stageForHandover } from '../../claude/handover';
import { projectSlug } from '../../claude/transcripts';

describe('handing a batch to the plugin', () => {
  let home: string;
  const ROOT = '/Users/me/work/repo';
  const dir = (): string => path.join(home, '.claude', 'redline', projectSlug(ROOT));

  const writeMarker = async (over: Record<string, unknown> = {}): Promise<void> => {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(
      path.join(dir(), 'hook.json'),
      JSON.stringify({ name: 'redline', version: 1, token: 'redline-review', at: new Date().toISOString(), ...over }),
      'utf8',
    );
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-handover-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('reports no token when the plugin has never run here', async () => {
    assert.equal(await deliveryToken(ROOT, home), undefined);
  });

  it('reports the token the hook itself named', async () => {
    await writeMarker({ token: 'something-else' });
    assert.equal(await deliveryToken(ROOT, home), 'something-else');
  });

  it('ignores a marker from a plugin that is no longer in use', async () => {
    await writeMarker({ at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() });
    assert.equal(await deliveryToken(ROOT, home), undefined, 'two months stale');
  });

  it('ignores a marker left by something else', async () => {
    await writeMarker({ name: 'other-tool' });
    assert.equal(await deliveryToken(ROOT, home), undefined);
  });

  it('ignores an unreadable marker rather than throwing', async () => {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(path.join(dir(), 'hook.json'), '{ truncated', 'utf8');
    assert.equal(await deliveryToken(ROOT, home), undefined);
  });

  it('stages the batch where the hook looks for it', async () => {
    const batch = 'I reviewed the generated code…\n\n#3 — src/a.ts\n  User comment: rename "this"\n';
    await stageForHandover(ROOT, batch, home);
    assert.equal(await fs.readFile(path.join(dir(), 'outbox.md'), 'utf8'), batch);
    // Nothing half-written is left behind for the hook to pick up.
    assert.deepEqual(
      (await fs.readdir(dir())).filter((f) => f.endsWith('.tmp')),
      [],
    );
  });

  it('replaces a batch that was staged but never collected', async () => {
    await stageForHandover(ROOT, 'first', home);
    await stageForHandover(ROOT, 'second', home);
    assert.equal(await fs.readFile(path.join(dir(), 'outbox.md'), 'utf8'), 'second');
  });

  it('discards a staged batch, and does not mind if there is none', async () => {
    await stageForHandover(ROOT, 'unsent', home);
    await discardHandover(ROOT, home);
    assert.equal(await fs.readdir(dir()).then((f) => f.includes('outbox.md')), false);
    await discardHandover(ROOT, home); // again, on nothing
  });
});
