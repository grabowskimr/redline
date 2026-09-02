import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectSlug } from '../../claude/transcripts';
import { touchedSince } from '../../claude/touched';
import { readRunTrees } from '../../claude/runTrees';
import { treeChanges } from '../../git/snapshotTree';

const run = promisify(execFile);

/**
 * The Claude Code plugin's hook, run for real.
 *
 * It had no test of any kind. The scenario suite was believed to cover it and does not — it
 * reimplements the snapshot in shell and hand-writes the files the hook would have produced,
 * so changing the hook and running that suite tested nothing at all.
 *
 * This runs the actual script the way Claude Code runs it: a JSON payload on stdin, `HOME`
 * pointed at a temp directory, against a real repository. Everything it asserts is something
 * the extension reads back with its own reader, so the two halves are checked against each
 * other rather than against a copy of one of them.
 */
describe('the hook Claude Code runs', () => {
  // From `out/test/unit/` to the repository root.
  const SCRIPT = path.join(__dirname, '..', '..', '..', 'plugin', 'hooks', 'redline-touched.mjs');
  let home: string;
  let repo: string;

  const git = (...args: string[]): Promise<{ stdout: string }> =>
    run('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });

  /** Fire the hook exactly as the agent would, and give back what it printed. */
  const hook = async (payload: Record<string, unknown>): Promise<string> => {
    const child = execFile('node', [SCRIPT], { env: { ...process.env, HOME: home } });
    child.stdin?.end(JSON.stringify({ cwd: repo, session_id: 's1', ...payload }));
    let out = '';
    child.stdout?.on('data', (c) => {
      out += String(c);
    });
    await new Promise((done) => child.on('close', done));
    return out;
  };

  const stateDir = (): string => path.join(home, '.claude', 'redline', projectSlug(repo));

  const write = async (rel: string, text: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), text, 'utf8');
  };

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-home-')));
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-hookrepo-')));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await write('src/a.ts', 'export const a = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'first');
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('takes a snapshot of the tree when a request is submitted', async () => {
    // The one thing only a hook can do: capture what the tree looked like *before* the agent
    // starts. Everything Redline says about a run is a diff from this.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the thing' });

    const trees = await readRunTrees(repo, home);
    assert.ok(trees?.pending, 'the tree this request starts from was recorded');
    assert.match(trees.pending.tree, /^[0-9a-f]{40,64}$/, 'a real git object id');

    // And it is a tree this repository actually has.
    const { stdout } = await git('cat-file', '-t', trees.pending.tree);
    assert.equal(stdout.trim(), 'tree');
  });

  it('does not make it the run boundary until the run changes something', async () => {
    /*
     * The bug this exists for. `before` used to be overwritten at every request, so "the last
     * run" meant "the most recent request" rather than "the most recent request that changed
     * anything". Every turn that only talked — a question, an answer read, a note approved —
     * snapshotted the tree as it already stood and made that the boundary, so `before` and the
     * end of the run were the same tree, the diff was empty, and the previous run's work
     * vanished from the gutter and from *Claude's last run* while it sat uncommitted.
     */
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'change it' });
    await write('src/a.ts', 'export const a = 2;\n');
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/a.ts') },
    });
    await hook({ hook_event_name: 'Stop' });

    const worked = await readRunTrees(repo, home);
    const boundary = worked?.before?.tree;
    assert.ok(boundary, 'the run that changed something set the boundary');
    assert.notEqual(worked?.after?.tree, boundary, 'and its diff is not empty');

    // Now talk to it twice without it editing anything at all.
    for (const prompt of ['why did you do that?', 'ok, thanks']) {
      await hook({ hook_event_name: 'UserPromptSubmit', prompt });
      await hook({ hook_event_name: 'Stop' });
    }

    const after = await readRunTrees(repo, home);
    assert.equal(after?.before?.tree, boundary, 'the boundary has not moved');
    assert.notEqual(after?.after?.tree, after?.before?.tree, 'so the last run still has changes to show');
    assert.equal(after?.pending, undefined, 'and no request is left marked in flight');
  });

  it('keeps the boundary when the run only writes outside the repository', async () => {
    // What happened in the field: the turn's only writes went to `~/.claude/…` memory files.
    // Logging those is right; moving the run boundary for them is not — nothing in the
    // repository changed, so the previous run is still the last one worth showing.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'change it' });
    await write('src/a.ts', 'export const a = 2;\n');
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/a.ts') },
    });
    await hook({ hook_event_name: 'Stop' });
    const boundary = (await readRunTrees(repo, home))?.before?.tree;

    const outside = path.join(home, 'notes.md');
    await fs.writeFile(outside, 'remembered\n', 'utf8');
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'remember that' });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: outside } });
    await hook({ hook_event_name: 'Stop' });

    assert.equal((await readRunTrees(repo, home))?.before?.tree, boundary, 'the boundary has not moved');
  });

  it('gives an interrupted run an end, so it can still be looked at', async () => {
    /*
     * Claude Code does not run the `Stop` hook when a turn is interrupted, so an interrupted
     * run records no end. It used to be archived with `after: undefined`, which the reader
     * drops — putting a run whose work was real and on screen a moment ago permanently out of
     * reach of *Review a Previous Run*.
     */
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'first' });
    await write('src/a.ts', 'export const a = 2;\n');
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/a.ts') },
    });
    // Interrupted here: no Stop.

    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'second' });
    await write('src/b.ts', 'export const b = 1;\n');
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/b.ts') },
    });
    await hook({ hook_event_name: 'Stop' });

    const trees = await readRunTrees(repo, home);
    const past = trees?.history?.[0];
    assert.ok(past, 'the interrupted run is still reachable');
    assert.match(past.after, /^[0-9a-f]{40,64}$/, 'with both of its ends');
    assert.equal(past.approx, true, 'marked, because the end is the next request rather than its own');
  });

  it('puts the boundary back when a run only edits files git ignores', async () => {
    // The boundary moves on the first edit, which keeps the panel live while the agent works.
    // An edit that leaves the tree untouched — a gitignored file, or one undone before the run
    // ended — has to give it back, or a run that changed nothing hides the last one that did.
    await write('.gitignore', 'secrets/\n');
    await git('add', '-A');
    await git('commit', '-qm', 'ignore');

    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'change it' });
    await write('src/a.ts', 'export const a = 2;\n');
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/a.ts') },
    });
    await hook({ hook_event_name: 'Stop' });
    const boundary = (await readRunTrees(repo, home))?.before?.tree;

    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'write the env file' });
    await write('secrets/.env', 'TOKEN=1\n');
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'secrets/.env') },
    });
    await hook({ hook_event_name: 'Stop' });

    const trees = await readRunTrees(repo, home);
    assert.equal(trees?.before?.tree, boundary, 'the boundary is back where it was');
    assert.notEqual(trees?.after?.tree, trees?.before?.tree, 'and the last real run still shows its work');
  });

  it('still shows the last run that worked, after a conversation about it', async () => {
    /*
     * The whole failure, end to end, as it happened: a run edits three files; you ask about
     * them; you read the answer and say thanks. Two turns, no edits. The panel went empty and
     * the gutter marks disappeared, with the three files still uncommitted in the tree.
     *
     * Asserted on the file list *Last run* renders — `treeChanges` over the pair the extension
     * reads back — rather than on the markers, so the two halves are checked against each
     * other rather than against a copy of one of them.
     */
    const git2: (args: string[]) => Promise<string> = async (args) => (await git(...args)).stdout;

    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'rename the hook and its callers' });
    for (const [file, text] of [
      ['src/a.ts', 'export const a = 2;\n'],
      ['src/b.ts', 'export const b = 1;\n'],
    ] as const) {
      await write(file, text);
      await hook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(repo, file) },
      });
    }
    await hook({ hook_event_name: 'Stop' });

    const worked = await readRunTrees(repo, home);
    assert.deepEqual(
      [...(await treeChanges(worked!.before!.tree, worked!.after!.tree, git2)).keys()].sort(),
      ['src/a.ts', 'src/b.ts'],
      'the run that worked shows its two files',
    );

    for (const prompt of ['why did you rename it?', 'makes sense, thanks']) {
      await hook({ hook_event_name: 'UserPromptSubmit', prompt });
      await hook({ hook_event_name: 'Stop' });
    }

    const afterTalking = await readRunTrees(repo, home);
    assert.deepEqual(
      [...(await treeChanges(afterTalking!.before!.tree, afterTalking!.after!.tree, git2)).keys()].sort(),
      ['src/a.ts', 'src/b.ts'],
      'and still shows them after two turns of conversation',
    );
  });

  it('catches a run whose only change was a file a shell command created', async () => {
    // `bashEnd` diffs tracked files, so a file Bash *creates* names nothing and fires no edit
    // signal. The end-of-run tree is what catches it — without this the run would be settled
    // as a no-op and its new file attributed to whatever came next.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'generate it' });
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    await write('src/generated.ts', 'export const g = 1;\n');
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await hook({ hook_event_name: 'Stop' });

    const trees = await readRunTrees(repo, home);
    assert.ok(trees?.before, 'the run took the boundary');
    assert.notEqual(trees?.after?.tree, trees?.before?.tree, 'and the created file is in its diff');
  });

  it('leaves the index and the working tree exactly as it found them', async () => {
    /*
     * It stages the whole tree to take that snapshot. Doing that to the user's own index would
     * be unforgivable — they are in the middle of something.
     */
    await write('src/b.ts', 'export const b = 2;\n');
    await git('add', 'src/b.ts');
    const before = await git('status', '--porcelain');

    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });

    assert.equal((await git('status', '--porcelain')).stdout, before.stdout, 'nothing moved');
  });

  it('records the files an edit touched, and which tool touched them', async () => {
    const at = Date.now() - 1000;
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/a.ts') },
    });

    const touched = (await touchedSince(repo, at, home)) ?? [];
    assert.equal(touched.length, 1);
    assert.equal(touched[0]?.file, path.join(repo, 'src/a.ts'));
    assert.equal(touched[0]?.via, 'edit');
  });

  it('records what a shell command changed, which no tool call names', async () => {
    // `sed -i` in a Bash call edits files nothing in the payload mentions. The hook brackets
    // the command and diffs across it.
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    await new Promise((r) => setTimeout(r, 1100)); // mtime resolution
    await write('src/a.ts', 'export const a = 2;\n');
    const at = Date.now() - 5000;
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });

    const touched = (await touchedSince(repo, at, home)) ?? [];
    assert.ok(
      touched.some((t) => t.file.endsWith('src/a.ts') && t.via === 'bash'),
      'attributed to the shell command',
    );
  });

  it('marks the run finished, with the tree as it ended', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    await write('src/a.ts', 'export const a = 3;\n');
    await hook({ hook_event_name: 'Stop' });

    const trees = await readRunTrees(repo, home);
    assert.ok(trees?.after, 'an after tree');
    assert.notEqual(trees.after?.tree, trees.before?.tree, 'and it differs — something changed');
    assert.ok(
      await fs.stat(path.join(stateDir(), 'stopped.json')).then(() => true, () => false),
      'and the run is marked over',
    );
  });

  it('says nothing at all for a prompt that is not the delivery word', async () => {
    // Everything it writes is observation. It adds nothing to a turn unless a batch has been
    // staged and the exact word typed — otherwise it costs the session no tokens whatever.
    const out = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor the parser' });
    assert.equal(JSON.parse(out || '{}').hookSpecificOutput, undefined);
  });

  it('hands over a staged batch when the delivery word is typed', async () => {
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(path.join(stateDir(), 'outbox.md'), 'the whole batch of feedback', 'utf8');

    const out = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'redline-review' });
    const reply = JSON.parse(out || '{}');
    assert.equal(reply.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.match(reply.hookSpecificOutput?.additionalContext ?? '', /the whole batch of feedback/);
  });

  it('keeps its state per repository, not per directory the agent happens to be in', async () => {
    // Keyed by `cwd` it scattered a directory per subdirectory, and the extension — which asks
    // about the repository — found none of it.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', cwd: path.join(repo, 'src') });
    assert.ok(await readRunTrees(repo, home), 'recorded against the repository root');
  });

  it('says nothing and writes nothing outside a repository', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-plain-'));
    try {
      const out = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', cwd: plain });
      assert.equal(JSON.parse(out || '{}').hookSpecificOutput, undefined);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('never fails loudly, whatever it is handed', async () => {
    /*
     * It runs inside someone's turn. A hook that throws, or prints anything but its one line of
     * JSON, interferes with the agent — so malformed input has to leave no trace at all.
     */
    for (const payload of [{}, { hook_event_name: 'Nonsense' }, { hook_event_name: 'PostToolUse', tool_name: 'Edit' }]) {
      const out = await hook(payload);
      assert.doesNotThrow(() => JSON.parse(out || '{}'), `survived ${JSON.stringify(payload)}`);
    }
  });

  it('cleans up the scratch index it staged into', async () => {
    // Several megabytes per run, in the temp directory, and nothing else was ever going to
    // remove them.
    const before = (await fs.readdir(os.tmpdir())).filter((f) => f.includes('.hook.index'));
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    const after = (await fs.readdir(os.tmpdir())).filter((f) => f.includes('.hook.index'));
    assert.deepEqual(after, before, 'no scratch index left behind');
  });
});
