import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { batchCommands } from '../../commands/batchCommands';
import { queueToRestore, SendQueue, shouldConfirm } from '../../commands/sendQueue';
import { projectSlug, slugInScope } from '../../claude/transcripts';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';
import { createAnchor } from '../../anchor/anchorService';
import { Deps } from '../../commands/deps';
import { NewNoteInput, ReviewNote } from '../../model/note';

/**
 * The promise the queue makes: a note written while Claude is mid-run goes when the run ends,
 * on its own, with nobody there to press anything.
 *
 * `flushQueued` had no test at all, and that is where the promise was being broken — quietly
 * every time, for anyone who had never turned the confirmation off.
 */
describe('the queue emptying itself when the run ends', () => {
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

  /** What a window remembers between sessions, which the plain stub context does not model. */
  const memory = (): { store: Record<string, unknown> } & Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    return {
      store: kept,
      get: (key: string): unknown => kept[key],
      update: (key: string, value: unknown): Promise<void> => {
        kept[key] = value;
        return Promise.resolve();
      },
    };
  };

  /**
   * `confirmOnSubmit: true` — the shipped default, and the reason this was invisible.
   *
   * The other suite stubs it to false, so every send it exercised skipped the modal that the
   * automatic flush was walking into.
   */
  const deps = (s: ReviewStore, over: Partial<Deps> = {}, extra: Record<string, unknown> = {}): Deps =>
    ({
      context: {
        extensionUri: vscode.Uri.file('/ext'),
        subscriptions: [],
        globalState: { get: () => undefined, update: () => Promise.resolve() },
        ...extra,
      },
      config: {
        outputTemplate: 'claude-prompt',
        includeSnippet: true,
        includeGitContext: false,
        scopeGuard: false,
        requestReport: true,
        confirmOnSubmit: true,
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
      index: {
        changedSinceSent: () => false,
        clearChangedSinceSent: () => undefined,
        clearSentSignals: () => undefined,
        panelNotes: () => s.notes,
        onDidChange: () => ({ dispose: () => undefined }),
      },
      range: {
        repoRoot: () => Promise.resolve(repo),
        invalidate: () => undefined,
        invalidateBase: () => undefined,
        summary: () => Promise.resolve(undefined),
      },
      watcher: { monitor: () => undefined, state: 'off' },
      ...over,
    }) as unknown as Deps;

  const statusBar = (): string[] =>
    (vscode as unknown as { shown: { statusBar: string[] } }).shown.statusBar;
  const messages = (): string[] => (vscode as unknown as { shown: { messages: string[] } }).shown.messages;
  const warnings = (): string[] => (vscode as unknown as { shown: { warnings: string[] } }).shown.warnings;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-flush-'));
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-flush-repo-'));
    (vscode as unknown as { resetStub(): void }).resetStub();
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [
      { uri: vscode.Uri.file('/repo') },
    ];
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('sends the held notes without asking, on the default configuration', async () => {
    /*
     * The reported failure. `confirmOnSubmit` defaults to true and the flush went through the
     * same modal: queue a note, walk away, and the run ending put up a dialog nobody was there
     * to answer — while the queue had already been emptied, so nothing was waiting, no timer
     * was watching and nothing said a word. The stub answers every dialog with Escape, which
     * is exactly the person who walked away.
     */
    const s = store();
    const n = add(s, 'rename this');
    const signals = { running: true };
    const batch = batchCommands(deps(s, { signals }));
    try {
      await batch.sendSelected(n.id);
      assert.deepEqual(batch.queuedIds(), [n.id], 'held while the run was going');

      signals.running = false;
      await batch.flushQueued();

      assert.ok(s.getById(n.id)?.sent, 'it went, with nobody there to confirm it');
      assert.deepEqual(batch.queuedIds(), [], 'and is no longer waiting');
      assert.ok(
        statusBar().some((m) => /Claude is free/.test(m)),
        'and the status bar said so',
      );
    } finally {
      batch.dispose();
    }
  });

  it('still asks when the send was started by hand', async () => {
    // The bypass is the flush path only. A person pressing Send gets the confirmation they
    // configured, and escaping it sends nothing.
    const s = store();
    const n = add(s, 'rename this');
    const batch = batchCommands(deps(s, { signals: { running: false } }));
    try {
      await batch.submit();
      assert.equal(s.getById(n.id)?.sent, undefined, 'escaped, so nothing went');
    } finally {
      batch.dispose();
    }
  });

  it('holds on while another session in this repository is still working', async () => {
    /*
     * The markers are keyed by repository root, so this window hears every session's run end.
     * "A run ended" is not "the agent is free": flushing on someone else's finish types into
     * the turn that is still going — the exact thing the queue exists to prevent.
     */
    const s = store();
    const n = add(s, 'rename this');
    const signals = { running: true };
    const batch = batchCommands(deps(s, { signals }));
    try {
      await batch.sendSelected(n.id);
      await batch.flushQueued();
      assert.deepEqual(batch.queuedIds(), [n.id], 'still waiting');
      assert.equal(s.getById(n.id)?.sent, undefined, 'and nothing was typed into that turn');
    } finally {
      batch.dispose();
    }
  });

  it('says so when a queued note is no longer here', async () => {
    // *Clear sent*, or a deleted note. The card promised to go when Claude finished and now
    // cannot, and the flush used to return before saying anything at all.
    const s = store();
    const a = add(s, 'first');
    const b = add(s, 'second');
    const signals = { running: true };
    const batch = batchCommands(deps(s, { signals }));
    try {
      await batch.sendSelected(a.id);
      await batch.sendSelected(b.id);
      s.delete([a.id]);
      signals.running = false;
      await batch.flushQueued();

      assert.ok(s.getById(b.id)?.sent, 'the one still here went');
      assert.ok(
        messages().some((m) => /no longer here/.test(m)),
        'and the one that had gone was accounted for',
      );
    } finally {
      batch.dispose();
    }
  });

  it('says so when every queued note has gone', async () => {
    const s = store();
    const n = add(s, 'rename this');
    const signals = { running: true };
    const batch = batchCommands(deps(s, { signals }));
    try {
      await batch.sendSelected(n.id);
      s.delete([n.id]);
      signals.running = false;
      await batch.flushQueued();
      assert.ok(
        messages().some((m) => /no longer here/.test(m)),
        'the promise was withdrawn out loud',
      );
    } finally {
      batch.dispose();
    }
  });

  it('puts the notes back when the send throws', async () => {
    // They are taken out of the queue before the send. A throw in between used to lose them
    // exactly as an escaped modal did: nothing queued, nothing sent, nothing said.
    const s = store();
    const n = add(s, 'rename this');
    const signals = { running: true };
    let broken = false;
    const d = deps(s, { signals });
    (d.config as unknown as { renderConfig: () => unknown }).renderConfig = (): unknown => {
      if (broken) throw new Error('rendering is broken');
      return {
        outputTemplate: 'claude-prompt',
        includeSnippet: true,
        includeGitContext: false,
        scopeGuard: false,
        requestReport: false,
        threads: true,
      };
    };
    const batch = batchCommands(d);
    try {
      await batch.sendSelected(n.id);
      broken = true;
      signals.running = false;
      await batch.flushQueued();

      assert.deepEqual(batch.queuedIds(), [n.id], 'still waiting, so the next quiet moment retries');
      assert.ok(
        warnings().some((m) => /could not send/.test(m)),
        'and the failure was reported',
      );
    } finally {
      batch.dispose();
    }
  });

  it('sends one batch when two run ends arrive together', async () => {
    // Two sessions stopping, or the hook and the poll racing. The second flush used to find a
    // queue the first had emptied but not yet sent.
    const s = store();
    const n = add(s, 'rename this');
    const signals = { running: true };
    const sends: number[] = [];
    const original = s.markSent.bind(s);
    (s as unknown as { markSent: unknown }).markSent = (...args: Parameters<ReviewStore['markSent']>) => {
      sends.push(args[0].length);
      return original(...args);
    };
    const batch = batchCommands(deps(s, { signals }));
    try {
      await batch.sendSelected(n.id);
      signals.running = false;
      await Promise.all([batch.flushQueued(), batch.flushQueued()]);
      assert.deepEqual(sends, [1], 'one send, not two');
    } finally {
      batch.dispose();
    }
  });

  it('flushes from the quiet poll when the run-end signal never comes', async () => {
    /*
     * A crashed agent or a killed terminal writes no stop marker, so the hook never fires and
     * the only thing left watching is the poll. Its interval is a quarter of a minute, so the
     * timer is driven by hand here rather than waited on.
     */
    const s = store();
    const n = add(s, 'rename this');
    const signals = { running: true };
    const timers: Array<() => void> = [];
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    (global as unknown as { setInterval: unknown }).setInterval = (fn: () => void): unknown => {
      timers.push(fn);
      return { id: timers.length };
    };
    (global as unknown as { clearInterval: unknown }).clearInterval = (): void => undefined;
    let batch: ReturnType<typeof batchCommands> | undefined;
    try {
      batch = batchCommands(deps(s, { signals }));
      await batch.sendSelected(n.id);
      assert.equal(timers.length, 1, 'holding starts something watching');

      signals.running = false;
      timers[0]?.();
      // The poll starts the flush without waiting for it; settle the chain it began.
      await batch.flushQueued();
      assert.ok(s.getById(n.id)?.sent, 'the poll got them out');
    } finally {
      (global as unknown as { setInterval: unknown }).setInterval = realSet;
      (global as unknown as { clearInterval: unknown }).clearInterval = realClear;
      batch?.dispose();
    }
  });

  it('aims a flush at the notes it is sending, not at whatever else the store holds', async () => {
    /*
     * `replies` was computed store-wide, so the session a flush went to was derived from notes
     * that were not being sent: queue A, leave an unrelated answered note Z — sent to another
     * session — carrying a draft follow-up, and A was flushed into Z's session.
     */
    const s = store();
    const a = add(s, 'the queued one');
    const z = add(s, 'answered, in another session');
    s.markSent([z.id], 'another-session');
    s.update(z.id, { addenda: ['Claude: done', 'and one more thing'] });

    const said: string[] = [];
    const signals = { running: true };
    const batch = batchCommands(
      deps(s, { signals, logger: { info: (m: string) => said.push(m), warn: () => undefined, trace: () => undefined } as never }),
    );
    try {
      await batch.sendSelected(a.id);
      signals.running = false;
      await batch.flushQueued();
      assert.ok(
        !said.some((m) => /session these notes are talking to/.test(m)),
        'Z’s session was never consulted for a batch Z is not in',
      );
    } finally {
      batch.dispose();
    }
  });

  it('cancels nothing when the card is not in the queue', async () => {
    // A stale card's ✕ used to fall through to "cancel everything" and then report that it
    // had called off one note.
    const s = store();
    const a = add(s, 'first');
    const b = add(s, 'second');
    const batch = batchCommands(deps(s, { signals: { running: true } }));
    try {
      await batch.sendSelected(a.id);
      batch.cancelQueued(b.id);
      assert.deepEqual(batch.queuedIds(), [a.id], 'the other card kept its promise');
      assert.ok(statusBar().some((m) => /not waiting to be sent/.test(m)), 'and said why');
    } finally {
      batch.dispose();
    }
  });

  it('brings the queue back into the next window', async () => {
    // It was a `Set` in memory and `deactivate` did nothing: close VS Code before the run
    // ended and three promised notes came back as ordinary unsent drafts.
    const s = store();
    const n = add(s, 'rename this');
    const kept = memory();
    const first = batchCommands(deps(s, { signals: { running: true } }, { workspaceState: kept }));
    try {
      await first.sendSelected(n.id);
      assert.deepEqual(kept.store['redline.sendQueue'], [n.id], 'written down as it is held');
    } finally {
      first.dispose();
    }

    const second = batchCommands(deps(s, { signals: { running: true } }, { workspaceState: kept }));
    try {
      assert.deepEqual(second.queuedIds(), [n.id], 'and still waiting in the new window');
    } finally {
      second.dispose();
    }
  });

  it('does not restore a queued note whose note has gone', async () => {
    const s = store();
    const n = add(s, 'rename this');
    const kept = memory();
    const first = batchCommands(deps(s, { signals: { running: true } }, { workspaceState: kept }));
    try {
      await first.sendSelected(n.id);
    } finally {
      first.dispose();
    }
    s.delete([n.id]);
    const second = batchCommands(deps(s, { signals: { running: true } }, { workspaceState: kept }));
    try {
      assert.deepEqual(second.queuedIds(), [], 'nothing to promise');
    } finally {
      second.dispose();
    }
  });
});

describe('what a send decides before it asks anyone', () => {
  it('asks on a send someone started, and never on the queue emptying itself', () => {
    assert.equal(shouldConfirm(true, 'by hand'), true);
    assert.equal(shouldConfirm(true, 'automatic'), false, 'nobody is there to answer');
    assert.equal(shouldConfirm(false, 'by hand'), false);
  });

  it('reports what it dropped as well as what it will send', () => {
    const q = new SendQueue();
    q.hold(['a', 'b', 'c']);
    assert.deepEqual(q.takeWithLost((id) => id !== 'b'), { send: ['a', 'c'], lost: ['b'] });
  });

  it('restores only the ids that still name a note', () => {
    assert.deepEqual(queueToRestore(['a', 'b'], (id) => id === 'a'), ['a']);
    assert.deepEqual(queueToRestore(['a', 'a'], () => true), ['a'], 'and only once');
    assert.deepEqual(queueToRestore(undefined, () => true), [], 'nothing stored');
    assert.deepEqual(queueToRestore(['', 7, null], () => true), [], 'nothing usable stored');
  });
});

describe('which runs count as this window’s', () => {
  const ROOT = projectSlug('/Users/me/Projects/app');

  it('counts a run started above this folder', () => {
    // The window open on a package, the agent at the repository root: that run is ours.
    assert.equal(slugInScope(projectSlug('/Users/me/Projects'), [ROOT], 'self-or-above'), true);
  });

  it('does not count a run from a repository below this folder', () => {
    /*
     * The hook keys its markers by repository root, so a deeper slug is another repository —
     * and `/repo/frontend` and `/repo-frontend` are the same string, so it may not even be
     * below us. Either way its run ending is not ours ending, and treating it as ours flipped
     * this window to idle in the middle of a turn.
     */
    assert.equal(slugInScope(projectSlug('/Users/me/Projects/app/frontend'), [ROOT], 'self-or-above'), false);
    assert.equal(slugInScope(projectSlug('/Users/me/Projects/app'), [ROOT], 'self-or-above'), true);
  });

  it('still counts it for everything else, where the wider net is right', () => {
    assert.equal(slugInScope(projectSlug('/Users/me/Projects/app/frontend'), [ROOT]), true);
  });
});
