import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discardReport, readReport, reportPath, takeReport } from '../../claude/reportFile';
import { projectSlug } from '../../claude/transcripts';

describe('the report a run leaves behind', () => {
  let home: string;
  const repo = '/tmp/some/repo';

  const write = (body: unknown): Promise<void> =>
    fs.writeFile(reportPath(repo, home), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-report-'));
    await fs.mkdir(path.join(home, '.claude', 'redline', projectSlug(repo)), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('reads the outcomes exactly, with no prose to interpret', async () => {
    await write({
      notes: [
        { seq: 12, outcome: 'done', text: 'removed the comment' },
        { seq: 13, outcome: 'skipped', text: 'it is load-bearing' },
        { seq: 14, outcome: 'answered', text: 'because of the cache' },
      ],
    });
    assert.deepEqual(await takeReport(repo, home), [
      { seq: 12, outcome: 'done', text: 'removed the comment' },
      { seq: 13, outcome: 'skipped', text: 'it is load-bearing' },
      { seq: 14, outcome: 'answered', text: 'because of the cache' },
    ]);
  });

  it('accepts the field names a model reaches for anyway', async () => {
    await write({ notes: [{ note: 7, outcome: 'fixed' }, { id: 8, outcome: 'declined' }] });
    assert.deepEqual(await takeReport(repo, home), [
      { seq: 7, outcome: 'done' },
      { seq: 8, outcome: 'skipped' },
    ]);
  });

  it('accepts a bare array as well as an object', async () => {
    await write([{ seq: 3, outcome: 'done' }]);
    assert.equal((await takeReport(repo, home))?.length, 1);
  });

  it('treats anything it does not recognise as answered rather than dropping it', async () => {
    await write({ notes: [{ seq: 4, outcome: 'partially done, see below' }] });
    assert.equal((await takeReport(repo, home))?.[0]?.outcome, 'answered');
  });

  it('cannot be applied twice — a later round must not inherit it', async () => {
    await write({ notes: [{ seq: 1, outcome: 'done' }] });
    assert.ok(await takeReport(repo, home));
    assert.equal(await takeReport(repo, home), undefined, 'consumed');
    // Kept beside the original name, so a failure to apply it is still inspectable.
    await fs.stat(`${reportPath(repo, home)}.applied`);
  });

  it('says nothing when a run wrote no report, so the prose fallback answers', async () => {
    assert.equal(await takeReport(repo, home), undefined);
  });

  it('says nothing for a file that is not the JSON we asked for', async () => {
    await write('I have finished all three notes!');
    assert.equal(await takeReport(repo, home), undefined);
    await write({ notes: [{ text: 'no number anywhere' }] });
    assert.equal(await takeReport(repo, home), undefined);
  });

  it('can be read over and over while the run is still going', async () => {
    /*
     * The agent is asked to write this file again each time it settles a note, so the panel
     * can answer a card seconds after the edit instead of when the whole turn ends. That means
     * reading it many times over one run — and consuming it halfway through would throw away
     * every note still to come.
     */
    await write({ notes: [{ seq: 1, outcome: 'done', text: 'renamed it' }] });
    assert.equal((await readReport(repo, home))?.length, 1);
    assert.equal((await readReport(repo, home))?.length, 1, 'still there');

    await write({
      notes: [
        { seq: 1, outcome: 'done', text: 'renamed it' },
        { seq: 2, outcome: 'skipped', text: 'not this one' },
      ],
    });
    assert.equal((await readReport(repo, home))?.length, 2, 'and it grows as the run goes');

    // The end of the run still takes it, so the next round does not open on top of it.
    assert.equal((await takeReport(repo, home))?.length, 2);
    assert.equal(await readReport(repo, home), undefined, 'consumed');
  });

  it('can be thrown away when a new round starts', async () => {
    await write({ notes: [{ seq: 1, outcome: 'done' }] });
    await discardReport(repo, home);
    assert.equal(await takeReport(repo, home), undefined);
  });
});

describe('a report that is still being written', () => {
  /*
   * The agent writes the report file while the run is going, and Redline reads it while the run
   * is going, so a read lands mid-write often enough to matter. JSON that has started and not
   * finished must be told apart from prose that will never be JSON: the first is worth waiting
   * for, the second is not.
   *
   * Consuming a half-written report silently loses a whole round's outcomes — every note in it
   * stays "waiting for Claude" over work that is already done. Nothing covered this branch, so
   * removing the guard passed the whole suite.
   */
  const ROOT = '/repo/partial';
  const stage = async (body: string): Promise<{ home: string; file: string }> => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-partial-'));
    const dir = path.join(home, '.claude', 'redline', projectSlug(ROOT));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'report.json');
    await fs.writeFile(file, body, 'utf8');
    return { home, file };
  };

  it('refuses a half-written report and leaves it where it is', async () => {
    const { home, file } = await stage('{ "notes": [ { "seq": 1, "outcome": "done"');

    await assert.rejects(
      () => takeReport(ROOT, home),
      (err: Error) => err.name === 'PartialReport',
    );
    assert.ok(await fs.stat(file).then(() => true, () => false), 'left on disk — the next read finishes it');
    await fs.rm(home, { recursive: true, force: true });
  });

  it('gives up on something that was never going to be JSON', async () => {
    // Prose in the report file is not a write in progress; waiting for it to become JSON would
    // wait forever, so this consumes the file rather than throwing `PartialReport`.
    const { home } = await stage('I had a look and it all seems fine');

    assert.equal(await takeReport(ROOT, home), undefined, 'nothing to apply');
    await fs.rm(home, { recursive: true, force: true });
  });
});
