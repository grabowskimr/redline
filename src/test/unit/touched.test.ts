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
