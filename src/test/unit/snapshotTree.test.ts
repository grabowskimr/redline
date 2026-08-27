import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binaryPaths, EMPTY_TREE, GitRunner, snapshotWorkingTree, treeChanges } from '../../git/snapshotTree';

const execFileP = promisify(execFile);

/**
 * Against real git, because the whole point of this mechanism is what git actually does with
 * a throwaway index. A mock would only assert that the arguments are the ones I wrote.
 */
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
