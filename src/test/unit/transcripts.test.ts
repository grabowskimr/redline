import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findSessions,
  lastRequestStart,
  lastRunStart,
  recentAssistantText,
  MAX_SESSION_WINDOW_MS,
  projectSlug,
  reviewWindowStart,
} from '../../claude/transcripts';

describe('claude transcripts', () => {
  it('derives the project slug the way Claude Code stores it', () => {
    assert.equal(
      projectSlug('/Users/me/orca/workspaces/acme/add-settings-to-filter'),
      '-Users-me-orca-workspaces-acme-add-settings-to-filter',
    );
    // Dots become dashes too, which is why `.claude` yields a double dash.
    assert.equal(projectSlug('/Users/me/.claude/double-shot'), '-Users-me--claude-double-shot');
  });

  it('uses the session start when the session is short', () => {
    const session = {
      file: 'x',
      sessionId: 'x',
      startedAt: '2026-08-24T09:52:39.231Z',
      lastActivityAt: '2026-08-24T13:06:35.238Z',
    };
    assert.equal(reviewWindowStart(session), '2026-08-24T09:52:39.231Z');
  });

  it('caps a long-lived transcript to the review window', () => {
    const last = Date.parse('2026-08-24T13:00:00.000Z');
    const session = {
      file: 'x',
      sessionId: 'x',
      startedAt: '2026-08-01T09:00:00.000Z',
      lastActivityAt: new Date(last).toISOString(),
    };
    assert.equal(reviewWindowStart(session), new Date(last - MAX_SESSION_WINDOW_MS).toISOString());
  });

  it('reads the time span from both ends of a real transcript file', async () => {
    const cwd = path.join(os.tmpdir(), `lr-transcript-${Date.now()}`);
    const dir = path.join(os.homedir(), '.claude', 'projects', projectSlug(cwd));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'session-a.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-08-24T10:00:00.000Z' }),
      ...Array.from({ length: 300 }, (_, i) =>
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-24T11:00:00.000Z', filler: 'x'.repeat(500), i }),
      ),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-24T12:34:56.000Z' }),
    ];
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
    try {
      const sessions = await findSessions(cwd);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.startedAt, '2026-08-24T10:00:00.000Z');
      assert.equal(sessions[0]?.lastActivityAt, '2026-08-24T12:34:56.000Z');
      assert.equal(sessions[0]?.sessionId, 'session-a');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('lastRunStart', () => {
    const GAP = 15 * 60 * 1000;
    let dir: string;

    const write = async (name: string, stamps: string[], pad = 0): Promise<string> => {
      const file = path.join(dir, name);
      const lines = stamps.map((t) =>
        JSON.stringify({ type: 'assistant', timestamp: t, filler: 'x'.repeat(pad) }),
      );
      await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
      return file;
    };
    const session = (file: string, startedAt: string, lastActivityAt: string) => ({
      file,
      sessionId: 's',
      startedAt,
      lastActivityAt,
    });

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-runs-'));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('cuts at the last gap longer than the threshold', async () => {
      const file = await write('a.jsonl', [
        '2026-08-24T09:00:00.000Z',
        '2026-08-24T09:05:00.000Z',
        // 50 minutes idle — a new run starts here
        '2026-08-24T09:55:00.000Z',
        '2026-08-24T09:58:00.000Z',
      ]);
      assert.equal(
        await lastRunStart(session(file, '2026-08-24T09:00:00.000Z', '2026-08-24T09:58:00.000Z'), GAP),
        '2026-08-24T09:55:00.000Z',
      );
    });

    it('treats an uninterrupted session as a single run', async () => {
      const file = await write('b.jsonl', [
        '2026-08-24T09:00:00.000Z',
        '2026-08-24T09:10:00.000Z',
        '2026-08-24T09:20:00.000Z',
      ]);
      assert.equal(
        await lastRunStart(session(file, '2026-08-24T09:00:00.000Z', '2026-08-24T09:20:00.000Z'), GAP),
        '2026-08-24T09:00:00.000Z',
        'falls back to the session start, so nothing from the run is excluded',
      );
    });

    it('keeps a long pause inside one run when the gap allows it', async () => {
      const file = await write('c.jsonl', ['2026-08-24T09:00:00.000Z', '2026-08-24T09:40:00.000Z']);
      const s = session(file, '2026-08-24T09:00:00.000Z', '2026-08-24T09:40:00.000Z');
      assert.equal(await lastRunStart(s, 60 * 60 * 1000), '2026-08-24T09:00:00.000Z');
      assert.equal(await lastRunStart(s, GAP), '2026-08-24T09:40:00.000Z');
    });

    it('finds the boundary in a transcript far larger than the first read window', async () => {
      // Entries big enough that the 96 KB window cannot reach the gap.
      const stamps = [
        '2026-08-24T08:00:00.000Z',
        ...Array.from({ length: 400 }, () => '2026-08-24T08:30:00.000Z'),
        '2026-08-24T11:00:00.000Z',
        '2026-08-24T11:01:00.000Z',
      ];
      const file = await write('d.jsonl', stamps, 800);
      assert.ok((await fs.stat(file)).size > 96 * 1024, 'test file must exceed the first window');
      assert.equal(
        await lastRunStart(session(file, '2026-08-24T08:00:00.000Z', '2026-08-24T11:01:00.000Z'), GAP),
        '2026-08-24T11:00:00.000Z',
      );
    });

    it('falls back to the session start when the transcript is gone', async () => {
      assert.equal(
        await lastRunStart(session(path.join(dir, 'missing.jsonl'), '2026-08-24T09:00:00.000Z', '2026-08-24T09:30:00.000Z'), GAP),
        '2026-08-24T09:00:00.000Z',
      );
    });
  });

  describe('lastRequestStart', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-req-'));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    const session = (file: string) => ({
      file,
      sessionId: 's',
      startedAt: '2026-08-26T09:00:00.000Z',
      lastActivityAt: '2026-08-26T10:00:00.000Z',
    });

    it('finds the newest real request and ignores tool results', async () => {
      const file = path.join(dir, 'a.jsonl');
      await fs.writeFile(
        file,
        [
          JSON.stringify({ type: 'user', timestamp: '2026-08-26T09:10:00.000Z', message: { content: 'first ask' } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-08-26T09:11:00.000Z', message: { content: [] } }),
          JSON.stringify({ type: 'user', timestamp: '2026-08-26T09:30:00.000Z', message: { content: 'second ask' } }),
          // Tool results are recorded as user turns too; counting them would put the
          // boundary at the agent's own last tool call.
          JSON.stringify({
            type: 'user',
            timestamp: '2026-08-26T09:45:00.000Z',
            message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      assert.equal(await lastRequestStart(session(file)), '2026-08-26T09:30:00.000Z');
    });

    it('separates three requests minutes apart, which an idle gap cannot', async () => {
      const file = path.join(dir, 'b.jsonl');
      const asks = ['09:00', '09:04', '09:08'].map((t) =>
        JSON.stringify({ type: 'user', timestamp: `2026-08-26T${t}:00.000Z`, message: { content: 'change this' } }),
      );
      await fs.writeFile(file, asks.join('\n') + '\n', 'utf8');
      const s = session(file);
      assert.equal(await lastRequestStart(s), '2026-08-26T09:08:00.000Z', 'the latest request only');
      assert.equal(
        await lastRunStart(s, 15 * 60 * 1000),
        s.startedAt,
        'the idle-gap rule sees one run and would include all three',
      );
    });

    it('ignores sidechain and meta turns', async () => {
      const file = path.join(dir, 'c.jsonl');
      await fs.writeFile(
        file,
        [
          JSON.stringify({ type: 'user', timestamp: '2026-08-26T09:00:00.000Z', message: { content: 'real ask' } }),
          JSON.stringify({ type: 'user', timestamp: '2026-08-26T09:05:00.000Z', isSidechain: true, message: { content: 'subagent' } }),
          JSON.stringify({ type: 'user', timestamp: '2026-08-26T09:06:00.000Z', isMeta: true, message: { content: 'meta' } }),
        ].join('\n') + '\n',
        'utf8',
      );
      assert.equal(await lastRequestStart(session(file)), '2026-08-26T09:00:00.000Z');
    });

    it('returns undefined when there is no request to find', async () => {
      const file = path.join(dir, 'd.jsonl');
      await fs.writeFile(file, JSON.stringify({ type: 'assistant', timestamp: '2026-08-26T09:00:00.000Z' }) + '\n', 'utf8');
      assert.equal(await lastRequestStart(session(file)), undefined);
    });
  });

  describe('recentAssistantText', () => {
    it('returns the assistant\'s own words and ignores tools, users and subagents', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-report-'));
      const file = path.join(dir, 's.jsonl');
      const entry = (o: object): string => JSON.stringify(o);
      await fs.writeFile(
        file,
        [
          entry({ type: 'user', message: { content: [{ type: 'text', text: 'do the thing' }] } }),
          entry({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
          // a subagent's summary must not be mistaken for the main thread's report
          entry({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '#9 done' }] } }),
          'not json at all',
          entry({ type: 'assistant', message: { content: [{ type: 'text', text: '#2 done\n#3 skipped — no' }] } }),
        ].join('\n') + '\n',
        'utf8',
      );
      try {
        const text = await recentAssistantText({
          file,
          sessionId: 's',
          startedAt: '2026-08-24T09:00:00.000Z',
          lastActivityAt: '2026-08-24T09:30:00.000Z',
        });
        assert.match(text, /#2 done/);
        assert.match(text, /#3 skipped/);
        assert.doesNotMatch(text, /#9 done/, 'subagent output excluded');
        assert.doesNotMatch(text, /do the thing/, 'user turns excluded');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('returns empty string when the transcript is missing', async () => {
      assert.equal(
        await recentAssistantText({
          file: '/definitely/not/here.jsonl',
          sessionId: 's',
          startedAt: '2026-08-24T09:00:00.000Z',
          lastActivityAt: '2026-08-24T09:30:00.000Z',
        }),
        '',
      );
    });
  });

  it('returns nothing when Claude never ran in the folder', async () => {
    assert.deepEqual(await findSessions('/definitely/not/a/claude/project'), []);
  });
});
