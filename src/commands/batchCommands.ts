import * as vscode from 'vscode';
import { AGENT_TURN_PREFIX, isOpen, ReviewNote } from '../model/note';
import { copyToClipboard, currentHashes, openPreview, renderNotes } from '../export/submit';
import { parseReport } from '../export/report';
import { pickTarget, readTarget, resolveTarget, sendBatchToClaude, SessionTarget, targetByKey } from '../claude/claudeSession';
import { ClaudeSessionInfo, findSessions, latestSessionAmong, recentAssistantText } from '../claude/transcripts';
import { readStopMarker } from '../claude/runTrees';
import { deliveryToken, stageForHandover } from '../claude/handover';
import { Deps, resolveNoteIdOrPick } from './deps';

/**
 * A run reported inside this window is the same run.
 *
 * Not the main defence — the Orca monitor confirms a finish about ten seconds after the
 * agent goes idle (`BUSY_CONFIRM_MS + FINISH_CONFIRM_MS`), which is exactly where a ten
 * second guard sits, so a duplicate slipped through by milliseconds. This is now the coarse
 * backstop; `HOOK_OWNS_REPORTING_MS` is what actually keeps the two channels apart.
 */
const RUN_REPORT_QUIET_MS = 20_000;

/**
 * While the plugin is reporting finishes, the idle monitor is not needed for it.
 *
 * The hook fires the moment the agent stops and works in any terminal; the monitor is a
 * poll that only works in Orca and confirms seconds later. When both are present the hook
 * owns it, and the monitor's notification is dropped rather than raced.
 */
const HOOK_OWNS_REPORTING_MS = 5 * 60_000;

/**
 * The same summary inside this window is the same run.
 *
 * Deliberately about the message rather than the channel: the two known reporters are guarded
 * against each other above, and this catches whatever produced a duplicate that those guards
 * did not anticipate. A genuine second run rarely changes nothing new, so the cost of being
 * wrong here is one missing toast, not a missing review.
 */
const SAME_REPORT_MS = 2 * 60_000;

export function batchCommands(deps: Deps) {
  const { store, config, logger, index, range, watcher } = deps;

  function summary(count: number, files: number): string {
    return `${count} note${count === 1 ? '' : 's'} across ${files} file${files === 1 ? '' : 's'}`;
  }

  // ── sending ──────────────────────────────────────────────────────────

  /**
   * The main action: render the open notes, put them on the clipboard, hand them to the
   * Claude Code session for this folder when one is reachable, and keep the notes visible
   * as "sent" so the round can be tracked.
   */
  async function submit(): Promise<void> {
    const open = store.notes.filter(isOpen);
    if (open.length === 0) {
      void vscode.window.showInformationMessage('Redline: no notes to send — add one first.');
      return;
    }
    // Rendering reads every referenced file and finding the session shells out to `ps` and
    // the Orca CLI, so this is where the wait is. Report it before the dialog appears.
    const prepared = await progress('finding the Claude Code session…', async () => ({
      text: await renderNotes(deps, store.notes),
      target: await resolveTarget(deps.context, logger),
    }));
    const text = prepared.text;
    const target = prepared.target;
    const fileCount = new Set(open.map((n) => n.path)).size;

    if (config.confirmOnSubmit) {
      const questions = open.filter((n) => n.kind === 'question').length;
      const shots = open.reduce((sum, n) => sum + (n.attachments?.length ?? 0), 0);
      const detail = [
        `${open.length - questions} change request${open.length - questions === 1 ? '' : 's'}`,
        questions ? `${questions} question${questions === 1 ? '' : 's'}` : '',
        shots ? `${shots} screenshot${shots === 1 ? '' : 's'}` : '',
        `${fileCount} file${fileCount === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join(' · ');
      const where = target
        ? `Sends to ${target.label} and copies to the clipboard.`
        : (await hookCanCollect())
          ? 'No session VS Code can type into. Stages the batch for the Claude Code plugin — you type one short word to deliver it.'
          : 'Copies to the clipboard (no Claude Code session found).';
      const choice = await vscode.window.showInformationMessage(
        `Send ${summary(open.length, fileCount)} to Claude Code?`,
        { modal: true, detail: `${detail}\n\n${where}` },
        'Send',
        'Preview first',
      );
      if (!choice) return;
      if (choice === 'Preview first') {
        await openPreview(text, config.outputTemplate === 'json' ? 'json' : 'markdown');
        const again = await vscode.window.showInformationMessage(
          `Send ${summary(open.length, fileCount)}?`,
          { modal: true },
          'Send',
        );
        if (again !== 'Send') return;
      }
    }

    await copyToClipboard(deps, text);
    // No terminal to type into, but the plugin can still collect the batch: it is staged where
    // the hook looks, and one short word typed into the session delivers the whole thing. This
    // is the only route for a Claude Code session running outside VS Code.
    const staged = target ? undefined : await stageForUnreachableSession(text);
    const result = await progress(target ? `sending to ${target.label}…` : 'copying…', async () =>
      target
        ? await sendBatchToClaude(text, deps.context, logger, { autoSubmit: config.claudeAutoSubmit, target })
        : undefined,
    );

    // Previous round rolls into the archive; this round becomes "sent".
    store.clearSent();
    const ids = open.map((n) => n.id);
    store.archiveCopy();
    store.markSent(ids, result?.ok ? result.target?.key : undefined, await currentHashes(open));
    for (const id of ids) index.clearChangedSinceSent(id);
    if (result?.ok && result.target) startWatch(result.target);

    // Staged for a session outside VS Code: the token is what the user has to type, so it goes
    // on the clipboard in place of the batch itself and the message says what to do with it.
    if (staged) {
      await vscode.env.clipboard.writeText(staged);
      void vscode.window
        .showInformationMessage(
          `Redline: ${summary(open.length, fileCount)} staged for Claude Code. ` +
            `Type \`${staged}\` in your session to deliver it.`,
          'Copy the word again',
        )
        .then(async (choice) => {
          if (choice === 'Copy the word again') await vscode.env.clipboard.writeText(staged);
        });
      return;
    }

    const tail = result?.ok ? ` ${result.message}` : result ? ` (${result.message})` : '';
    void vscode.window
      .showInformationMessage(`Copied ${summary(open.length, fileCount)} to the clipboard.${tail}`, 'Undo')
      .then((choice) => {
        if (choice === 'Undo') store.updateMany(ids.map((id) => ({ id, patch: { sent: undefined } })));
      });
  }

  /**
   * Run `fn` with a status-bar spinner.
   *
   * `ProgressLocation.Window` rather than a notification: several of these are wrapped
   * around work that then opens a modal confirmation, and a toast fighting a modal reads
   * as a glitch. The panel spins the clicked button at the same time.
   */
  function progress<T>(title: string, fn: () => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Redline: ${title}` },
      fn,
    ) as Promise<T>;
  }

  /**
   * The session a note belongs to.
   *
   * A note remembers where it was sent. That session holds the whole exchange, so a reply has
   * to go back to it rather than to whichever session happens to be preferred now — with two
   * sessions open, the old behaviour asked every single time and could drop a reply into a
   * session that had never seen the note.
   */
  async function targetForNote(note: ReviewNote): Promise<SessionTarget | undefined> {
    const key = note.sent?.target;
    if (!key) return undefined; // never sent: let the usual resolution choose
    const still = await targetByKey(key, logger);
    if (still) return still;
    logger.info(`the session #${note.seq} was sent to is gone; choosing another`);
    return undefined;
  }

  /** Send a single note (the ➤ button on a card). */
  async function sendSelected(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: nothing to send here.');
      return;
    }
    // `includeInactive`: a note that has already been sent, or been marked done, can be sent
    // again — that is what continuing a conversation about it means.
    const text = await renderNotes(deps, store.notes, { onlyIds: [note.id], includeInactive: true });
    await copyToClipboard(deps, text);

    // Back to the session this note is already talking to. The conversation — the note, the
    // answer, the reply — only exists in that one session's context, so sending a reply
    // anywhere else would arrive without any of it. Only when that session is gone does this
    // fall back to resolving one, which is also the only time a chooser should appear.
    const target = await targetForNote(note);
    const result = await progress(`sending #${note.seq} to ${target?.label ?? 'Claude Code'}…`, () =>
      sendBatchToClaude(text, deps.context, logger, {
        autoSubmit: config.claudeAutoSubmit,
        ...(target ? { target } : {}),
      }),
    );
    // A fresh send clears the previous verdict: the note is waiting on the agent again.
    store.update(note.id, { done: false });
    store.markSent([note.id], result.ok ? result.target?.key : undefined, await currentHashes([note]));
    index.clearChangedSinceSent(note.id);
    if (result.ok && result.target) startWatch(result.target);
    void vscode.window.showInformationMessage(
      result.ok ? `${result.message} #${note.seq} moved to "Sent to Claude".` : `Redline: ${result.message} Copied to the clipboard instead.`,
    );
  }

  async function previewBatch(): Promise<void> {
    if (store.notes.length === 0) {
      void vscode.window.showInformationMessage('Redline: no notes to preview.');
      return;
    }
    const text = await renderNotes(deps, store.notes);
    await openPreview(text, config.outputTemplate === 'json' ? 'json' : 'markdown');
  }

  async function copyNote(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: select a note to copy.');
      return;
    }
    const text = await renderNotes(deps, [note], { onlyIds: [note.id], includeInactive: true });
    if (await copyToClipboard(deps, text)) {
      void vscode.window.setStatusBarMessage(`Redline: #${note.seq} copied`, 2000);
    }
  }

  // ── the agent's answer ───────────────────────────────────────────────

  /**
   * Pull `#12 done / skipped / answer` lines from the terminal the batch was sent to
   * (falling back to the clipboard) and apply them to the sent notes.
   */
  async function applyReportFrom(target?: SessionTarget, quiet = false, sessionId?: string): Promise<number> {
    const sentNotes = store.notes.filter((n) => n.sent);
    if (sentNotes.length === 0) {
      if (!quiet) void vscode.window.showInformationMessage('Redline: no sent notes to update.');
      return 0;
    }
    let source = 'clipboard';
    let text = '';
    const key = target?.key ?? sentNotes.find((n) => n.sent?.target)?.sent?.target;
    const resolved =
      target ?? (key ? await targetByKey(key, logger) : await resolveTarget(deps.context, logger, { interactive: false }));

    // The session transcript first: it holds the agent's exact words. A terminal capture of
    // a TUI is mostly redraw frames, so the reply is usually not in it at all.
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    // The session the hook named, when it named one: with two sessions open in one folder,
    // "the most recently modified transcript" is a guess, and reading the wrong one would
    // attribute another session's answer to this run.
    const named = sessionId ? await namedSession(sessionId, [resolved?.cwd ?? '', ...folders]) : undefined;
    const session = named ?? (await latestSessionAmong([resolved?.cwd ?? '', ...folders]));
    if (session) {
      text = await recentAssistantText(session);
      if (text) source = 'the Claude Code transcript';
    }
    let items = parseReport(text);

    if (items.length === 0 && resolved) {
      text = (await readTarget(resolved, logger)) ?? '';
      items = parseReport(text);
      if (items.length > 0) source = resolved.label;
    }
    if (items.length === 0) {
      text = await vscode.env.clipboard.readText();
      items = parseReport(text);
      source = 'clipboard';
    }
    if (items.length === 0) {
      if (!quiet) {
        void vscode.window.showWarningMessage(
          'Redline: no `#12 done` / `#12 skipped — …` / `#12 answer: …` lines found in the Claude terminal or the clipboard.',
        );
      }
      return 0;
    }
    // Only sent notes may receive results: stale lines from earlier rounds must never
    // touch a note that was not part of a send.
    const bySeq = new Map(sentNotes.map((n) => [n.seq, n]));
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    for (const it of items) {
      const n = bySeq.get(it.seq);
      if (!n?.sent) continue;
      if (n.sent.outcome === it.outcome && (n.sent.reply ?? undefined) === it.text) continue;
      const next: NonNullable<ReviewNote['sent']> = { ...n.sent, outcome: it.outcome };
      if (it.text) next.reply = it.text;
      const patch: Partial<ReviewNote> = { sent: next };
      // Whatever it said goes into the conversation, whether it answered a question, made a
      // change, or declined one. A bare "done" beside changed code leaves nothing to read,
      // and the note is now a thread that stays on the line.
      if (it.text) {
        const addendum = `${AGENT_TURN_PREFIX} ${it.text}`;
        if (!n.addenda.includes(addendum)) patch.addenda = [...n.addenda, addendum];
      }
      if (it.outcome === 'done') patch.done = true;
      patches.push({ id: n.id, patch });
    }
    store.updateMany(patches);
    if (!quiet) {
      void vscode.window.showInformationMessage(
        `Redline: applied ${patches.length} result${patches.length === 1 ? '' : 's'} from ${source}.`,
      );
    }
    return patches.length;
  }

  async function applyReport(): Promise<void> {
    await progress("reading Claude's report…", () => applyReportFrom());
  }

  function clearSent(): void {
    const n = store.clearSent();
    void vscode.window.showInformationMessage(
      n ? `Redline: cleared ${n} sent note${n === 1 ? '' : 's'} (archived).` : 'Redline: no sent notes.',
    );
  }

  // ── watching the session ─────────────────────────────────────────────

  function startWatch(target: SessionTarget): void {
    if (!config.watchSessions) return;
    if (watcher.watch(target)) logger.info(`watching ${target.label} for idle`);
  }

  /** When a run was last reported, so several channels cannot each announce the same one. */
  let lastRunReport = 0;
  /** When the plugin last reported one, which takes the job off the idle monitor. */
  let lastHookReport = 0;
  /** The last thing actually shown, and when. Two identical summaries are one run. */
  let lastReportText = '';
  let lastReportTextAt = 0;

  /**
   * A run finished. Read the report, mark the notes, and say so exactly once.
   *
   * Every channel funnels through here — the hook's `Stop` signal, the Orca idle monitor,
   * and a batch we sent ourselves — because more than one of them usually notices the same
   * run and each used to raise its own notification.
   */
  async function reportRunFinished(
    target: SessionTarget | undefined,
    external: boolean,
    source: 'hook' | 'monitor' = 'monitor',
    sessionId?: string,
  ): Promise<void> {
    const now = Date.now();
    if (source === 'monitor' && now - lastHookReport < HOOK_OWNS_REPORTING_MS) {
      logger.trace('the plugin is reporting finishes here; ignoring the idle monitor');
      return;
    }
    if (now - lastRunReport < RUN_REPORT_QUIET_MS) {
      logger.trace('run already reported; skipping duplicate');
      return;
    }
    lastRunReport = now;
    if (source === 'hook') lastHookReport = now;

    // Applied without being asked: the report is the whole point of having sent the notes,
    // and clicking a command to ingest it is a step nobody wants to remember.
    const applied = await applyReportFrom(target, true, sessionId);

    // A note Claude reported as done has served its purpose. Skipped notes and answered
    // questions stay: those still need reading.
    let cleared: ReviewNote[] = [];
    if (applied > 0 && config.clearDoneAfterReport) {
      cleared = store.notes.filter((n) => n.sent?.outcome === 'done');
      if (cleared.length > 0) store.delete(cleared.map((n) => n.id));
    }

    range.invalidate(true);
    const s = await range.summary();

    const sentNotes = store.notes.filter((n) => n.sent);
    const done = sentNotes.filter((n) => n.sent?.outcome === 'done').length;
    const skipped = sentNotes.filter((n) => n.sent?.outcome === 'skipped').length;
    const answered = sentNotes.filter((n) => n.sent?.outcome === 'answered').length;
    const touched = sentNotes.filter((n) => index.changedSinceSent(n.id)).length;

    const notes = [
      cleared.length ? `${cleared.length} done, cleared` : '',
      done ? `${done} ✅` : '',
      skipped ? `${skipped} ⛔` : '',
      answered ? `${answered} 💬` : '',
      !applied && touched ? `${touched} note${touched === 1 ? '' : 's'} touched` : '',
    ].filter(Boolean);
    const changes = s && s.recentCount > 0 ? `${s.recentCount} file${s.recentCount === 1 ? '' : 's'} changed` : '';

    // Nothing to say: no report to apply and nothing changed.
    if (notes.length === 0 && !changes) {
      if (!external) void vscode.window.setStatusBarMessage(`Redline: ${target?.label ?? 'Claude'} finished`, 5000);
      return;
    }
    const summaryText = [notes.join(' · '), changes].filter(Boolean).join(' · ');

    // Last line of defence, and the one that does not depend on knowing which channel spoke:
    // the same summary twice in quick succession describes the same run, whatever produced it.
    if (summaryText === lastReportText && Date.now() - lastReportTextAt < SAME_REPORT_MS) {
      logger.info(`suppressed a repeat "${summaryText}" from ${source}`);
      return;
    }
    lastReportText = summaryText;
    lastReportTextAt = Date.now();
    logger.info(`run reported by ${source}: ${summaryText}`);
    const behaviour = config.onRunFinished;
    if (behaviour === 'nothing') return;

    // The panel is the display, so it is brought forward either way — the notification is
    // just what makes it noticeable when the panel is not the active view.
    if (changes && behaviour === 'open') {
      await reviewChanges();
      return;
    }

    const actions = [
      ...(changes ? ['Review changes'] : []),
      'Show notes',
      ...(cleared.length ? ['Undo clear'] : []),
    ];
    const removed = cleared;
    void vscode.window
      .showInformationMessage(`Claude finished — ${summaryText}.`, ...actions)
      .then(async (choice) => {
        if (choice === 'Review changes') await reviewChanges();
        else if (choice === 'Show notes') await vscode.commands.executeCommand('redline.focusPanel');
        else if (choice === 'Undo clear') store.reinstate(removed);
      });
  }

  /** The run the hook last reported here, so the same one is never announced twice. */
  let lastRunSeen = '';
  /** Runs accepted from the hook — asserted by the tests, since a notification is not. */
  let runsReported = 0;

  /**
   * A run finished, according to the hook.
   *
   * This is the path that works when the prompt did not come from Redline: someone typing in a
   * Claude Code session — in a VS Code terminal, in iTerm, in tmux, anywhere — produces the
   * same stop marker, and it carries the run's own timestamp and session id. Nothing here
   * needs the session to be *reachable*: that is only required to push notes into it, and
   * requiring it meant a run outside VS Code's own terminals was never reported at all.
   *
   * The marker's timestamp identifies the run, which is a better guard than any time window:
   * the hook writes state for every repository under one directory, so a run finishing in
   * another worktree is a signal here too, and its marker is not ours.
   */
  async function onHookRunFinished(): Promise<void> {
    const root = await range.repoRoot();
    if (!root) return;
    const marker = await readStopMarker(root);
    if (!marker) {
      // A hook too old to record one. Fall back to the session-shaped path.
      const target = await resolveTarget(deps.context, logger, { interactive: false });
      if (target) await reportRunFinished(target, true, 'hook');
      return;
    }
    if (marker.at === lastRunSeen) {
      logger.trace(`run ${marker.at} already reported`);
      return;
    }
    lastRunSeen = marker.at;
    runsReported++;
    // Only to read the terminal as a last-resort source for the report; its absence is fine.
    const target = await resolveTarget(deps.context, logger, { interactive: false });
    logger.info(
      `hook reported a finished run at ${marker.at}` +
        `${marker.session ? ` in session ${marker.session.slice(0, 8)}` : ''}` +
        `${target ? ` (${target.label})` : ' (no reachable session — reporting anyway)'}`,
    );
    await reportRunFinished(target, true, 'hook', marker.session || undefined);
  }

  async function onAgentFinished(target: SessionTarget): Promise<void> {
    await reportRunFinished(target, false);
  }

  async function onExternalRunFinished(target: SessionTarget, source: 'hook' | 'monitor' = 'monitor'): Promise<void> {
    await reportRunFinished(target, true, source);
  }

  /**
   * Stage a batch for a session VS Code cannot reach, and return the word that fetches it.
   *
   * Typing into a terminal needs a terminal; the plugin's `UserPromptSubmit` hook needs
   * nothing but a file. So the batch is written where the hook looks and the token goes on the
   * clipboard: paste it into the session and the hook injects the whole review. Without this,
   * a Claude Code session in iTerm or tmux could only be reviewed by pasting several kilobytes
   * of prompt by hand — which is the failure the plugin exists to remove.
   */
  /** Whether the plugin is live here, so a batch can be staged for a session we cannot type into. */
  async function hookCanCollect(): Promise<boolean> {
    const root = await range.repoRoot();
    return root ? (await deliveryToken(root)) !== undefined : false;
  }

  async function stageForUnreachableSession(text: string): Promise<string | undefined> {
    const root = await range.repoRoot();
    if (!root) return undefined;
    const token = await deliveryToken(root);
    if (!token) return undefined;
    try {
      await stageForHandover(root, text.trimEnd());
      logger.info(`staged ${text.length} chars for a session outside VS Code; the token is "${token}"`);
      return token;
    } catch (err) {
      logger.warn('could not stage the batch for the plugin', err);
      return undefined;
    }
  }

  /** The transcript for a session id, looked for in the directories it could belong to. */
  async function namedSession(
    sessionId: string,
    cwds: readonly string[],
  ): Promise<ClaudeSessionInfo | undefined> {
    for (const cwd of cwds) {
      if (!cwd) continue;
      const found = (await findSessions(cwd)).find((s) => s.sessionId === sessionId);
      if (found) return found;
    }
    return undefined;
  }

  async function pickSession(): Promise<void> {
    const t = await pickTarget(deps.context, logger);
    if (t) {
      void vscode.window.setStatusBarMessage(`Redline: notes now go to ${t.label}`, 3000);
      if (config.watchSessions) watcher.monitor(t);
    }
  }

  // ── reviewing changes ────────────────────────────────────────────────

  /**
   * PR-style multi-file diff. By default it shows the latest burst of edits — the work you
   * just want to re-read — with everything else one command away.
   */
  async function openChanges(scope: 'recent' | 'all'): Promise<void> {
    return progress(scope === 'recent' ? 'collecting the last run…' : 'collecting every change…', () =>
      openChangesInner(scope),
    );
  }

  async function openChangesInner(scope: 'recent' | 'all'): Promise<void> {
    // Marked stale, not forced: a hook signal has usually just refreshed this, and the
    // recompute floor decides. Forcing meant every click paid for a full rebuild.
    range.invalidate(false);
    const s = await range.summary();
    if (!s) {
      void vscode.window.showInformationMessage('Redline: this folder is not a git repository.');
      return;
    }
    const count = scope === 'recent' ? s.recentCount : s.fileCount;
    if (count === 0) {
      void vscode.window.showInformationMessage(`Redline: nothing changed ${s.label}.`);
      return;
    }
    const files = `${count} file${count === 1 ? '' : 's'}`;
    const title = scope === 'recent' ? `Latest changes — ${files} ${s.recentLabel}` : `All changes — ${files} ${s.label}`;
    await vscode.commands.executeCommand('vscode.changes', title, await range.diffResources(scope));
    if (scope === 'recent' && s.olderCount > 0) {
      void vscode.window
        .showInformationMessage(
          `Showing the last run. ${s.olderCount} more changed file${s.olderCount === 1 ? '' : 's'} ${s.label}.`,
          'Show all changes',
        )
        .then((choice) => {
          if (choice === 'Show all changes') void openChanges('all');
        });
    }
  }

  const reviewChanges = (): Promise<void> => openChanges('recent');
  const reviewAllChanges = (): Promise<void> => openChanges('all');

  async function nextChange(): Promise<void> {
    if (!(await range.walk(1))) {
      const s = await range.summary();
      void vscode.window.showInformationMessage(`Redline: nothing changed ${s?.label ?? 'to review'}.`);
    }
  }

  async function prevChange(): Promise<void> {
    if (!(await range.walk(-1))) {
      const s = await range.summary();
      void vscode.window.showInformationMessage(`Redline: nothing changed ${s?.label ?? 'to review'}.`);
    }
  }

  async function markBaseline(): Promise<void> {
    const ok = await range.markNow('manual');
    void vscode.window.showInformationMessage(
      ok
        ? 'Redline: baseline pinned here — "Review changes" now shows everything after this point.'
        : 'Redline: could not pin a baseline (is this a git repository?).',
    );
  }

  async function clearBaseline(): Promise<void> {
    range.clearBaseline();
    const s = await range.summary();
    void vscode.window.showInformationMessage(
      `Redline: baseline cleared — reviewing changes ${s?.label ?? 'since the last commit'}.`,
    );
  }

  // ── batch housekeeping ───────────────────────────────────────────────

  async function clearAll(): Promise<void> {
    const n = store.notes.length;
    if (n === 0) {
      void vscode.window.showInformationMessage('Redline: nothing to clear.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Clear all ${n} note${n === 1 ? '' : 's'}?`,
      { modal: true, detail: 'They are archived first — "Restore Last Submitted Batch" brings them back.' },
      'Clear',
    );
    if (choice !== 'Clear') return;
    store.archiveActive();
    void vscode.window.showInformationMessage(`Cleared ${n} note${n === 1 ? '' : 's'}.`, 'Undo').then((undo) => {
      if (undo === 'Undo') restoreLastBatch();
    });
  }

  function restoreLastBatch(): void {
    if (!store.hasArchive) {
      void vscode.window.showInformationMessage('Redline: no archived batch to restore.');
      return;
    }
    const batch = store.restore();
    if (batch) void vscode.window.setStatusBarMessage(`Redline: restored ${batch.notes.length} note(s)`, 3000);
  }

  function refresh(): void {
    range.invalidate(true);
    index.refresh();
  }

  function showLog(): void {
    logger.show();
  }

  return {
    submit,
    sendSelected,
    previewBatch,
    copyNote,
    applyReport,
    clearSent,
    clearAll,
    restoreLastBatch,
    pickSession,
    reviewChanges,
    reviewAllChanges,
    nextChange,
    prevChange,
    markBaseline,
    clearBaseline,
    refresh,
    showLog,
    onAgentFinished,
    onExternalRunFinished,
    onHookRunFinished,
    hookRunsReported: (): number => runsReported,
  };
}
