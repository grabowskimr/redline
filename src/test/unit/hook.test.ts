import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectSlug } from '../../claude/transcripts';
import { touchedSince } from '../../claude/touched';
import { readRunTrees } from '../../claude/runTrees';

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
    assert.ok(trees?.before, 'a before tree was recorded');
    assert.match(trees.before.tree, /^[0-9a-f]{40,64}$/, 'a real git object id');

    // And it is a tree this repository actually has.
    const { stdout } = await git('cat-file', '-t', trees.before.tree);
    assert.equal(stdout.trim(), 'tree');
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
