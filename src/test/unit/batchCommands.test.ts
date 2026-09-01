import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { batchCommands } from '../../commands/batchCommands';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';
import { createAnchor } from '../../anchor/anchorService';
import { Deps } from '../../commands/deps';
import { NewNoteInput, ReviewNote } from '../../model/note';
import { reportPath } from '../../claude/reportFile';

/**
 * The orchestrator: what is sent, when it is held, and what comes back.
 *
 * A thousand lines with no test that loaded them. Its pieces are covered on their own — the
 * queue, the serialiser, the report reader — but the wiring between them is where the bugs
 * were: a queued note sent twice, a report applied over a follow-up, a round held for ever
 * because the signal that releases it never came.
 */
describe('the round trip, from send to answer', () => {
  const CODE = 'export const Card = ({ id }) => (\n  <div id={id} />\n);';
  let home: string;
  let repo: string;

  const store = (): ReviewStore =>
    new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, {
      archiveLimit: () => 5,
    });

  const add = (s: ReviewStore, body: string): ReviewNote => {
    const range = { startLine: 1, startChar: 0, endLine: 1, endChar: 16 };
    const input: NewNoteInput = {
      path: 'src/Card.tsx',
      workspaceFolder: 'repo',
      range,
      anchor: createAnchor(CODE, range),
      body,
    };
    return s.add(input);
  };

  /** `deps` with everything stubbed to the quietest thing it could truthfully be. */
  const deps = (s: ReviewStore, over: Partial<Deps> = {}): Deps =>
    ({
      context: { extensionUri: vscode.Uri.file('/ext'), subscriptions: [], globalState: { get: () => undefined, update: () => Promise.resolve() } },
      config: {
        outputTemplate: 'claude-prompt',
        includeSnippet: true,
        includeGitContext: false,
        scopeGuard: false,
        requestReport: true,
        confirmOnSubmit: false,
        claudeAutoSubmit: false,
        clearDoneAfterReport: false,
        threads: true,
        renderConfig: () => ({
          outputTemplate: 'claude-prompt',
          includeSnippet: true,
          includeGitContext: false,
          scopeGuard: false,
          requestReport: false,
          threads: true,
        }),
      },
      logger: { info: () => undefined, warn: () => undefined, trace: () => undefined },
      store: s,
      host: { noteIdFor: () => undefined, ensureThread: () => undefined },
      git: { getApi: () => Promise.resolve(undefined), snapshot: () => Promise.resolve(undefined) },
      index: { changedSinceSent: () => false, clearChangedSinceSent: () => undefined, clearSentSignals: () => undefined, panelNotes: () => s.notes, onDidChange: () => ({ dispose: () => undefined }) },
      range: { repoRoot: () => Promise.resolve(repo), invalidate: () => undefined, invalidateBase: () => undefined, summary: () => Promise.resolve(undefined) },
      watcher: { monitor: () => undefined, state: 'off' },
      ...over,
    }) as unknown as Deps;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-batch-'));
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-repo-'));
    (vscode as unknown as { resetStub(): void }).resetStub();
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [
      { uri: vscode.Uri.file('/repo') },
    ];
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });

  describe('holding a send while the agent is working', () => {
    it('holds it rather than typing into the middle of a turn', async () => {
      const s = store();
      const n = add(s, 'rename this');
      s.markSent([n.id]);
      s.update(n.id, { addenda: ['Claude: done', 'not quite'] });

      const batch = batchCommands(deps(s, { signals: { running: true } }));
      try {
        await batch.sendSelected(n.id);
        assert.deepEqual(batch.queuedIds(), [n.id], 'waiting, not sent');
        assert.ok(
          (vscode as unknown as { shown: { statusBar: string[] } }).shown.statusBar.some((m) =>
            /queued/.test(m),
          ),
          'and said so',
        );
      } finally {
        batch.dispose();
      }
    });

    it('sends straight away when the agent is idle', async () => {
      const s = store();
      const n = add(s, 'rename this');
      const batch = batchCommands(deps(s, { signals: { running: false } }));
      try {
        await batch.sendSelected(n.id);
        assert.deepEqual(batch.queuedIds(), [], 'nothing held');
        assert.ok(s.getById(n.id)?.sent, 'and it went');
      } finally {
        batch.dispose();
      }
    });

    it('holds two follow-ups written before the first was answered', async () => {
      // The case a single flag could not represent, end to end this time.
      const s = store();
      const a = add(s, 'first');
      const b = add(s, 'second');
      s.markSent([a.id, b.id]);
      s.update(a.id, { addenda: ['Claude: done', 'more on this'] });
      s.update(b.id, { addenda: ['Claude: done', 'and this'] });

      const batch = batchCommands(deps(s, { signals: { running: true } }));
      try {
        await batch.sendSelected(a.id);
        await batch.sendSelected(b.id);
        assert.deepEqual(batch.queuedIds(), [a.id, b.id], 'both, in the order they were asked for');
      } finally {
        batch.dispose();
      }
    });

    it('stops holding one without calling off the others', async () => {
      const s = store();
      const a = add(s, 'first');
      const b = add(s, 'second');
      s.markSent([a.id, b.id]);
      for (const n of [a, b]) s.update(n.id, { addenda: ['Claude: done', 'more'] });

      const batch = batchCommands(deps(s, { signals: { running: true } }));
      try {
        await batch.sendSelected(a.id);
        await batch.sendSelected(b.id);
        batch.cancelQueued(a.id);
        assert.deepEqual(batch.queuedIds(), [b.id], 'the card you clicked, not the queue');
      } finally {
        batch.dispose();
      }
    });
  });

  describe('applying what the agent reported', () => {
    const writeReport = async (notes: unknown[]): Promise<void> => {
      const file = reportPath(repo, home);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ notes }), 'utf8');
    };

    it('keeps one answer per round when the agent refines what it wrote', async () => {
      /*
       * The report is read while the run is still going, so the same note is answered several
       * times as the agent rewrites its sentence. Appending each version showed the answer
       * twice on the card, in slightly different words.
       */
      const s = store();
      const n = add(s, 'rename this');
      s.markSent([n.id]);

      await writeReport([{ seq: n.seq, outcome: 'done', text: 'renamed it' }]);
      const batch = batchCommands(deps(s, { range: { repoRoot: () => Promise.resolve(repo), invalidate: () => undefined, invalidateBase: () => undefined, summary: () => Promise.resolve(undefined) } as never }));
      try {
        process.env['HOME'] = home;
        await batch.applyFiledSoFar();
        await writeReport([{ seq: n.seq, outcome: 'done', text: 'renamed the prop to isPending' }]);
        await batch.applyFiledSoFar();

        const after = s.getById(n.id)!;
        const agentTurns = after.addenda.filter((t) => t.startsWith('Claude:'));
        assert.equal(agentTurns.length, 1, 'one answer, not one per rewrite');
        assert.match(agentTurns[0] ?? '', /renamed the prop to isPending/, 'the newest wording');
      } finally {
        batch.dispose();
      }
    });

    it('does not settle a note on the agent saying it is finished', async () => {
      // Claude reporting done is a claim about the code, not a verdict on it. Approving is
      // what closes a note, and it is the whole point of the panel.
      const s = store();
      const n = add(s, 'rename this');
      s.markSent([n.id]);
      await writeReport([{ seq: n.seq, outcome: 'done', text: 'renamed it' }]);

      const batch = batchCommands(deps(s));
      try {
        process.env['HOME'] = home;
        await batch.applyFiledSoFar();
        assert.equal(s.getById(n.id)?.done, false, 'still waiting for a reader');
        assert.equal(s.getById(n.id)?.sent?.outcome, 'done');
      } finally {
        batch.dispose();
      }
    });

    it('leaves a follow-up written while the report was being read', async () => {
      /*
       * The interleaving that lost one: the notes are gathered, the file is read — and a
       * follow-up typed in that window went into the store and was then overwritten by a patch
       * built from the older copy, with no error and no trace.
       */
      const s = store();
      const n = add(s, 'rename this');
      s.markSent([n.id]);
      await writeReport([{ seq: n.seq, outcome: 'done', text: 'renamed it' }]);

      const batch = batchCommands(deps(s));
      try {
        process.env['HOME'] = home;
        const applying = batch.applyFiledSoFar();
        // Typed while the file is being read.
        s.update(n.id, { addenda: [...s.getById(n.id)!.addenda, 'also check the other one'] });
        await applying;
        assert.ok(
          s.getById(n.id)!.addenda.includes('also check the other one'),
          'the words that were typed are still there',
        );
      } finally {
        batch.dispose();
      }
    });

    it('ignores an answer for a note that is no longer here', async () => {
      const s = store();
      const n = add(s, 'rename this');
      s.markSent([n.id]);
      await writeReport([{ seq: 999, outcome: 'done', text: 'about something else' }]);

      const batch = batchCommands(deps(s));
      try {
        process.env['HOME'] = home;
        await batch.applyFiledSoFar();
        assert.equal(s.getById(n.id)?.sent?.outcome, undefined, 'untouched');
      } finally {
        batch.dispose();
      }
    });
  });
});
