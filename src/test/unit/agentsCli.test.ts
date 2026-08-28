import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listAgentSessions, resetAgentSupport } from '../../claude/agentsCli';

/**
 * Driven through a stub `claude` on disk rather than the real one: a test must never spend a
 * subscription's usage, and a real session list would differ on every machine anyway.
 */
describe("Claude Code's own session list", () => {
  let dir: string;

  const stub = async (body: string, exit = 0): Promise<string> => {
    const file = path.join(dir, 'claude');
    await fs.writeFile(file, `#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\nexit ${exit}\n`, 'utf8');
    await fs.chmod(file, 0o755);
    return file;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-agents-'));
    resetAgentSupport();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    resetAgentSupport();
  });

  it('reads the sessions, their directories and their real ids', async () => {
    const claude = await stub(
      JSON.stringify([
        { pid: 93483, cwd: '/repo/one', kind: 'interactive', sessionId: 'aaa', name: 'one-6a', status: 'idle' },
        { id: '74b0', cwd: '/repo/two', kind: 'background', sessionId: 'bbb', name: 'Review', state: 'blocked' },
      ]),
    );
    const sessions = await listAgentSessions(claude);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0], {
      sessionId: 'aaa', cwd: '/repo/one', kind: 'interactive', pid: 93483, name: 'one-6a', status: 'idle',
    });
    // A background agent reports `state` where an interactive one reports `status`, and has no
    // pid at all — it is not attached to a terminal.
    assert.equal(sessions[1]?.kind, 'background');
    assert.equal(sessions[1]?.status, 'blocked');
    assert.equal(sessions[1]?.pid, undefined);
  });

  it('skips an entry with nothing to identify it by', async () => {
    const claude = await stub(JSON.stringify([{ cwd: '/repo' }, { sessionId: 'x' }, { sessionId: 'y', cwd: '/ok' }]));
    assert.deepEqual((await listAgentSessions(claude)).map((s) => s.sessionId), ['y']);
  });

  it('says nothing rather than throwing when the CLI has no such subcommand', async () => {
    resetAgentSupport();
    const claude = await stub('', 1);
    assert.deepEqual(await listAgentSessions(claude), []);
  });

  it('says nothing when there is no CLI at all', async () => {
    assert.deepEqual(await listAgentSessions(path.join(dir, 'absent')), []);
  });

  it('survives output that is not the JSON we expect', async () => {
    assert.deepEqual(await listAgentSessions(await stub('not json at all')), []);
    resetAgentSupport();
    assert.deepEqual(await listAgentSessions(await stub('{"not":"an array"}')), []);
  });

  it('reuses the answer rather than starting the CLI again', async () => {
    // Every panel refresh asks. Starting a node process each time is what this replaces.
    const counter = path.join(dir, 'runs');
    const file = path.join(dir, 'claude');
    await fs.writeFile(file, `#!/bin/sh\necho x >> ${counter}\necho '[]'\n`, 'utf8');
    await fs.chmod(file, 0o755);
    await listAgentSessions(file);
    await listAgentSessions(file);
    await listAgentSessions(file);
    const runs = (await fs.readFile(counter, 'utf8')).trim().split('\n').length;
    assert.equal(runs, 1, 'one invocation for three asks');
  });
});
