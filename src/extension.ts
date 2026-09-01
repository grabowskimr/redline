import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { Config, ARCHIVE_LIMIT } from './config';
import { Logger } from './logger';
import { Persistence } from './store/persistence';
import { ReviewStore } from './store/reviewStore';
import { emptyState } from './model/schema';
import { isOpen, ReviewNote } from './model/note';
import { GitService } from './git/gitApi';
import { GIT_TIMEOUT_MS, registerEmptySideProvider, ReviewRange } from './git/reviewRange';
import { RunGutter } from './git/runGutter';
import { LiveActivity } from './claude/liveActivity';
import { sweepScratchIndexes } from './git/snapshotTree';
import { registerTreeSideProvider } from './git/treeSide';
import { CommentHost } from './comments/commentHost';
import { NoteIndex } from './view/noteIndex';
import { CardsViewProvider, CARDS_VIEW_ID } from './view/cardsView';
import { NoteDecorations } from './view/noteDecorations';
import { StatusBar } from './view/statusBar';
import { LiveTracker } from './anchor/liveTracker';
import { Attachments } from './store/attachments';
import { migrateLegacyStorage } from './store/migrate';
import { setUpHook } from './commands/hookSetup';
import { HookSignals } from './claude/hookSignals';
import { SessionWatcher } from './claude/sessionWatcher';
import { resolveTarget } from './claude/claudeSession';
import { registerAllCommands } from './commands';
import { noteCommands } from './commands/noteCommands';
import { batchCommands } from './commands/batchCommands';
import { Deps } from './commands/deps';

let store: ReviewStore | undefined;
/** Set once Ask exists, so a closing window does not lose a comment written a moment ago. */

/** Minimal API returned from `activate` — used by the integration tests. */
export interface RedlineApi {
  readonly store: ReviewStore;
  createNoteAt(uri: vscode.Uri, range: vscode.Range, body: string): Promise<ReviewNote | undefined>;
  /** True once the panel's webview has booted and reported in (smoke test hook). */
  panelReady(timeoutMs?: number): Promise<boolean>;
  /** Attach bytes exactly as a drop or paste would (test hook). */
  attachFile(noteId: string, name: string, bytes: Uint8Array): Promise<string | undefined>;
  attachPaths(noteId: string, paths: string[]): Promise<string[]>;
  /** Hook signals seen so far — lets a test prove the push channel is live. */
  hookSignals(): { touched: number; ended: number };
  /** How long activation took, so the cost of loading this can be asserted rather than assumed. */
  activationMs(): number;
  /** The change range, so a test can exercise it against a real repository. */
  range: ReviewRange;
  /**
   * Runs the hook has reported here, and a way to drive that path directly.
   *
   * A notification cannot be asserted, and the thing worth asserting is that a run gets
   * reported at all when there is no session VS Code can reach.
   */
  hookRuns(): number;
  reportHookRun(): Promise<void>;
}

/** Wall time activation took, reported through the API so it can be asserted, not assumed. */
let activationCost = 0;

/**
 * Reads a file out of a snapshot for the diff editor. Bound to the repository named in the
 * URI rather than to the open folder, so a multi-root window resolves each side correctly.
 */
const gitIn = (root: string) => async (args: string[]): Promise<string> => {
  // Same reason as everywhere else git runs: a repository defines filters and configuration
  // that git will execute, so none of it runs until the folder is trusted.
  if (!vscode.workspace.isTrusted) return '';
  const { stdout } = await promisify(execFile)('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    // The same bound as every other git call. This one feeds the "before" side of a diff, so a
    // `git` that never returns leaves the diff editor loading for ever, with no way back but
    // reloading the window — the exact failure the timeout elsewhere exists to prevent.
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
};

export async function activate(context: vscode.ExtensionContext): Promise<RedlineApi | undefined> {
  const startedAt = Date.now();
  const logger = new Logger();
  const config = new Config();
  context.subscriptions.push(logger, config);
  logger.setLevel(config.trace);
  context.subscriptions.push(config.onDidChange(() => logger.setLevel(config.trace)));

  try {
    const api = await activateInner(context, logger, config);
    activationCost = Date.now() - startedAt;
    logger.info(`activated in ${activationCost}ms`);
    return api;
  } catch (err) {
    // Activation must never throw: the editor session has to stay usable.
    await logger.reportError('failed to activate', err);
    return undefined;
  }
}

async function activateInner(
  context: vscode.ExtensionContext,
  logger: Logger,
  config: Config,
): Promise<RedlineApi> {
  // ── persistence ──────────────────────────────────────────────────────
  const storage = context.storageUri ?? context.globalStorageUri;
  if (storage) await migrateLegacyStorage(storage, logger);
  const notesPath = storage ? path.join(storage.fsPath, 'notes.json') : undefined;
  const persistence = notesPath ? new Persistence(notesPath, logger) : undefined;
  if (!persistence) logger.warn('no storage location available; notes will not persist');
  const loaded = persistence ? await persistence.load() : { state: emptyState(), droppedNotes: 0 };
  if (loaded.quarantinedTo) {
    void logger.reportError(
      `the notes file was unreadable and was moved to ${loaded.quarantinedTo}; starting with an empty batch`,
    );
  }
  /*
   * The notes file is there but could not be read — a permission, a lock, a network share that
   * blinked. The panel comes up empty either way, so the user has to be told why: without it
   * they add one note, the debounced write lands, and their whole review is a one-note file.
   * `Persistence` refuses to write until a load succeeds; this is the half they can see.
   */
  const loadFailed = loaded.unreadable !== undefined;
  if (loadFailed) {
    void logger.reportError(
      `could not read your notes (${loaded.unreadable}) — the panel is empty but the file is intact, ` +
        'and nothing will be saved over it. Reload the window once the file is readable again.',
    );
  }
  store = new ReviewStore(loaded.state, persistence, { archiveLimit: () => ARCHIVE_LIMIT });
  context.subscriptions.push(store);
  logger.info(`loaded ${store.notes.length} note(s) from ${notesPath ?? '(memory)'}`);

  // Another window on the same folder writes whole-state; pick its writes up instead of
  // clobbering them.
  if (persistence && notesPath) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(notesPath)), path.basename(notesPath)),
    );
    let timer: NodeJS.Timeout | undefined;
    const onChange = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void (async () => {
          if (!(await persistence.changedExternally())) return;
          persistence.discardPending();
          const result = await persistence.load();
          // A read that failed is not an empty file. Handing that empty state to `reload`
          // wiped the in-memory notes, and the next edit wrote the wipe back out — the same
          // hole as the load at activation, reached from the watcher instead.
          if (result.unreadable !== undefined) {
            logger.warn(`notes.json changed externally but could not be read (${result.unreadable}); keeping what is in memory`);
            return;
          }
          store?.reload(result.state);
          logger.info('notes.json changed externally; reloaded');
        })();
      }, 300);
    };
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(onChange),
      watcher.onDidCreate(onChange),
      { dispose: () => timer && clearTimeout(timer) },
    );
  }

  // ── services ─────────────────────────────────────────────────────────
  const git = new GitService(logger);
  const index = new NoteIndex(store);
  const host = new CommentHost(store, config, logger, context);

  // The widget stays on a note until the code under it moves. The tracker fills the index as
  // documents are read; the host asks it rather than keeping a second copy.
  host.linesChanged = (id) => index.linesChanged(id);
  // ... and is told when the answer changes, which no store event announces.
  context.subscriptions.push(index.onDidChange(() => host.sync()));

  const range = new ReviewRange(store, logger, git, config);

  // Gutter marks for the run's own changes, beside the git extension's marks against HEAD.
  const gutter = new RunGutter(range, () => config.runGutter);
  context.subscriptions.push(gutter, config.onDidChange(() => gutter.sync()));
  const attachments = new Attachments(context, store, logger);
  const watcher = new SessionWatcher(logger);
  // `host` disposed here directly, exactly once, regardless of which surface is current —
  // `CommentSurface.dispose()` no longer cascades into it (see above), so this is now the
  // only place that tears it down.
  //
  // The surface entry comes before `host`: VS Code disposes `context.subscriptions` in the
  context.subscriptions.push(
    index,
    host,
    range,
    watcher,
    registerEmptySideProvider(),
    registerTreeSideProvider(gitIn, () => range.repoRoot()),
  );
  // Housekeeping for snapshots a killed window could not clean up after itself.
  void sweepScratchIndexes();
  // Only against a store that is actually the user's notes. This deletes every file in the
  // attachment directory nothing in the store references, so running it after a failed load
  // — where the store is empty because the file could not be read — deleted every screenshot
  // the user had ever attached.
  if (!loadFailed) void attachments.cleanupOrphans();

  // ── UI ───────────────────────────────────────────────────────────────
  const decorations = new NoteDecorations(store);
  decorations.linesChanged = (id) => index.linesChanged(id);
  context.subscriptions.push(index.onDidChange(() => decorations.schedule()));

  const cards = new CardsViewProvider(context, store, index, logger);
  cards.attachments = attachments;
  cards.watcher = watcher;
  cards.range = range;
  context.subscriptions.push(
    cards,
    vscode.window.registerWebviewViewProvider(CARDS_VIEW_ID, cards, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    range.onDidChange(() => void cards.postSession()),
    watcher.onDidChangeState(() => void cards.postSession()),
    decorations,
  );

  const statusBar = new StatusBar(store, config, index, range, watcher);
  context.subscriptions.push(
    statusBar,
    store.onDidChange(() => statusBar.update()),
    index.onDidChange(() => statusBar.update()),
    range.onDidChange(() => statusBar.update()),
    watcher.onDidChangeState(() => statusBar.update()),
  );

  // ── anchoring ────────────────────────────────────────────────────────
  const tracker = new LiveTracker(store, host, index, logger);
  context.subscriptions.push(tracker);
  void tracker.resolveAll();
  context.subscriptions.push(
    store.onDidChange((e) => {
      if (e.type === 'restore' || e.type === 'reload') void tracker.resolveAll();
    }),
  );

  // ── commands ─────────────────────────────────────────────────────────
  const deps: Deps = {
    context,
    config,
    logger,
    store,
    host,
    git,
    index,
    range,
    watcher,
    // Screenshots outlive the note that referred to them unless something says otherwise —
    // and "otherwise" has to be the real store. While a failed read is holding writes back the
    // store is empty for reasons that have nothing to do with what the user attached.
    sweepAttachments: () => {
      if (!persistence?.suspended) void attachments.cleanupOrphans();
    },
  };
  const notes = noteCommands(deps);
  const batch = batchCommands(deps);
  context.subscriptions.push(batch);

  registerAllCommands(context, logger, {
    'redline.createNote': notes.createNote,
    'redline.replyToThread': notes.replyToThread,
    'redline.addNoteHere': notes.addNoteHere,
    'redline.quickAddNote': notes.quickAddNote,
    'redline.editComment': notes.editComment,
    'redline.saveComment': notes.saveComment,
    'redline.cancelEdit': notes.cancelEdit,
    'redline.deleteNote': notes.deleteNote,
    'redline.setKind': notes.setKind,
    'redline.kindChange': notes.kindChange,
    'redline.kindBug': notes.kindBug,
    'redline.kindIdea': notes.kindIdea,
    'redline.kindRefactor': notes.kindRefactor,
    'redline.kindQuestion': notes.kindQuestion,
    'redline.toggleDone': notes.toggleDone,
    'redline.revealNote': notes.revealNote,
    'redline.reanchorNote': notes.reanchorNote,
    'redline.submit': () => batch.submit(),
    'redline.sendSelected': batch.sendSelected,
    'redline.previewBatch': batch.previewBatch,
    'redline.copyNote': batch.copyNote,
    'redline.applyReport': batch.applyReport,
    'redline.clearSent': batch.clearSent,
    'redline.clearAll': batch.clearAll,
    'redline.restoreLastBatch': batch.restoreLastBatch,
    'redline.pickSession': batch.pickSession,
    'redline.reviewChanges': batch.reviewChanges,
    'redline.reviewAllChanges': batch.reviewAllChanges,
    'redline.nextChange': batch.nextChange,
    'redline.prevChange': batch.prevChange,
    'redline.markBaseline': batch.markBaseline,
    'redline.clearBaseline': batch.clearBaseline,
    'redline.refresh': batch.refresh,
    'redline.approveNote': notes.approveNote,
    'redline.cancelQueued': batch.cancelQueued,
    'redline.needsWork': notes.needsWork,
    'redline.reviewPreviousRun': batch.reviewPreviousRun,
    'redline.setUpHook': () => setUpHook(context, logger),
    'redline.showLog': batch.showLog,
    'redline.focusPanel': () => vscode.commands.executeCommand(`${CARDS_VIEW_ID}.focus`),
  });

  // ── session monitor ──────────────────────────────────────────────────
  // The workflow is "Claude runs, then VS Code opens", so runs are usually already over;
  // the monitor only adds live notifications when a run happens while we are watching.
  context.subscriptions.push(
    watcher.onDidFinish((e) =>
      void (e.external ? batch.onExternalRunFinished(e.target) : batch.onAgentFinished(e.target)),
    ),
    watcher.onRunStarted(() => range.invalidate()),
  );

  // The hook tells us when the agent touched a file and when it stopped, so the panel can
  // react at once instead of waiting for a timer. Works in any terminal — unlike the Orca
  // idle monitor above, which is the only other source of a "run finished" signal.
  void HookSignals.ensureDirectory();
  const signals = new HookSignals(logger);
  cards.signals = signals;
  // The status bar reads the same source the panel does, or the two disagree about whether
  // Claude is working — with the plugin installed and no Orca terminal, the panel said so and
  // the status bar showed nothing.
  statusBar.signals = signals;
  context.subscriptions.push(
    signals.onDidTouch(() => statusBar.update()),
    signals.onDidEndRun(() => statusBar.update()),
  );
  // What the session is working on, from the hook's own record of what it writes. A terminal
  // in another window shows this and the panel could not.
  const live = new LiveActivity(signals, () => range.repoRoot());
  context.subscriptions.push(live, live.onDidChange((a) => cards.postActivity(a)));
  // Late, because the signal channel is created after the commands are: a batch queued while
  // Claude is working needs to know that it is, and the hook is the only thing that knows.
  deps.signals = signals;
  cards.queuedCount = () => batch.queuedIds().length;
  cards.queuedIds = () => batch.queuedIds();
  // The panel draws a held card differently, so it has to hear about it at once rather than on
  // the next poll — pressing send and watching nothing happen for thirty seconds is the bug.
  batch.onQueueChange(() => {
    cards.postNotes();
    void cards.postSession();
  });
  // Assigned once the session monitor below exists. A hook signal can only arrive from a
  // file watcher, so never during activation — but relying on that from fifty lines away is
  // not something a later edit should have to know.
  let wakeMonitor: () => void = () => undefined;
  const signalCounts = { touched: 0, ended: 0 };
  context.subscriptions.push(
    signals,
    signals.onDidTouch(() => {
      signalCounts.touched++;
      if (watcher.state === 'off') wakeMonitor();
      // Files changed, so the summary is stale — but the *base* is not. Re-resolving it
      // re-reads a transcript that the running session is actively appending to, which
      // measured 270-600ms, and a file being edited never moves the run boundary.
      range.invalidate(false);
    }),
    signals.onDidReport(() => {
      // The agent settled a note and said so. Answering it now is the difference between a
      // card that responds while you watch and one that sits on a change you can already see,
      // saying nothing, until the whole turn ends.
      batch.applyFiledSoFar().catch((err) => logger.trace(`incremental report failed: ${String(err)}`));
    }),
    signals.onDidStartRun(() => {
      // A new request: the boundary really has moved, and the panel should say so at once.
      range.invalidateBase();
      cards.postSession().catch((err) => logger.trace(`session post failed: ${String(err)}`));
    }),
    signals.onDidEndRun(() => {
      signalCounts.ended++;
      range.invalidateBase();
      cards.postSession().catch((err) => logger.trace(`session post failed: ${String(err)}`));
      // Deliberately not conditional on finding a session to send to. The hook's marker is
      // the record that a run happened here, and it is written the same whether the prompt
      // came from Redline or from someone typing in a Claude Code session in any terminal.
      //
      // Caught rather than voided: this runs from a file watcher, so a rejection has nowhere
      // to go and would surface as an extension error with no context about what caused it.
      // Also the moment a queued batch has been waiting for.
      batch
        .onHookRunFinished()
        // Its own catch: chained onto the same `.catch` below, a queue flush that threw was
        // reported as "could not report the finished run", and a flush that emptied the queue
        // and then failed to send left nothing in the log at all.
        .then(() => batch.flushQueued().catch((err) => logger.warn('could not send the queued notes', err)))
        .catch((err) => logger.warn('could not report the finished run', err));
    }),
  );
  const attachMonitor = async (): Promise<void> => {
    if (!config.watchSessions || watcher.state !== 'off') return;
    const target = await resolveTarget(context, logger, { interactive: false });
    if (!target) return;
    range.addCwdHint(target.cwd);
    if (target.orcaHandle) watcher.monitor(target);
  };
  /**
   * Look for a session to monitor, backing off while there is none.
   *
   * Each attempt spawns `ps` and the Orca CLI — about 345ms — and at a fixed minute that is
   * paid forever in every window, whether or not Claude is ever run. The hook signals when
   * the agent is actually working, which resets this to an immediate retry, so backing off
   * costs no responsiveness.
   */
  const MONITOR_MIN_MS = 60_000;
  const MONITOR_MAX_MS = 5 * 60_000;
  let monitorDelay = MONITOR_MIN_MS;
  let monitorTimer: NodeJS.Timeout | undefined;

  const scheduleMonitor = (): void => {
    if (monitorTimer) clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => {
      void (async () => {
        const before = watcher.state;
        await attachMonitor();
        // Nothing found again: wait longer. Attached, or newly so: back to the short cadence.
        monitorDelay =
          watcher.state === 'off' && before === 'off'
            ? Math.min(monitorDelay * 2, MONITOR_MAX_MS)
            : MONITOR_MIN_MS;
        scheduleMonitor();
      })();
    }, monitorDelay);
  };

  const monitorNow = (): void => {
    monitorDelay = MONITOR_MIN_MS;
    void attachMonitor();
    scheduleMonitor();
  };

  wakeMonitor = monitorNow;
  void attachMonitor();
  scheduleMonitor();
  context.subscriptions.push(
    { dispose: () => monitorTimer && clearTimeout(monitorTimer) },
    config.onDidChange(() => {
      if (!config.watchSessions) watcher.stop();
      else monitorNow();
    }),
  );

  const openCount = store.notes.filter(isOpen).length;
  if (openCount > 0) logger.info(`${openCount} open note(s) restored`);

  return {
    store,
    createNoteAt: (uri, r, body) => notes.createNoteAt(uri, r, body),
    panelReady: (timeoutMs = 10_000) =>
      Promise.race([
        cards.whenReady.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]),
    attachFile: (noteId, name, bytes) => attachments.add(noteId, name, bytes),
    attachPaths: (noteId, paths) => attachments.addFromPaths(noteId, paths),
    hookSignals: () => ({ ...signalCounts }),
    activationMs: () => activationCost,
    range,
    hookRuns: () => batch.hookRunsReported(),
    reportHookRun: () => batch.onHookRunFinished(),
  };
}

export async function deactivate(): Promise<void> {
}
