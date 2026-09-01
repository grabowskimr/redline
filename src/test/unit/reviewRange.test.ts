import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ReviewRange, emptySide } from '../../git/reviewRange';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';

const run = promisify(execFile);

/**
 * What Redline says has changed — against a real repository.
 *
 * The largest file in the extension and the answer to the question the whole product is built
 * around, with no unit test that so much as loaded it. Real git rather than a stub: everything
 * interesting here is a fact about a repository, and a stubbed `git` would only ever confirm
 * what the test author already believed.
 */
describe('what changed, against a real repository', () => {
  let repo: string;
  let range: ReviewRange;

  const git = (...args: string[]): Promise<{ stdout: string }> =>
    run('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

  const write = async (rel: string, text: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), text, 'utf8');
  };

  const logger = { info: () => undefined, warn: () => undefined, trace: () => undefined } as never;

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-range-')));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await write('src/a.ts', 'export const a = 1;\n');
    await write('src/b.ts', 'export const b = 2;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'first');
    (vscode as unknown as { resetStub(): void }).resetStub();
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [
      { uri: vscode.Uri.file(repo) },
    ];
    range = new ReviewRange(
      new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, { archiveLimit: () => 5 }),
      logger,
    );
  });

  afterEach(async () => {
    range.dispose();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('finds the repository it is standing in', async () => {
    assert.equal(await range.repoRoot(), repo);
  });

  it('refuses to touch git at all until the folder is trusted', async () => {
    /*
     * A repository decides its own filters and configuration, and git executes them. Running
     * any of it before the user has said they trust the folder would hand a hostile repository
     * the ability to run code — which is what the manifest's "limited" support means.
     */
    (vscode as unknown as { state: { trusted: boolean } }).state.trusted = false;
    range.invalidate(true);
    assert.equal(await range.repoRoot(), undefined);
    assert.equal(await range.summary(), undefined, 'and says nothing rather than guessing');
  });

  it('lists a file that was edited since the base', async () => {
    await write('src/a.ts', 'export const a = 99;\n');
    const summary = await range.summary();
    assert.ok(summary, 'a repository with a commit has a range');
    assert.ok(summary.files.includes('src/a.ts'), 'the edited file');
    assert.ok(!summary.files.includes('src/b.ts'), 'and not the untouched one');
  });

  it('lists a file that was created since the base, not only edited ones', async () => {
    // The case a plain `git diff` misses, and the reason untracked files are listed separately:
    // a file the agent created is the most interesting thing a run can produce.
    await write('src/new.ts', 'export const c = 3;\n');
    const summary = await range.summary();
    assert.ok(summary?.files.includes('src/new.ts'));
  });

  it('lists a file that was deleted', async () => {
    await fs.rm(path.join(repo, 'src/b.ts'));
    const summary = await range.summary();
    assert.ok(summary?.files.includes('src/b.ts'), 'a deletion is a change');
  });

  it('counts a change the agent committed, against a pinned baseline', async () => {
    /*
     * An agent that commits its work has still changed the code, and a review that only looked
     * at the working tree would show nothing at all. With nothing published to compare against
     * — no upstream, as here — a baseline pinned by hand is what says where "before" was.
     */
    assert.equal(await range.markNow('test'), true, 'the baseline was pinned');
    await write('src/a.ts', 'export const a = 42;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'the agent committed');
    range.invalidateBase();
    const summary = await range.summary();
    assert.ok(summary?.files.includes('src/a.ts'), 'committed, and still part of the review');
  });

  it('forgets a pinned baseline when it is cleared', async () => {
    await range.markNow('test');
    await write('src/a.ts', 'export const a = 43;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'committed');
    range.invalidateBase();
    assert.ok((await range.summary())?.files.includes('src/a.ts'));

    range.clearBaseline();
    range.invalidateBase();
    const after = await range.summary();
    assert.ok(!after?.files.includes('src/a.ts'), 'back to comparing against the commit itself');
  });

  it('says nothing at all outside a repository, rather than guessing', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-plain-'));
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [
      { uri: vscode.Uri.file(plain) },
    ];
    const outside = new ReviewRange(
      new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, { archiveLimit: () => 5 }),
      logger,
    );
    try {
      assert.equal(await outside.repoRoot(), undefined);
      assert.equal(await outside.summary(), undefined);
    } finally {
      outside.dispose();
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('shares one computation between callers asking at once', async () => {
    // The panel, the status bar and the gutter all ask on the same signal. Three answers to
    // one question is three lots of git on a repository that can hold 42,000 files.
    await write('src/a.ts', 'export const a = 7;\n');
    const [one, two, three] = await Promise.all([range.summary(), range.summary(), range.summary()]);
    assert.deepEqual(one?.files, two?.files);
    assert.deepEqual(two?.files, three?.files);
  });

  it('gives every changed file a pair of sides to open', async () => {
    await write('src/a.ts', 'export const a = 8;\n');
    await range.summary();
    const resources = await range.diffResources('all');
    assert.ok(resources.length > 0, 'something to open');
    for (const [uri, left, right] of resources) {
      assert.ok(uri.fsPath.startsWith(repo), 'a real path in this repository');
      assert.ok(left, 'a before');
      assert.ok(right, 'and an after');
    }
  });
});

describe('the empty side of a comparison', () => {
  it('keeps the real name visible and says what happened to it', () => {
    // It is what the multi-file diff writes above each entry, so "MissingBandAlert.tsx (new
    // file)" says what happened without anyone having to open it.
    const side = emptySide(vscode.Uri.file('/repo/src/New.tsx'), 'new file');
    assert.match(side.path, /New\.tsx \(new file\)$/);
    assert.notEqual(side.scheme, 'file', 'served by the extension, not read from disk');
  });

  it('carries nothing over from the original but its name', () => {
    const side = emptySide(vscode.Uri.file('/repo/src/Old.tsx').with({ query: 'a=1', fragment: 'L4' }));
    assert.equal(side.query, '');
    assert.equal(side.fragment, '');
  });
});
