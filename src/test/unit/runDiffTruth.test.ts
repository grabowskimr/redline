import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ChangeStatus, changesToShow, recentLabelFor, treeSides, ReviewRange } from '../../git/reviewRange';
import { EMPTY_TREE } from '../../git/snapshotTree';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';
import { projectSlug } from '../../claude/transcripts';

const run = promisify(execFile);

/**
 * The four ways the run diff used to answer confidently and wrongly.
 *
 * Every one of them was a *presentation* bug sitting on top of data that already knew better:
 * the summary recorded that the listing had failed, that the burst came from file times, that
 * a file was gone — and the words shown to the user threw all three away. So the decisions are
 * pure functions now, and this is where they are pinned.
 */
describe('what the run diff is allowed to claim', () => {
  describe('a failed listing is not "nothing changed"', () => {
    // A `git diff --name-status` that fails — an `index.lock` from a background `git gc`,
    // output past `maxBuffer`, a timeout — leaves both counts at zero. Branching on the count
    // alone told the user their tree was clean, about code an agent had just rewritten.
    it('reports a failed listing as unavailable, not as an empty tree', () => {
      const failed = { fileCount: 0, recentCount: 0, unavailable: true };
      assert.deepEqual(changesToShow(failed, 'recent'), { kind: 'unavailable' });
      assert.deepEqual(changesToShow(failed, 'all'), { kind: 'unavailable' });
    });

    it('still says unavailable when the counts happen to be non-zero', () => {
      // A partial listing is not a listing. Believing the count here would show a diff that
      // silently omits whatever the failure swallowed.
      const partial = { fileCount: 3, recentCount: 1, unavailable: true };
      assert.deepEqual(changesToShow(partial, 'all'), { kind: 'unavailable' });
    });

    it('reports a genuinely clean tree as nothing, with the other scope to offer', () => {
      assert.deepEqual(changesToShow({ fileCount: 0, recentCount: 0 }, 'all'), { kind: 'none', otherCount: 0 });
      assert.deepEqual(changesToShow({ fileCount: 4, recentCount: 0 }, 'recent'), { kind: 'none', otherCount: 4 });
      // "Everything" is already the widest scope; there is nothing wider to point at.
      assert.deepEqual(changesToShow({ fileCount: 0, recentCount: 0 }, 'recent'), { kind: 'none', otherCount: 0 });
    });

    it('reports what there is when there is something', () => {
      assert.deepEqual(changesToShow({ fileCount: 9, recentCount: 2 }, 'recent'), { kind: 'files', count: 2 });
      assert.deepEqual(changesToShow({ fileCount: 9, recentCount: 2 }, 'all'), { kind: 'files', count: 9 });
    });
  });

  describe('a cluster of file times is not a run', () => {
    const when = '2026-08-31T09:12:00.000Z';

    it('calls the hook and the transcript what they are: the last run', () => {
      assert.match(recentLabelFor('hook', when), /^in the last run \(since /);
      assert.match(recentLabelFor('transcript', when), /^in the last run \(since /);
      assert.equal(recentLabelFor('hook'), 'in the last run');
    });

    it('never calls an mtime cluster a run', () => {
      // An `npm install` or a `git checkout` restamps hundreds of files. Announcing that as
      // "400 files in the last run" is the worst answer this feature can give.
      for (const label of [recentLabelFor('mtime', when), recentLabelFor('mtime')]) {
        assert.ok(!/last run/.test(label), `"${label}" must not claim a run`);
        assert.match(label, /file times/, `"${label}" must say where it came from`);
      }
    });

    it('still says when the weaker answer starts, so it is usable rather than merely honest', () => {
      assert.match(recentLabelFor('mtime', when), /since \d/);
    });
  });

  describe('a file that is no longer there', () => {
    const both = { onDisk: true, binary: false };

    it('serves the right side out of the snapshot when the file has gone since the run', () => {
      // The run ends, you delete or clean one of the files it changed, then open the review.
      // `vscode.changes` drops an entry whose side it cannot open — silently — while the title
      // still counts it. The content is in the tree; that is what the tree is for.
      const sides = treeSides('src/a.ts', { kind: 'modified' }, { onDisk: false, binary: false });
      assert.deepEqual(sides.right, { from: 'tree', which: 'now', path: 'src/a.ts' });
      assert.deepEqual(sides.left, { from: 'tree', which: 'left', path: 'src/a.ts' });
    });

    it('reads the working file when it is still there', () => {
      assert.deepEqual(treeSides('src/a.ts', { kind: 'modified' }, both).right, { from: 'working' });
    });

    it('leaves a deletion the run itself made reading as a deletion', () => {
      const sides = treeSides('src/a.ts', { kind: 'deleted' }, { onDisk: false, binary: false });
      assert.deepEqual(sides.right, { from: 'empty', note: 'deleted' });
    });

    it('gives a new file an empty left side, whether or not it survived', () => {
      assert.deepEqual(treeSides('src/new.ts', { kind: 'added' }, both).left, { from: 'empty', note: 'new file' });
      const gone = treeSides('src/new.ts', { kind: 'added' }, { onDisk: false, binary: false });
      assert.deepEqual(gone.left, { from: 'empty', note: 'new file' });
      assert.deepEqual(gone.right, { from: 'tree', which: 'now', path: 'src/new.ts' });
    });

    it('follows a rename back to the path it came from', () => {
      const status: ChangeStatus = { kind: 'renamed', from: 'src/old.ts' };
      assert.deepEqual(treeSides('src/new.ts', status, both).left, { from: 'tree', which: 'left', path: 'src/old.ts' });
    });

    it('sends a binary to the base, where the git extension can load it', () => {
      const sides = treeSides('logo.png', { kind: 'modified' }, { onDisk: true, binary: true });
      assert.deepEqual(sides.left, { from: 'base', path: 'logo.png' });
      assert.deepEqual(sides.right, { from: 'working' });
    });
  });
});

/**
 * A repository with no commit in it yet.
 *
 * `rev-parse HEAD` fails there, and every base resolution failed with it, so the extension
 * told the user "no git repository here — or git is not on PATH". Both halves false, and it
 * pointed at their git install instead of at their first files.
 */
describe('a repository nobody has committed to yet', () => {
  let repo: string;
  let range: ReviewRange;

  const logger = { info: () => undefined, warn: () => undefined, trace: () => undefined } as never;

  const git = (...args: string[]): Promise<{ stdout: string }> =>
    run('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-unborn-')));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    (vscode as unknown as { resetStub(): void }).resetStub();
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [{ uri: vscode.Uri.file(repo) }];
    range = new ReviewRange(
      new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, { archiveLimit: () => 5 }),
      logger,
    );
  });

  afterEach(async () => {
    range.dispose();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('answers, rather than pretending there is no repository', async () => {
    await fs.writeFile(path.join(repo, 'first.ts'), 'export const a = 1;\n', 'utf8');
    await git('add', '-A');
    const s = await range.summary();
    assert.ok(s, 'a summary, not the "no repository here" dead end');
    assert.equal(s.base, EMPTY_TREE, 'measured from the empty tree, which is what it is for');
    assert.ok(s.files.includes('first.ts'), 'the first file counts as a change');
  });

  it('counts a file that was never added, too', async () => {
    await fs.writeFile(path.join(repo, 'untracked.ts'), 'export const b = 2;\n', 'utf8');
    const s = await range.summary();
    assert.ok(s?.files.includes('untracked.ts'));
  });
});

/**
 * Two Claude sessions submitting a prompt in the same repository at the same moment.
 *
 * `runs.json` was staged through a shared `runs.json.tmp` with no pid in it, unlike the outbox
 * and the stop marker beside it. Two writers interleave into that one file and the rename
 * publishes the mixture; the extension's reader swallows the parse error, so both windows drop
 * to the mtime heuristic with nothing on screen to say why.
 */
describe('two sessions writing the run marker at once', () => {
  const SCRIPT = path.join(__dirname, '..', '..', '..', 'plugin', 'hooks', 'redline-touched.mjs');
  let home: string;
  let repo: string;

  const git = (...args: string[]): Promise<{ stdout: string }> =>
    run('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });

  const hook = async (payload: Record<string, unknown>): Promise<void> => {
    const child = execFile('node', [SCRIPT], { env: { ...process.env, HOME: home } });
    child.stdin?.end(JSON.stringify({ cwd: repo, ...payload }));
    await new Promise((done) => child.on('close', done));
  };

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-home-')));
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-tworepo-')));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'a.ts', ), 'export const a = 1;\n', 'utf8');
    await git('add', '-A');
    await git('commit', '-qm', 'first');
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('stages every marker under its own pid, so no two writers share a temp file', async () => {
    // The guard that actually holds: a shared name is the defect, and the rename that follows
    // is exactly as atomic either way — so only the name can be asserted on.
    const source = await fs.readFile(SCRIPT, 'utf8');
    const staged = [...source.matchAll(/`\$\{(\w+)\}((?:\.[\w.$}{]+)*)\.tmp`/g)].map((m) => m[0]);
    assert.ok(staged.length >= 3, 'the three markers are all staged through a temp file');
    for (const name of staged) {
      assert.match(name, /process\.pid/, `${name} is shared between concurrent sessions`);
    }
  });

  it('leaves a readable run marker when several sessions submit together', async () => {
    await Promise.all(
      ['s1', 's2', 's3', 's4'].map((id) =>
        hook({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
      ),
    );
    const file = path.join(home, '.claude', 'redline', projectSlug(repo), 'runs.json');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    // The request marker, not the boundary: submitting no longer moves the boundary — see
    // `recordRunStart`. What is being asserted is unchanged, that four concurrent writers
    // leave whole JSON behind rather than a tear.
    assert.match(String(parsed?.pending?.tree), /^[0-9a-f]{40,64}$/, 'a whole, readable marker');
  });
});
