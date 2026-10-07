import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffStats, parseDiffStats } from '../../git/diffStats';
import { gitIn } from '../../git/savedComparison';

describe('file change statistics', () => {
  it('preserves unusual paths, rename destinations and binary markers', () => {
    const stats = parseDiffStats('2\t3\tline\nwith\ttab.ts\0-\t-\tphoto.png\0' + '1\t0\t\0old name.ts\0new name.ts\0');
    assert.deepEqual(stats.get('line\nwith\ttab.ts'), { added: 2, deleted: 3, binary: false });
    assert.deepEqual(stats.get('photo.png'), { added: 0, deleted: 0, binary: true });
    assert.deepEqual(stats.get('new name.ts'), { added: 1, deleted: 0, binary: false });
    assert.equal(stats.has('old name.ts'), false);
  });
  it('ignores malformed or incomplete records', () => {
    assert.equal(parseDiffStats('oops\0-\t2\tbad.ts\0x\t1\tbad.ts\0' + '0\t0\t\0old.ts\0').size, 0);
  });
  it('reads actual Git numstat for renames, deletion, addition and binary content', async function () {
    this.timeout(10000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-stats-')), git = gitIn(root);
    try {
      await git(['init', '-q']);
      await fs.writeFile(path.join(root, 'old.ts'), 'one\ntwo\nthree\nfour\nfive\n');
      await fs.writeFile(path.join(root, 'delete.ts'), 'remove\n');
      await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
      await git(['add', '.']); const before = (await git(['write-tree'])).trim();
      await fs.rename(path.join(root, 'old.ts'), path.join(root, 'new\tname.ts'));
      await fs.appendFile(path.join(root, 'new\tname.ts'), 'six\n');
      await fs.unlink(path.join(root, 'delete.ts'));
      await fs.writeFile(path.join(root, 'add\nfile.ts'), 'added\n');
      await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 2, 3]));
      await git(['add', '-A']); const after = (await git(['write-tree'])).trim();
      const stats = await diffStats(root, before, after);
      assert.equal(stats.size, 4);
      assert.deepEqual(stats.get('new\tname.ts'), { added: 1, deleted: 0, binary: false });
      assert.deepEqual(stats.get('delete.ts'), { added: 0, deleted: 1, binary: false });
      assert.deepEqual(stats.get('add\nfile.ts'), { added: 1, deleted: 0, binary: false });
      assert.equal(stats.get('binary.dat')?.binary, true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
