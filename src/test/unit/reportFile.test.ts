import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discardReport, reportPath, takeReport } from '../../claude/reportFile';
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

  it('can be thrown away when a new round starts', async () => {
    await write({ notes: [{ seq: 1, outcome: 'done' }] });
    await discardReport(repo, home);
    assert.equal(await takeReport(repo, home), undefined);
  });
});
