import * as assert from 'node:assert/strict';
import { RUN_GRACE_MS, selectRunFiles } from '../../git/runFiles';

describe('selectRunFiles', () => {
  const RUN_START = Date.parse('2026-08-26T10:39:27.000Z');
  const mins = (n: number): number => RUN_START + n * 60_000;
  const select = (
    files: string[],
    mtimes: Record<string, number | undefined>,
    committed: string[] = [],
  ): string[] =>
    selectRunFiles(files, {
      committed: new Set(committed),
      mtimeOf: (f) => mtimes[f],
      since: RUN_START,
    });

  it('keeps files touched during the run and drops earlier work', () => {
    // The real case this was reported for: 11 changed files spanning three days.
    const files = ['old-a.tsx', 'old-b.scss', 'run-a.tsx', 'run-b.json'];
    assert.deepEqual(
      select(files, {
        'old-a.tsx': mins(-2880), // two days before
        'old-b.scss': mins(-1690),
        'run-a.tsx': mins(1),
        'run-b.json': mins(7),
      }),
      ['run-a.tsx', 'run-b.json'],
    );
  });

  it('keeps a file the agent committed early even though its mtime predates the run', () => {
    assert.deepEqual(
      select(['committed.ts', 'stale.ts'], { 'committed.ts': mins(-600), 'stale.ts': mins(-600) }, ['committed.ts']),
      ['committed.ts'],
      'git answers for committed work, mtimes for the rest',
    );
  });

  it('keeps files it cannot date rather than hiding them', () => {
    assert.deepEqual(select(['deleted.ts'], { 'deleted.ts': undefined }), ['deleted.ts']);
  });

  it('allows for the write following the agent\'s own timestamp', () => {
    const justBefore = RUN_START - RUN_GRACE_MS + 1_000;
    const wellBefore = RUN_START - RUN_GRACE_MS - 1_000;
    assert.deepEqual(select(['a.ts', 'b.ts'], { 'a.ts': justBefore, 'b.ts': wellBefore }), ['a.ts']);
  });

  it('returns everything when the run start is not a usable timestamp', () => {
    const files = ['a.ts', 'b.ts'];
    assert.deepEqual(
      selectRunFiles(files, { committed: new Set(), mtimeOf: () => mins(-9999), since: Number.NaN }),
      files,
    );
  });

  describe('with hook attribution', () => {
    it('trusts the hook over timestamps, so your own saves are not blamed on the agent', () => {
      const files = ['agent-wrote.ts', 'you-saved.ts'];
      const now = mins(2);
      assert.deepEqual(
        selectRunFiles(files, {
          committed: new Set(),
          attributed: new Set(['agent-wrote.ts']),
          untracked: new Set(),
          mtimeOf: () => now, // both touched inside the run window
          since: RUN_START,
        }),
        ['agent-wrote.ts'],
      );
    });

    it('dates untracked files, so an older one is not this run\'s work', () => {
      // Treating every untracked file as current put files created days earlier at the top of
      // "the last run", burying the few things that had just changed.
      assert.deepEqual(
        selectRunFiles(['brand-new.ts', 'older-untracked.ts'], {
          committed: new Set(),
          attributed: new Set(),
          untracked: new Set(['brand-new.ts', 'older-untracked.ts']),
          mtimeOf: (f) => (f === 'brand-new.ts' ? mins(3) : mins(-5000)),
          since: RUN_START,
        }),
        ['brand-new.ts'],
      );
    });

    it('still excludes a tracked file the agent did not touch', () => {
      assert.deepEqual(
        selectRunFiles(['agent.ts', 'yours.ts'], {
          committed: new Set(),
          attributed: new Set(['agent.ts']),
          untracked: new Set(),
          mtimeOf: () => mins(2),
          since: RUN_START,
        }),
        ['agent.ts'],
      );
    });

    it('keeps committed work even when the hook did not name it', () => {
      assert.deepEqual(
        selectRunFiles(['committed.ts'], {
          committed: new Set(['committed.ts']),
          attributed: new Set(),
          untracked: new Set(),
          mtimeOf: () => mins(-9999),
          since: RUN_START,
        }),
        ['committed.ts'],
      );
    });
  });

  it('does not invent files that are not in the changed list', () => {
    assert.deepEqual(select(['a.ts'], { 'a.ts': mins(-5000) }, ['a.ts', 'never-changed.ts']), ['a.ts']);
  });
});
