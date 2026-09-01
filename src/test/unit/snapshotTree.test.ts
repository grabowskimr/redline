import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binaryPaths, EMPTY_TREE, GitRunner, nulFields, snapshotWorkingTree, treeChanges } from '../../git/snapshotTree';

const execFileP = promisify(execFile);

/**
 * Against real git, because the whole point of this mechanism is what git actually does with
 * a throwaway index. A mock would only assert that the arguments are the ones I wrote.
 */
describe('NUL-separated git output', () => {
  it('drops the trailing terminator without losing an empty record in the middle', () => {
    assert.deepEqual(nulFields('a\0b\0'), ['a', 'b']);
    assert.deepEqual(nulFields(''), []);
    assert.deepEqual(nulFields('only\0'), ['only']);
    // A rename's numstat record legitimately ends in an empty path field.
    assert.deepEqual(nulFields('0\t0\t\0old\0new\0'), ['0\t0\t', 'old', 'new']);
  });
});

describe('working-tree snapshots', () => {
  let repo: string;
  let git: GitRunner;

  const write = (rel: string, body: string): Promise<void> =>
    fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true }).then(() =>
      fs.writeFile(path.join(repo, rel), body, 'utf8'),
    );

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-tree-'));
    git = async (args, env) => {
      const { stdout } = await execFileP('git', args, {
        cwd: repo,
        env: env ? { ...process.env, ...env } : process.env,
      });
      return stdout;
    };
    await git(['init', '-q', '.']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await write('kept.ts', 'export const kept = 1\n');
    await write('gone.ts', 'export const gone = 1\n');
    await write('edited.ts', 'export const edited = 1\n');
    await write('.gitignore', 'build/\n');
    await git(['add', '-A']);
    await git(['commit', '-qm', 'base']);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('reports every kind of change a run can make, between two snapshots', async () => {
    const before = await snapshotWorkingTree(repo, git);
    assert.ok(before, 'a snapshot of the clean tree');

    // What a run typically does: extract a helper, write its test, delete something, move
    // something, edit the file that now imports the helper, and leave build output behind.
    await write('utils.ts', 'export const helper = () => 1\n');
    await write('utils.test.ts', 'it("helps", () => {})\n');
    await fs.rm(path.join(repo, 'gone.ts'));
    await git(['mv', 'kept.ts', 'moved.ts']);
    await write('edited.ts', 'import { helper } from "./utils"\nexport const edited = helper()\n');
    await write('build/output.js', 'noise\n');

    const after = await snapshotWorkingTree(repo, git);
    assert.ok(after);
    assert.notEqual(after, before, 'the tree moved');

    const changes = await treeChanges(before, after, git);
    assert.deepEqual(
      [...changes].map(([f, s]) => [f, s.kind]).sort(),
      [
        ['edited.ts', 'modified'],
        ['gone.ts', 'deleted'],
        ['moved.ts', 'renamed'],
        ['utils.test.ts', 'added'],
        ['utils.ts', 'added'],
      ],
      'both new files, the deletion, the rename and the edit — and nothing ignored',
    );
    assert.equal((changes.get('moved.ts') as { from: string }).from, 'kept.ts', 'the path it came from');
  });

  it('leaves the repository index and working tree alone', async () => {
    const indexBefore = await fs.readFile(path.join(repo, '.git', 'index'));
    await write('new.ts', 'export const n = 1\n');
    await snapshotWorkingTree(repo, git);
    assert.deepEqual(await fs.readFile(path.join(repo, '.git', 'index')), indexBefore, 'index untouched');
    assert.equal(await git(['status', '--porcelain']), '?? new.ts\n', 'nothing staged on our behalf');
  });

  it('serves the content a file had at a snapshot, and nothing for one that did not exist', async () => {
    const before = await snapshotWorkingTree(repo, git);
    assert.ok(before);
    await write('edited.ts', 'changed\n');
    await write('brand-new.ts', 'fresh\n');

    assert.equal(await git(['show', `${before}:edited.ts`]), 'export const edited = 1\n');
    await assert.rejects(git(['show', `${before}:brand-new.ts`]), 'absent from that tree');
  });

  it('compares against the empty tree for a repository with no commits', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-tree-empty-'));
    try {
      const bare: GitRunner = async (args, env) => {
        const { stdout } = await execFileP('git', args, {
          cwd: fresh,
          env: env ? { ...process.env, ...env } : process.env,
        });
        return stdout;
      };
      await bare(['init', '-q', '.']);
      await fs.writeFile(path.join(fresh, 'first.ts'), 'export const first = 1\n', 'utf8');
      const tree = await snapshotWorkingTree(fresh, bare);
      assert.ok(tree, 'a tree even with no HEAD to copy an index from');
      const changes = await treeChanges(EMPTY_TREE, tree, bare);
      assert.deepEqual([...changes].map(([f, s]) => [f, s.kind]), [['first.ts', 'added']]);
    } finally {
      await fs.rm(fresh, { recursive: true, force: true });
    }
  });

  it('dates its throwaway index as the one it was copied from', async () => {
    /*
     * Why the timestamp matters, and what it cost: a run's changes going missing entirely,
     * about once in a few hundred.
     *
     * Staging skips a file whose stat still matches its index entry. What stops that from
     * hiding an edit is the index's own mtime — an entry stamped at or after it was written
     * too recently for its stat to prove anything, so git reads the file instead of trusting
     * it. Copying the index stamps the copy with the time of the copy, which left every entry
     * looking comfortably older than the index holding it: the check never fired, and an edit
     * landing in the same instant as the staging that recorded it was answered out of the
     * cache. Two snapshots, one tree, and a run that rewrote a file reported as changing
     * nothing — and it stayed wrong, because the stale entry survives until something
     * refreshes the real index.
     *
     * Asserted on the copy rather than through a doctored edit: the window is a fraction of a
     * second wide, so reproducing the symptom means recreating git's timing by hand, and a
     * test that only sometimes catches the regression is not one worth having.
     */
    const real = path.join(repo, '.git', 'index');
    const stamp = (await fs.stat(real, { bigint: true })).mtimeNs;

    let staged: bigint | undefined;
    const watched: GitRunner = async (args, env) => {
      // At the moment of staging: `add` is what consults the stat cache.
      if (args[0] === 'add' && env?.GIT_INDEX_FILE) {
        staged = (await fs.stat(env.GIT_INDEX_FILE, { bigint: true })).mtimeNs;
      }
      return git(args, env);
    };

    assert.ok(await snapshotWorkingTree(repo, watched));
    assert.ok(staged !== undefined, 'something was staged');
    // Millisecond resolution is all `utimes` carries, and the remainder is dropped rather than
    // rounded — erring towards a copy that looks older than its entries, which is the side
    // that re-reads the file.
    assert.ok(staged <= stamp, 'never dated later than the index it came from');
    assert.ok(stamp - staged < 1_000_000n, 'and within a millisecond of it');
  });

  it('names the files git will not diff as text, so they are never served as text', async () => {
    const before = await snapshotWorkingTree(repo, git);
    assert.ok(before);
    // A PNG header and some bytes git will refuse to treat as text.
    await fs.writeFile(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0]));
    await write('edited.ts', 'export const edited = 2\n');
    const after = await snapshotWorkingTree(repo, git);
    assert.ok(after);
    const binary = await binaryPaths(before, after, git);
    assert.deepEqual([...binary], ['logo.png'], 'the image, and not the source file beside it');
  });

  it('still produces a tree when a file vanishes while it is being staged', async () => {
    // `git add --ignore-errors` continues past a file it cannot read but still exits non-zero,
    // which is routine while an agent is moving files around. Abandoning the snapshot there
    // would fail exactly when the tree is changing fastest.
    await write('doomed.ts', 'export const doomed = 1\n');
    const flaky: GitRunner = async (args, env) => {
      if (args[0] === 'add') {
        await git(args, env);
        const err = new Error("warning: could not open 'doomed.ts'") as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      return git(args, env);
    };
    const tree = await snapshotWorkingTree(repo, flaky);
    assert.ok(tree, 'a tree was still written');
    const changes = await treeChanges('HEAD', tree, git);
    assert.deepEqual([...changes.keys()], ['doomed.ts'], 'with everything that did stage');
  });

  it('runs two snapshots at once without them fighting over a scratch index', async () => {
    // A shared scratch index means `git add` locks it and the second caller fails outright.
    // Two windows on one repository is the ordinary case, and a mid-run refresh beside a
    // manual one is the awkward one.
    const scratch = (): Promise<string[]> =>
      fs.readdir(os.tmpdir()).then((f) => f.filter((n) => n.startsWith('redline-') && n.includes('.index')));
    const before = new Set(await scratch());
    const [a, b, c] = await Promise.all([
      snapshotWorkingTree(repo, git),
      snapshotWorkingTree(repo, git),
      snapshotWorkingTree(repo, git),
    ]);
    assert.ok(a && b && c, 'all three produced a tree');
    assert.equal(a, b);
    assert.equal(b, c, 'and agree, because the tree did not move');
    // Only ours: the temp directory is shared, and a live editor window keeps its own.
    const left = (await scratch()).filter((f) => !before.has(f));
    assert.deepEqual(left, [], 'and left no scratch indexes behind');
  });

  it('returns paths verbatim, however awkward the name', async () => {
    // git escapes a path containing a quote, a backslash or a control character unless the
    // output is NUL-separated — and an escaped path fails every stat, URI and diff after it.
    const before = await snapshotWorkingTree(repo, git);
    assert.ok(before);
    const names = [
      'ünïcode-ätest.ts',
      'with space.ts',
      "quote'single.ts",
      'quote"double.ts',
      'back\\slash.ts',
      '-leading-dash.ts',
      'sub dir/ünï space.ts',
      '#hash.ts',
      'semi;colon.ts',
      'tab\there.ts',
    ];
    for (const n of names) await write(n, 'export const x = 1\n');
    const after = await snapshotWorkingTree(repo, git);
    assert.ok(after);
    const changes = await treeChanges(before, after, git);
    for (const n of names) {
      assert.ok(changes.has(n), `${JSON.stringify(n)} came back as ${JSON.stringify([...changes.keys()])}`);
    }
  });

  it('keeps a rename straight when both names are awkward', async () => {
    await write('quote"from.ts', 'export const x = 1\n');
    await git(['add', '-A']);
    await git(['commit', '-qm', 'awkward']);
    const before = await snapshotWorkingTree(repo, git);
    assert.ok(before);
    await git(['mv', 'quote"from.ts', 'quote"to.ts']);
    const after = await snapshotWorkingTree(repo, git);
    assert.ok(after);
    const changes = await treeChanges(before, after, git);
    const moved = changes.get('quote"to.ts');
    assert.equal(moved?.kind, 'renamed', JSON.stringify([...changes.keys()]));
    assert.equal((moved as { from: string }).from, 'quote"from.ts');
  });

  it('tells a binary file from a text one even when the name needs escaping', async () => {
    const before = await snapshotWorkingTree(repo, git);
    assert.ok(before);
    await fs.writeFile(path.join(repo, 'logo"1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0]));
    await write('quote"text.ts', 'export const x = 1\n');
    const after = await snapshotWorkingTree(repo, git);
    assert.ok(after);
    assert.deepEqual([...(await binaryPaths(before, after, git))], ['logo"1.png']);
  });

  it('survives a repository where every kind of oddity is present at once', async () => {
    // Each of these has broken something at least once: a dangling link, a file swapped for a
    // directory, a case-only rename on a case-insensitive volume.
    await write('swap.ts', 'export const swap = 1\n');
    await write('Case.ts', 'export const c = 1\n');
    await git(['add', '-A']);
    await git(['commit', '-qm', 'oddities']);
    const before = await snapshotWorkingTree(repo, git);
    assert.ok(before);
    await fs.symlink('nowhere.ts', path.join(repo, 'dangling.ts'));
    await fs.rm(path.join(repo, 'swap.ts'));
    await write('swap.ts/inner.ts', 'export const inner = 1\n');
    await git(['mv', '-f', 'Case.ts', 'case.ts']);
    const after = await snapshotWorkingTree(repo, git);
    assert.ok(after, 'a tree despite all of it');
    const changes = await treeChanges(before, after, git);
    assert.equal(changes.get('swap.ts')?.kind, 'deleted', 'the file it used to be');
    assert.equal(changes.get('swap.ts/inner.ts')?.kind, 'added', 'the directory it became');
    assert.ok(changes.has('dangling.ts'), 'a link with no target is still a change');
    assert.ok(changes.has('case.ts') || changes.has('Case.ts'), 'the case-only rename');
  });

  it('gives no answer rather than a wrong one when git cannot help', async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-tree-none-'));
    try {
      const outside: GitRunner = async (args, env) => {
        const { stdout } = await execFileP('git', args, {
          cwd: notARepo,
          env: env ? { ...process.env, ...env } : process.env,
        });
        return stdout;
      };
      assert.equal(await snapshotWorkingTree(notARepo, outside), undefined);
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true });
    }
  });
});
