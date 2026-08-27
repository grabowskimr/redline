import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRunTrees, readStopMarker } from '../../claude/runTrees';
import { projectSlug } from '../../claude/transcripts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('run trees recorded by the hook', () => {
  let home: string;
  let repo: string;
  let dir: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-runtrees-'));
    repo = '/tmp/some/repo';
    dir = path.join(home, '.claude', 'redline', projectSlug(repo));
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const started = (body: unknown): Promise<void> =>
    fs.writeFile(path.join(dir, 'runs.json'), JSON.stringify(body), 'utf8');
  const stopped = (body: unknown): Promise<void> =>
    fs.writeFile(path.join(dir, 'stopped.json'), JSON.stringify(body), 'utf8');

  it('reads the start of the run from one file and its end from the other', async () => {
    await started({ before: { at: '2026-08-27T10:00:00.000Z', tree: A } });
    await stopped({ at: '2026-08-27T10:04:00.000Z', session: 's', tree: B });
    const trees = await readRunTrees(repo, home);
    assert.equal(trees?.before?.tree, A);
    assert.equal(trees?.after?.tree, B);
  });

  it('returns the start alone while the run is still going', async () => {
    await started({ before: { at: '2026-08-27T10:00:00.000Z', tree: A } });
    const trees = await readRunTrees(repo, home);
    assert.equal(trees?.before?.tree, A);
    assert.equal(trees?.after, undefined, 'nothing has stopped yet');
  });

  it('ignores a stop marker from a hook version that records no tree', async () => {
    await started({ before: { at: '2026-08-27T10:00:00.000Z', tree: A } });
    await stopped({ at: '2026-08-27T10:04:00.000Z', session: 's' });
    const trees = await readRunTrees(repo, home);
    assert.equal(trees?.after, undefined);
  });

  it('carries the session each end of the run belongs to', async () => {
    await started({ before: { at: '2026-08-27T10:00:00.000Z', tree: A, session: 'one' } });
    await stopped({ at: '2026-08-27T10:04:00.000Z', session: 'two', tree: B });
    const trees = await readRunTrees(repo, home);
    assert.equal(trees?.before?.session, 'one');
    assert.equal(trees?.after?.session, 'two', 'a different session stopped — a mismatched pair');
  });

  it('leaves the session unset for a hook version that does not record it', async () => {
    await started({ before: { at: '2026-08-27T10:00:00.000Z', tree: A } });
    assert.equal((await readRunTrees(repo, home))?.before?.session, undefined);
  });

  it('rejects anything that is not a tree hash, rather than passing it to git', async () => {
    await started({ before: { at: '2026-08-27T10:00:00.000Z', tree: 'HEAD; rm -rf /' } });
    assert.equal(await readRunTrees(repo, home), undefined);
  });

  it('survives a half-written file', async () => {
    await fs.writeFile(path.join(dir, 'runs.json'), '{"before": {"at": "2026', 'utf8');
    assert.equal(await readRunTrees(repo, home), undefined);
  });

  it('says nothing when the hook is not installed', async () => {
    assert.equal(await readRunTrees('/tmp/never/used', home), undefined);
  });
});

describe('the marker a finished run leaves behind', () => {
  let home: string;
  let repo: string;
  let dir: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-stop-'));
    repo = '/tmp/some/repo';
    dir = path.join(home, '.claude', 'redline', projectSlug(repo));
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const stopped = (body: unknown): Promise<void> =>
    fs.writeFile(path.join(dir, 'stopped.json'), JSON.stringify(body), 'utf8');

  it('names the run, the session and the tree it left', async () => {
    await stopped({ at: '2026-08-27T12:00:00.000Z', session: 'abc-123', tree: B });
    const marker = await readStopMarker(repo, home);
    assert.equal(marker?.at, '2026-08-27T12:00:00.000Z');
    assert.equal(marker?.session, 'abc-123');
    assert.equal(marker?.tree, B);
  });

  it('still reports the run when the hook is too old to record a tree', async () => {
    // Awareness must not depend on the newest hook: the run still happened.
    await stopped({ at: '2026-08-27T12:00:00.000Z', session: 'abc-123' });
    const marker = await readStopMarker(repo, home);
    assert.equal(marker?.at, '2026-08-27T12:00:00.000Z');
    assert.equal(marker?.tree, undefined);
  });

  it('tolerates a marker with no session', async () => {
    await stopped({ at: '2026-08-27T12:00:00.000Z' });
    assert.equal((await readStopMarker(repo, home))?.session, '');
  });

  it('is undefined when no run has finished, so nothing is reported', async () => {
    assert.equal(await readStopMarker(repo, home), undefined);
  });

  it('rejects a marker with no usable timestamp, which cannot identify a run', async () => {
    await stopped({ at: 'whenever', session: 'abc' });
    assert.equal(await readStopMarker(repo, home), undefined);
  });
});
