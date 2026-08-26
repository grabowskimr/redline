import * as assert from 'node:assert/strict';
import { parseDiffByFile, parseHunks } from '../../git/hunks';

describe('parseHunks', () => {
  it('parses hunk headers into 0-based inclusive ranges on the new side', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,4 @@',
      ' a',
      '+b',
      '@@ -10 +11 @@',
      '-c',
      '+d',
      '@@ -20,2 +22,0 @@',
      '-e',
      '-f',
    ].join('\n');
    assert.deepEqual(parseHunks(diff), [
      { start: 0, end: 3 },
      { start: 10, end: 10 },
    ]);
  });
  it('returns nothing for empty diff', () => {
    assert.deepEqual(parseHunks(''), []);
  });
});

describe('parseDiffByFile', () => {
  it('includes deletion-only files with a join marker', () => {
    const diff = [
      'diff --git a/keep.ts b/keep.ts',
      '--- a/keep.ts',
      '+++ b/keep.ts',
      '@@ -10,3 +9,0 @@ context',
      '-// a comment',
      '-// another',
      '-// third',
      'diff --git a/mod.ts b/mod.ts',
      '--- a/mod.ts',
      '+++ b/mod.ts',
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
    ].join('\n');
    const files = parseDiffByFile(diff);
    assert.deepEqual(files, [
      { path: 'keep.ts', hunks: [{ start: 8, end: 8, deletion: true }] },
      { path: 'mod.ts', hunks: [{ start: 0, end: 1 }] },
    ]);
  });
  it('deletion at the top of the file clamps to line 0', () => {
    const files = parseDiffByFile(['--- a/x', '+++ b/x', '@@ -1,2 +0,0 @@'].join('\n'));
    assert.deepEqual(files[0]?.hunks, [{ start: 0, end: 0, deletion: true }]);
  });
});

describe('parseDiffByFile deletions', () => {
  it('keeps a fully deleted file under its old name', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
      'diff --git a/kept.ts b/kept.ts',
      '--- a/kept.ts',
      '+++ b/kept.ts',
      '@@ -1,0 +2,1 @@',
      '+added',
    ].join('\n');
    assert.deepEqual(parseDiffByFile(diff), [
      { path: 'gone.ts', hunks: [{ start: 0, end: 0, deletion: true }] },
      { path: 'kept.ts', hunks: [{ start: 1, end: 1 }] },
    ]);
  });

  it('handles a new file (no old side)', () => {
    const diff = ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+x', '+y'].join('\n');
    assert.deepEqual(parseDiffByFile(diff), [{ path: 'new.ts', hunks: [{ start: 0, end: 1 }] }]);
  });
});
