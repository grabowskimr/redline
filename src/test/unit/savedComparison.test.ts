import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitIn, savedDiff } from '../../git/savedComparison';
import { ReviewFiles } from '../../view/reviewFiles';
import { snapshotWorkingTree } from '../../git/snapshotTree';

describe('saved diff resources', () => {
  it('keeps added, deleted, renamed and binary sides after Git garbage collection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-saved-fix-'));
    const git = gitIn(root);
    (vscode as unknown as { resetStub(): void }).resetStub();
    try {
      await git(['init', '-q']);
      await fs.writeFile(path.join(root, 'old.ts'), 'export const a = 1;\n'.repeat(10));
      await fs.writeFile(path.join(root, 'deleted.ts'), 'delete me\n');
      await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]));
      const before = await snapshotWorkingTree(root, git); assert.ok(before);
      await fs.rename(path.join(root, 'old.ts'), path.join(root, 'new.ts'));
      await fs.rm(path.join(root, 'deleted.ts'));
      await fs.writeFile(path.join(root, 'added.ts'), 'added\n');
      await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 2, 3]));
      const after = await snapshotWorkingTree(root, git); assert.ok(after);
      let published: { root: string; before: string; after: string; completed: boolean } | undefined = { root, before, after, completed: true };
      const files = new ReviewFiles({ repoRoot: async () => root, summary: async () => ({ base: before, label: 'base', recentLabel: 'last run', recent: [] }),
        diffResources: () => savedDiff(root, before, after), runComparison: () => published, savedFileFingerprint: uri => uri.toString() }, { get: () => undefined, update: async () => {} } as never);
      try {
        await files.refresh('recent');
        published = undefined; // A newer hook record invalidated the range after the list loaded.
        assert.equal(await files.open(files.state.files[0]!.id), true);
      } finally { files.dispose(); }
      await git(['gc', '--prune=now']);
      const pairs = await savedDiff(root, before, after);
      const pair = (name: string) => pairs.find((p) => p[0].fsPath === path.join(root, name))!;
      assert.equal(pairs.length, 4);
      assert.equal(pair('added.ts')[1].scheme, 'redline-empty');
      assert.equal(pair('deleted.ts')[2].scheme, 'redline-empty');
      assert.equal(pair('new.ts')[1].path, '/old.ts');
      assert.equal(pair('new.ts')[2].path, '/new.ts');
      assert.equal(pair('image.bin')[1].scheme, 'redline-tree');
      assert.equal(pair('image.bin')[2].scheme, 'redline-tree');
      assert.equal(await git(['show', `${after}:added.ts`]), 'added\n');
      assert.equal(await git(['show', `${before}:deleted.ts`]), 'delete me\n');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
