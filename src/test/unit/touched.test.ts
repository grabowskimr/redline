import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { touchedLogPath, touchedPathsSince, touchedSince } from '../../claude/touched';

describe('hook attribution log', () => {
  let home: string;
  const CWD = '/Users/me/work/my.repo';
  const SINCE = Date.parse('2026-08-26T10:00:00.000Z');

  const write = async (lines: string[]): Promise<void> => {
    const file = touchedLogPath(CWD, home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-hook-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('puts the log where Claude Code keeps its own per-directory state', () => {
    assert.equal(
      touchedLogPath('/Users/me/work/my.repo', '/home'),
      path.join('/home', '.claude', 'redline', '-Users-me-work-my-repo', 'touched.jsonl'),
    );
  });

  it('distinguishes "no hook installed" from "hook installed, nothing touched"', async () => {
    assert.equal(await touchedSince(CWD, SINCE, home), undefined, 'no log at all');
    await write([]);
    assert.deepEqual(await touchedSince(CWD, SINCE, home), [], 'empty log');
  });

  it('keeps entries from the run and drops earlier ones', async () => {
    await write([
      JSON.stringify({ at: '2026-08-26T09:00:00.000Z', session: 's', file: `${CWD}/old.ts`, via: 'edit' }),
      JSON.stringify({ at: '2026-08-26T10:05:00.000Z', session: 's', file: `${CWD}/new.ts`, via: 'edit' }),
    ]);
    const entries = await touchedSince(CWD, SINCE, home);
    assert.deepEqual(entries?.map((e) => e.file), [`${CWD}/new.ts`]);
  });

  it('skips a partial trailing line without losing the rest', async () => {
    await write([
      JSON.stringify({ at: '2026-08-26T10:05:00.000Z', session: 's', file: `${CWD}/a.ts`, via: 'edit' }),
      '{"at":"2026-08-26T10:06:00.000Z","file":"/half-writ',
    ]);
    const entries = await touchedSince(CWD, SINCE, home);
    assert.deepEqual(entries?.map((e) => e.file), [`${CWD}/a.ts`]);
  });

  it('returns repo-relative paths and drops anything outside the repo', async () => {
    await write([
      JSON.stringify({ at: '2026-08-26T10:05:00.000Z', session: 's', file: `${CWD}/src/a.ts`, via: 'edit' }),
      JSON.stringify({ at: '2026-08-26T10:06:00.000Z', session: 's', file: '/Users/me/notes/plan.md', via: 'edit' }),
    ]);
    const paths = await touchedPathsSince(CWD, CWD, SINCE, home);
    assert.deepEqual([...(paths ?? [])], ['src/a.ts']);
  });
});

describe('what the run has touched so far', () => {
  let home: string;
  const repo = '/tmp/live/repo';

  const log = (lines: Array<Record<string, unknown>>): Promise<void> =>
    fs.writeFile(touchedLogPath(repo, home), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-live-'));
    await fs.mkdir(path.dirname(touchedLogPath(repo, home)), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('names the file most recently written, which is what the panel shows', async () => {
    // The session's own terminal shows this; the panel had nothing to say between "a run
    // started" and "a run finished".
    const at = (ms: number): string => new Date(Date.now() - ms).toISOString();
    await log([
      { at: at(3000), session: 's', file: `${repo}/src/first.ts`, via: 'edit' },
      { at: at(2000), session: 's', file: `${repo}/src/second.ts`, via: 'edit' },
      { at: at(1000), session: 's', file: `${repo}/src/second.ts`, via: 'edit' },
    ]);
    const entries = (await touchedSince(repo, Date.now() - 10_000, home)) ?? [];
    assert.equal(entries[entries.length - 1]?.file, `${repo}/src/second.ts`, 'the newest write');
    assert.equal(new Set(entries.map((e) => e.file)).size, 2, 'two distinct files this run');
  });

  it('leaves out what an earlier run touched', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await log([
      { at: old, session: 's', file: `${repo}/src/old.ts`, via: 'edit' },
      { at: new Date().toISOString(), session: 's', file: `${repo}/src/now.ts`, via: 'edit' },
    ]);
    const entries = (await touchedSince(repo, Date.now() - 60_000, home)) ?? [];
    assert.deepEqual(entries.map((e) => e.file), [`${repo}/src/now.ts`]);
  });
});
