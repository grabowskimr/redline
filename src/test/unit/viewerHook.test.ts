import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDirectory } from '../../claude/statePaths';

const exec = promisify(execFile);
const script = path.resolve(__dirname, '../../../plugin/hooks/redline-touched.mjs');

describe('2.0 boundary-only capture', function () {
  this.timeout(20000);
  let root: string, home: string;
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout.trim();
  const state = async () =>
    JSON.parse(await fs.readFile(path.join(stateDirectory(root, home), 'runs.json'), 'utf8'));
  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [script],
        { env: { ...process.env, HOME: home }, timeout: 15000 },
        (error, stdout, stderr) => {
          if (error || stderr) reject(error ?? new Error(stderr));
          else resolve(stdout.trim());
        },
      );
      child.stdin?.end(
        JSON.stringify({ cwd: root, session_id: 'session-a', hook_event_name: event, ...extra }),
      );
    });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-v2-hook-')));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-v2-home-'));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(root, 'a.rs'), 'original\n');
    await git('add', '-A');
    await git('commit', '-qm', 'base');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it('registers only prompt start, completion and failure', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(path.dirname(script), 'hooks.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(manifest.hooks).sort(), [
      'Stop',
      'StopFailure',
      'UserPromptSubmit',
    ]);
  });
  it('never consumes feedback or injects it into Claude', async () => {
    const dir = stateDirectory(root, home);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'outbox.md'), 'old feedback');
    assert.equal(await hook('UserPromptSubmit', { prompt: 'redline-review' }), '{}');
    assert.equal(await fs.readFile(path.join(dir, 'outbox.md'), 'utf8'), 'old feedback');
    const marker = JSON.parse(await fs.readFile(path.join(dir, 'hook.json'), 'utf8'));
    assert.equal(marker.token, undefined);
  });
  it('captures shell-created files without per-tool hooks and excludes pre-existing edits', async () => {
    await fs.writeFile(path.join(root, 'a.rs'), 'earlier dirty change\n');
    const index = await fs.readFile(path.join(root, '.git/index'));
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'new.rs'), 'created by shell\n');
    await hook('Stop');
    const s = await state();
    assert.equal(
      await git('diff-tree', '-r', '--name-only', s.before.tree, s.after.tree),
      'new.rs',
    );
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
  });
  it('extends the same run after another Stop hook makes Claude continue', async () => {
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'a.rs'), 'first\n');
    await hook('Stop');
    const first = await state();
    await fs.writeFile(path.join(root, 'a.rs'), 'continued\n');
    await hook('Stop', { stop_hook_active: true });
    const next = await state();
    assert.equal(next.before.id, first.before.id);
    assert.equal(await git('show', `${next.after.tree}:a.rs`), 'continued');
    assert.equal(await git('show', `${next.before.tree}:a.rs`), 'original');
  });
  it('keeps the previous exact run after an answer-only prompt and stores no answer', async () => {
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'a.rs'), 'first\n');
    await hook('Stop');
    const first = await state();
    await hook('UserPromptSubmit');
    await hook('Stop', { last_assistant_message: 'private answer' });
    const next = await state();
    assert.equal(next.before.id, first.before.id);
    assert.equal(next.after.tree, first.after.tree);
    assert.equal(JSON.stringify(next).includes('private answer'), false);
  });
  it('does not include interrupted edits in the following prompt', async () => {
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'a.rs'), 'interrupted\n');
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'new.rs'), 'next prompt\n');
    await hook('Stop');
    const s = await state();
    assert.equal(
      await git('diff-tree', '-r', '--name-only', s.before.tree, s.after.tree),
      'new.rs',
    );
  });
  it('waits for background tasks before finalizing a prompt', async () => {
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'a.rs'), 'first edit\n');
    await hook('Stop', { background_tasks: [{ id: 'task', type: 'subagent', status: 'running' }] });
    const paused = await state();
    assert.ok(paused.pending, 'Background work has not reached a final boundary');
    assert.equal(paused.after, undefined);
    await fs.writeFile(path.join(root, 'b.rs'), 'background edit\n');
    await hook('Stop', { background_tasks: [] });
    const done = await state();
    assert.equal(done.pending, undefined);
    assert.equal(await git('show', `${done.after.tree}:b.rs`), 'background edit');
  });
  it('records failed completion without leaving a pending run or an assistant reply', async () => {
    await hook('UserPromptSubmit');
    await fs.writeFile(path.join(root, 'a.rs'), 'partial\n');
    await hook('StopFailure', {
      error: 'rate_limit',
      last_assistant_message: 'private error details',
    });
    const s = await state();
    assert.equal(s.pending, undefined);
    assert.equal(s.stopped.error, 'rate_limit');
    assert.equal(s.stopped.message, undefined);
    assert.ok(s.after.tree);
  });
});
