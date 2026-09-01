import * as vscode from 'vscode';
import { agentTurnThisRound, AGENT_TURN_PREFIX, hasUnsentReply, isOpen, ReviewNote } from '../model/note';
import { copyToClipboard, currentHashes, openPreview, renderNotes } from '../export/submit';
import { parseReport, ReportItem } from '../export/report';
import { discardReport, readReport, takeReport } from '../claude/reportFile';
import { pickTarget, readTarget, resolveTarget, sendBatchToClaude, SessionTarget, targetByKey } from '../claude/claudeSession';
import { ClaudeSessionInfo, findSessions, latestSessionAmong, recentAssistantText } from '../claude/transcripts';
import { readStopMarker } from '../claude/runTrees';
import { deliveryToken, stageForHandover } from '../claude/handover';
import { Deps, resolveNoteIdOrPick } from './deps';
import { SendQueue } from './sendQueue';
import { serialiser } from './serialise';

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

  /** "14:22" for something today, a date for anything older. */
  function shortWhen(iso: string): string {
    const at = new Date(iso);
    const today = new Date().toDateString() === at.toDateString();
    return today
      ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function summary(count: number, files: number): string {
    return `${count} note${count === 1 ? '' : 's'} across ${files} file${files === 1 ? '' : 's'}`;
  }

  // ── sending ──────────────────────────────────────────────────────────

  /**
   * The main action: render the open notes, put them on the clipboard, hand them to the
   * Claude Code session for this folder when one is reachable, and keep the notes visible
   * as "sent" so the round can be tracked.
   */
  /**
   * A batch waiting for the agent to finish what it is doing.
   *
   * Sending into a run that is already going means the notes land in the middle of a turn,
   * where they are as likely to be ignored as read. Holding them costs nothing and the moment
   * to send is one we already know about — the hook tells us when a run ends.
   */
  /** One send at a time — see `serialiser` for why. */
  const oneAtATime = serialiser();

  /** How often to check whether the agent has gone quiet, while anything is waiting. */
  const QUIET_POLL_MS = 15_000;

  /** The panel draws a held card differently, so it has to be told the moment one is held. */
  let notifyQueue: () => void = () => undefined;
  const queued = new SendQueue(() => notifyQueue());

  /** Called when a run ends: send what was held, if anything. */
  async function flushQueued(): Promise<void> {
    const ids = queued.take((id) => !!store.getById(id));
    if (ids.length === 0) return;
    void vscode.window.setStatusBarMessage(
      `Redline: Claude is free — sending ${ids.length} note${ids.length === 1 ? '' : 's'}`,
      4000,
    );
    // One message for all of them, however many separate sends put them here: they are one
    // round from the agent's point of view, and it can read them together.
    await submit({ queueIfBusy: false, onlyIds: ids });
  }

  /**
   * Stop waiting — for one note, or for all of them.
   *
   * The card's own Cancel used to call off the whole queue while its tooltip said "do not send
   * *it*", which is a lie about scope when three cards are waiting and you meant one.
   */
  function cancelQueued(arg?: unknown): void {
    const id = typeof arg === 'string' && queued.has(arg) ? arg : undefined;
    if (id) {
      queued.drop([id]);
      const note = store.getById(id);
      void vscode.window.setStatusBarMessage(
        `Redline: ${note ? `#${note.seq}` : 'that note'} will not be sent automatically`,
        4000,
      );
      return;
    }
    if (!queued.cancel()) {
      void vscode.window.showInformationMessage('Redline: nothing is waiting to be sent.');
      return;
    }
    void vscode.window.setStatusBarMessage('Redline: the notes will not be sent automatically', 4000);
  }

  function hold(ids: readonly string[], why: string): void {
    queued.hold(ids);
    void vscode.window.setStatusBarMessage(`Redline: ${why}`, 6000);
    watchForQuiet();
  }

  /**
   * A second way out of the queue, for when the first one does not come.
   *
   * The flush is normally driven by the hook saying a run ended. If that signal is missed — a
   * crashed agent, a killed terminal, a hook that did not run — nothing else was watching, and
   * the notes sat in the queue for the life of the window with no sign that they were stuck.
   * `running` goes false on its own after `MAX_RUN_MS` whatever happens, so polling it while
   * something is actually waiting closes the gap. The timer exists only while the queue does.
   */
  let quietTimer: NodeJS.Timeout | undefined;

  function watchForQuiet(): void {
    if (quietTimer) return;
    quietTimer = setInterval(() => {
      if (queued.size === 0) {
        clearInterval(quietTimer);
        quietTimer = undefined;
        return;
      }
      if (deps.signals?.running === true) return;
      clearInterval(quietTimer);
      quietTimer = undefined;
      void flushQueued();
    }, QUIET_POLL_MS);
  }

  /**
   * Throw away a report from the last round, because this one is starting.
   *
   * Nothing implemented this, so the file could outlive the round that produced it: an
   * unreadable report is left on disk deliberately, and an agent that is interrupted never
   * finishes writing one. Its seqs are this repo's seqs, so *Apply Claude's report* during the
   * next round stamped the previous round's outcomes onto the notes just sent.
   */
  async function clearStaleReport(): Promise<void> {
    const root = await range.repoRoot();
    if (root) await discardReport(root);
  }

  /** What a note looked like when its batch was rendered, for `reconcileSend`. */
  interface AtRender {
    target?: string;
    addenda: number;
  }

  const atRender = (n: ReviewNote): AtRender => {
    const snapshot: AtRender = { addenda: n.addenda.length };
    if (n.sent?.target) snapshot.target = n.sent.target;
    return snapshot;
  };

  /**
   * Two things about a send that `markSent` cannot know, put back after it.
   *
   * It writes a fresh `sent` out of the note as it stands at that moment, and that is wrong
   * twice over:
   *
   *   - a send that failed carries no target, so a re-send that timed out dropped the session
   *     the note already lives in — and the next follow-up went to another session, which has
   *     never seen the note. That is exactly what `targetForNote` exists to prevent;
   *   - `addenda.length` is read seconds after the text was rendered, with a session probe, a
   *     clipboard round-trip and the send itself in between. A follow-up typed in that window
   *     was marked as seen by Claude, so it was never sent and nothing said so.
   */
  function reconcileSend(ids: readonly string[], before: ReadonlyMap<string, AtRender>): void {
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    for (const id of ids) {
      const n = store.getById(id);
      const was = before.get(id);
      if (!n?.sent || !was) continue;
      const sent = { ...n.sent };
      let changed = false;
      if (!sent.target && was.target) {
        sent.target = was.target;
        changed = true;
      }
      if (sent.addendaAtSend !== was.addenda) {
        sent.addendaAtSend = was.addenda;
        changed = true;
      }
      if (changed) patches.push({ id, patch: { sent } });
    }
    if (patches.length > 0) store.updateMany(patches);
  }

  function submit(opts: { queueIfBusy?: boolean; onlyIds?: readonly string[] } = {}): Promise<void> {
    return oneAtATime(() => submitNow(opts));
  }

  async function submitNow(opts: { queueIfBusy?: boolean; onlyIds?: readonly string[] } = {}): Promise<void> {
    const open = store.notes.filter(isOpen);
    // Follow-ups written on notes that have already been answered. Sending a round, reading
    // the answers and replying to several of them is the ordinary way this gets used, and
    // there was no way to send that second round in one go — only note by note.
    const replies = store.notes.filter(hasUnsentReply);
    // `onlyIds` is what a flush sends: exactly the notes that were queued, rather than
    // whatever happens to qualify by the time the agent goes quiet.
    const only = opts.onlyIds ? new Set(opts.onlyIds) : undefined;
    const batch = (only ? store.notes.filter((n) => only.has(n.id)) : [...open, ...replies]);
    if (batch.length === 0) {
      void vscode.window.showInformationMessage('Redline: no notes to send — add one first.');
      return;
    }
    // Busy: hold the batch rather than dropping it into the middle of a turn, where it is as
    // likely to be ignored as read.
    if (opts.queueIfBusy !== false && deps.signals?.running === true) {
      const choice = await vscode.window.showInformationMessage(
        `Redline: Claude is working. Send ${batch.length} note${batch.length === 1 ? '' : 's'} when it finishes?`,
        'Send when free',
        'Send now',
      );
      if (!choice) return;
      if (choice === 'Send when free') {
        hold(batch.map((n) => n.id), 'queued — will send when Claude finishes');
        return;
      }
    }
    const ids = batch.map((n) => n.id);
    // Claimed. A held note carries no mark of its own, so it is still an ordinary unsent note
    // to everything else here — including this batch, which would take it and leave the flush
    // to send it again a moment later.
    queued.drop(ids);
    // What Undo has to restore. A note being sent *again* was already sent, and clearing its
    // record would drop it out of the sent section along with its outcome, its session and the
    // point its thread had reached.
    const wasSent = new Map(batch.map((n) => [n.id, n.sent]));
    // Taken *before* the batch is rendered, not after the send — see `reconcileSend`.
    const before = new Map(batch.map((n) => [n.id, atRender(n)]));
    // Rendering reads every referenced file and finding the session shells out to `ps` and
    // the Orca CLI, so this is where the wait is. Report it before the dialog appears.
    const prepared = await progress('finding the Claude Code session…', async () => ({
      // `includeInactive`, and named explicitly: a note that has been answered is not open,
      // and the reply needs the whole thread — the note, the answer and the follow-up — or it
      // arrives with no idea what it is replying to.
      text: await renderNotes(deps, store.notes, { onlyIds: ids, includeInactive: true }),
      target: await targetForBatch(replies),
    }));
    const text = prepared.text;
    const target = prepared.target;
    const fileCount = new Set(batch.map((n) => n.path)).size;

    if (config.confirmOnSubmit) {
      // Everything counted here is the batch, not the store. Flushing one queued note while
      // six others sat open counted all seven: "Send 1 note across 1 file?" over a detail line
      // reading "5 change requests · 1 question · 3 files".
      const replying = new Set(replies.map((n) => n.id));
      const fresh = batch.filter((n) => !replying.has(n.id));
      const questions = fresh.filter((n) => n.kind === 'question').length;
      const shots = batch.reduce((sum, n) => sum + (n.attachments?.length ?? 0), 0);
      const requests = fresh.length - questions;
      const follows = batch.length - fresh.length;
      const detail = [
        requests ? `${requests} change request${requests === 1 ? '' : 's'}` : '',
        questions ? `${questions} question${questions === 1 ? '' : 's'}` : '',
        follows ? `${follows} follow-up${follows === 1 ? '' : 's'}` : '',
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
        `Send ${summary(batch.length, fileCount)} to Claude Code?`,
        { modal: true, detail: `${detail}\n\n${where}` },
        'Send',
        'Preview first',
      );
      if (!choice) return;
      if (choice === 'Preview first') {
        await openPreview(text, config.outputTemplate === 'json' ? 'json' : 'markdown');
        const again = await vscode.window.showInformationMessage(
          `Send ${summary(batch.length, fileCount)}?`,
          { modal: true },
          'Send',
        );
        if (again !== 'Send') return;
      }
    }

    // A round starts with no report on disk. `applyReportFrom` leaves an unreadable one where
    // it is on purpose, and an agent that is interrupted never finishes the write — so round
    // one's outcomes would still be sitting there for round two's notes, same seqs, same repo
    // root, to be stamped with by the next *Apply Claude's report*.
    await clearStaleReport();

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

    // Previous round rolls into the archive; this round becomes "sent". The notes being sent
    // again are held back from that: archiving a note mid-thread would delete the very thing
    // its follow-up is attached to.
    store.clearSent(ids);
    store.archiveCopy();
    // A fresh send clears the previous verdict — the note is waiting on the agent again.
    for (const n of replies) store.update(n.id, { done: false });
    store.markSent(
      ids,
      result?.ok ? result.target?.key : undefined,
      await currentHashes(batch),
      // Staged for a session Redline cannot type into, or only on the clipboard: either way
      // the agent has not seen it, and the cards must say so rather than claim it is working.
      staged ? 'staged' : result?.ok ? undefined : 'clipboard',
    );
    reconcileSend(ids, before);
    for (const id of ids) index.clearSentSignals(id);
    if (result?.ok && result.target) startWatch(result.target);

    // Staged for a session outside VS Code: the token is what the user has to type, so it goes
    // on the clipboard in place of the batch itself and the message says what to do with it.
    if (staged) {
      await vscode.env.clipboard.writeText(staged);
      void vscode.window
        .showInformationMessage(
          `Redline: ${summary(batch.length, fileCount)} staged for Claude Code. ` +
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
      .showInformationMessage(`Copied ${summary(batch.length, fileCount)} to the clipboard.${tail}`, 'Undo')
      .then((choice) => {
        if (choice === 'Undo') {
          store.updateMany(ids.map((id) => ({ id, patch: { sent: wasSent.get(id) } })));
        }
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

  /**
   * The session a batch should go to.
   *
   * A follow-up only makes sense in the session that holds the conversation, so when every
   * note being replied to names the same one, that session is used and no chooser appears.
   * A batch spanning two sessions, or one with nothing to go on, resolves as usual.
   */
  async function targetForBatch(replies: readonly ReviewNote[]): Promise<SessionTarget | undefined> {
    const keys = new Set(replies.map((n) => n.sent?.target).filter((k): k is string => !!k));
    const only = keys.size === 1 ? [...keys][0] : undefined;
    const bound = only ? await targetByKey(only, logger) : undefined;
    if (bound) return bound;
    if (only) logger.info('the session these notes are talking to is gone; choosing another');
    return resolveTarget(deps.context, logger);
  }

  /** Send a single note — the card's own *Send to Claude* / *Send your reply*. */
  function sendSelected(arg: unknown): Promise<void> {
    return oneAtATime(() => sendSelectedNow(arg));
  }

  async function sendSelectedNow(arg: unknown): Promise<void> {
    const id = resolveNoteIdOrPick(deps, arg);
    const note = id ? store.getById(id) : undefined;
    if (!note) {
      void vscode.window.showInformationMessage('Redline: nothing to send here.');
      return;
    }
    /*
     * Held while the agent is working, exactly as a whole batch is.
     *
     * This path went straight into the session whatever it was doing — so replying to one card
     * and then to a second before the first was answered typed the second into the middle of a
     * turn, where it is as likely to be ignored as read. That is the case this queue was built
     * for and the one place that was not using it.
     *
     * No question here, unlike a batch: this is one card, it is a common thing to do while the
     * agent works, and a modal for each one would be worse than the wait. The card says it is
     * holding, and the session card offers to cancel.
     */
    if (deps.signals?.running === true) {
      hold([note.id], `#${note.seq} queued — it goes when Claude finishes`);
      return;
    }
    queued.drop([note.id]);
    // Taken before rendering, not after the send — see `reconcileSend`.
    const before = new Map([[note.id, atRender(note)]]);
    // `includeInactive`: a note that has already been sent, or been marked done, can be sent
    // again — that is what continuing a conversation about it means.
    const text = await renderNotes(deps, store.notes, { onlyIds: [note.id], includeInactive: true });
    // A round starts with no report on disk: an unapplied one from the last round names the
    // same seqs under the same repo root, and would be applied to this one.
    await clearStaleReport();
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
    store.markSent(
      [note.id],
      result.ok ? result.target?.key : undefined,
      await currentHashes([note]),
      // Nobody has read it unless it went into a session. The card said "Waiting for Claude…"
      // over a batch that had only reached the clipboard.
      result.ok ? undefined : 'clipboard',
    );
    reconcileSend([note.id], before);
    index.clearSentSignals(note.id);
    if (result.ok && result.target) startWatch(result.target);
    void vscode.window.showInformationMessage(
      // `result.message` already says where it went, both ways round. Appending "Copied to the
      // clipboard instead." to a sentence ending "— the notes are on the clipboard." said it
      // twice in one breath.
      result.ok ? `${result.message} #${note.seq} is now waiting on Claude.` : `Redline: ${result.message}`,
    );
  }

  async function previewBatch(): Promise<void> {
    // The same set `submit` would send, follow-ups included. Rendering only the open notes
    // showed an empty preview whenever a second round was the thing being prepared.
    const batch = [...store.notes.filter(isOpen), ...store.notes.filter(hasUnsentReply)];
    if (batch.length === 0) {
      void vscode.window.showInformationMessage('Redline: no notes to preview.');
      return;
    }
    const text = await renderNotes(deps, store.notes, {
      onlyIds: batch.map((n) => n.id),
      includeInactive: true,
    });
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

  /** What an apply did: notes actually changed, and outcomes that named a note still here. */
  interface Applied {
    patched: number;
    matched: number;
  }

  /**
   * Pull `#12 done / skipped / answer` lines from the terminal the batch was sent to
   * (falling back to the clipboard) and apply them to the sent notes.
   */
  async function applyReportFrom(target?: SessionTarget, quiet = false, sessionId?: string): Promise<number> {
    const sentNotes = store.notes.filter((n) => n.sent);
    // The report file first: a run that wrote one has said exactly what happened, with no
    // prose to interpret. Everything below is the fallback for a run that did not.
    //
    // Read before the "nothing to update" exit, not after. Clear the sent round while Claude
    // is still working and the report it writes afterwards sits on disk for ever, so the next
    // round opens on top of a stale one.
    const root = await range.repoRoot();
    let filed: Awaited<ReturnType<typeof takeReport>>;
    try {
      filed = root ? await takeReport(root) : undefined;
    } catch (err) {
      // Left on disk on purpose. Say so and carry on to the prose fallback: the terminal may
      // already hold the same answers, and a report that never finishes writing must not be
      // the reason nothing is applied.
      logger.warn('report unreadable, left in place', err);
      filed = undefined;
      if (!quiet) {
        void vscode.window.showWarningMessage(
          "Redline: Claude's report was still being written — reading the reply instead. Apply again in a moment for the full one.",
        );
      }
    }
    if (sentNotes.length === 0) {
      if (!quiet) void vscode.window.showInformationMessage('Redline: no sent notes to update.');
      return 0;
    }
    if (filed) {
      const applied = applyItems(filed, sentNotes, quiet, "Claude's report");
      // `matched`, not `patched`. Everything in the file may well have been applied already —
      // it is read all through the run — and there is then nothing left to patch. Falling
      // through to the transcript on that let its paraphrase of the same answer replace the
      // one the report gave, since this round's turn is replaced rather than appended: the
      // card's answer silently reworded after the run, credited to the transcript.
      if (applied.matched > 0) return applied.patched || applied.matched;
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
    const applied = applyItems(items, sentNotes, quiet, source);
    return applied.patched || applied.matched;
  }

  /**
   * Apply outcomes to the notes they name.
   *
   * Only sent notes may receive results: a stale line from an earlier round must never touch a
   * note that was not part of a send.
   *
   * `matched` is kept apart from `patched` because "the report was read and it named notes
   * that are still here" is not the same thing as "notes changed". A report applied live while
   * the run was going leaves nothing to patch at the end of it — which is a report answered,
   * not a report missing.
   */
  function applyItems(
    items: readonly ReportItem[],
    sentNotes: readonly ReviewNote[],
    quiet: boolean,
    source: string,
  ): Applied {
    /*
     * The caller's list decides *which* notes may receive a result — only ones that were sent.
     * What each note currently says is read here, fresh.
     *
     * The list is gathered before reading the report, and reading it is file I/O; a follow-up
     * typed in that window went into the store, and then a patch built from the older copy
     * replaced `addenda` wholesale and took it back out again — with no error and no trace.
     */
    const eligible = new Map(sentNotes.map((n) => [n.seq, n.id]));
    const patches: Array<{ id: string; patch: Partial<ReviewNote> }> = [];
    // Answers to notes that are no longer here — deleted, or cleared between the send and the
    // report. Counted rather than skipped in silence: "nothing was found" is the wrong story
    // to tell about a report that named three notes you had just removed.
    let strangers = 0;
    // Outcomes that named a note that is still here, whether or not they changed anything.
    let matched = 0;
    for (const it of items) {
      const id = eligible.get(it.seq);
      const n = id ? store.getById(id) : undefined;
      if (!n?.sent) {
        strangers += 1;
        continue;
      }
      matched += 1;
      const addendum = it.text ? `${AGENT_TURN_PREFIX} ${it.text}` : undefined;
      const mine = agentTurnThisRound(n);
      // Already recorded — outcome, reply *and* this round's turn in the conversation. Reading
      // only the first two skipped an identical answer in a later round, which left the card
      // showing round one's turn, and under-counted `applied`, which is what gates
      // `clearDoneAfterReport`.
      const inThread = !addendum || (mine >= 0 && n.addenda[mine] === addendum);
      if (n.sent.outcome === it.outcome && (n.sent.reply ?? undefined) === it.text && inThread) continue;
      const next: NonNullable<ReviewNote['sent']> = { ...n.sent, outcome: it.outcome };
      if (it.text) next.reply = it.text;
      // A fresh answer ends the rejection: this is the next attempt, and it is waiting on a
      // reader again rather than on Claude.
      const patch: Partial<ReviewNote> = { sent: next, rejected: undefined };
      /*
       * Whatever it said goes into the conversation, whether it answered a question, made a
       * change, or declined one. A bare "done" beside changed code leaves nothing to read.
       *
       * One turn per round, replaced rather than appended. The report is now read while the
       * run is still going, so the same note is answered several times as the agent refines
       * what it wrote — and appending each version left the card showing the answer twice,
       * in slightly different words. A turn added since the last send belongs to this round
       * and is this round's answer; anything before it is the record of an earlier one.
       */
      if (addendum) {
        if (mine >= 0) {
          if (n.addenda[mine] !== addendum) {
            patch.addenda = n.addenda.map((turn, at) => (at === mine ? addendum : turn));
          }
          // Scoped to this round, as `agentTurnThisRound` is. Searching the whole thread threw
          // away a round-two answer whose wording happened to match round one's, and the card
          // went on showing round one.
        } else if (!n.addenda.slice(n.sent.addendaAtSend ?? n.addenda.length).includes(addendum)) {
          patch.addenda = [...n.addenda, addendum];
        }
      }
      // Deliberately *not* marking the note done. Claude saying it is finished is a claim
      // about the code, and the note is now waiting for someone to look at the change and
      // agree — which is the point of a review. Approving is what closes it.
      patches.push({ id: n.id, patch });
    }
    store.updateMany(patches);
    if (!quiet && patches.length > 0) {
      const missed = strangers > 0 ? ` ${strangers} answered a note that is no longer here.` : '';
      void vscode.window.showInformationMessage(
        `Redline: applied ${patches.length} result${patches.length === 1 ? '' : 's'} from ${source}.${missed}`,
      );
    } else if (!quiet && strangers > 0) {
      void vscode.window.showInformationMessage(
        `Redline: ${source} answered ${strangers} note${strangers === 1 ? '' : 's'} that ${strangers === 1 ? 'is' : 'are'} no longer here.`,
      );
    }
    return { patched: patches.length, matched };
  }

  async function applyReport(): Promise<void> {
    await progress("reading Claude's report…", () => applyReportFrom());
  }

  /**
   * Apply what the agent has settled so far, without consuming the file.
   *
   * The report used to arrive once, at the end of the turn — so a note whose code you could
   * already see change sat saying nothing until the whole run finished, which on a batch of a
   * dozen is a long time to watch a card that knows something happened. The agent is asked to
   * write the file again each time it settles a note, and this reads it as it lands.
   *
   * Never consumes it: the run is still going and everything after this is still to come. The
   * end-of-run path takes and clears it as before, and applying the same outcome twice is a
   * no-op, so the two cannot fight.
   */
  async function applyFiledSoFar(): Promise<void> {
    const sentNotes = store.notes.filter((n) => n.sent);
    if (sentNotes.length === 0) return;
    const root = await range.repoRoot();
    if (!root) return;
    try {
      const filed = await readReport(root);
      if (filed) applyItems(filed, sentNotes, true, "Claude's report");
    } catch {
      // Caught mid-write. The next write fires this again, and the end of the run is a
      // backstop either way — there is nothing worth saying about it here.
    }
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
      // Notes *you* approved, not ones Claude declared finished: those are waiting to be
      // looked at, and clearing them would throw away the review before it happened.
      cleared = store.notes.filter((n) => n.done && n.sent);
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

    if (changes && behaviour === 'open') {
      await reviewChanges();
      return;
    }

    // Quieter than a notification and less intrusive than taking over the editor: the panel
    // comes forward with the new figures, and the summary goes to the status bar where it can
    // be ignored.
    if (behaviour === 'reveal') {
      await vscode.commands.executeCommand('redline.focusPanel');
      void vscode.window.setStatusBarMessage(`Redline: Claude finished — ${summaryText}`, 10_000);
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
      const staged = await stageForHandover(root, text.trimEnd());
      if (staged === 'occupied') {
        // Someone else's batch is still waiting to be collected — a second window on this repo,
        // or a send whose token was never typed. Overwriting it would lose a review nobody has
        // read, and both cards would go on saying "Staged". The clipboard still has this one.
        logger.warn('a staged batch is already waiting to be collected here; not replacing it');
        void vscode.window.showWarningMessage(
          'Redline: a batch is already staged here and has not been collected. This one is on your clipboard instead.',
        );
        return undefined;
      }
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
      // Three different reasons, and calling all of them "not a git repository" sent people
      // looking for a problem with their repository. An untrusted folder is the one that is
      // both common and fixable from here — nothing git-related runs until it is trusted,
      // because a repository's own configuration and filters are code that git will execute.
      if (!vscode.workspace.isTrusted) {
        const choice = await vscode.window.showInformationMessage(
          'Redline: this folder is not trusted, so nothing can be read from git. Notes still work.',
          'Manage Trust',
        );
        if (choice) await vscode.commands.executeCommand('workbench.trust.manage');
        return;
      }
      void vscode.window.showInformationMessage(
        'Redline: no git repository here — or git is not on PATH. Notes still work; the review scopes need git.',
      );
      return;
    }
    const count = scope === 'recent' ? s.recentCount : s.fileCount;
    if (count === 0) {
      // A dead end otherwise: the last run changed nothing, and the thing you almost certainly
      // want next — everything since the base — is one click away and was not offered.
      if (scope === 'recent' && s.fileCount > 0) {
        const other = `${s.fileCount} file${s.fileCount === 1 ? '' : 's'}`;
        const choice = await vscode.window.showInformationMessage(
          `Redline: the last run changed nothing. ${other} changed ${s.label}.`,
          'Show all changes',
        );
        if (choice === 'Show all changes') await openChanges('all');
        return;
      }
      void vscode.window.showInformationMessage(`Redline: nothing changed ${s.label}.`);
      return;
    }
    const breakdown = await range.statusBreakdown(scope);
    const files = `${count} file${count === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}`;
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

  /**
   * The diff of a run that has already finished.
   *
   * Sending a follow-up moves the boundary, so the run you were reading a moment ago stops
   * being "the last run" — and there was no way back to it.
   */
  async function reviewPreviousRun(): Promise<void> {
    const runs = await progress('looking for earlier runs…', () => range.pastRuns());
    if (runs.length === 0) {
      void vscode.window.showInformationMessage(
        'Redline: no earlier runs recorded here yet. The Claude Code plugin remembers the last few.',
      );
      return;
    }
    const items = await Promise.all(
      runs.map(async (run) => {
        const { count } = await range.diffForRun(run);
        return {
          label: `${shortWhen(run.at)} — ${count} file${count === 1 ? '' : 's'}`,
          description: new Date(run.at).toLocaleString(),
          run,
          count,
        };
      }),
    );
    const picked = await vscode.window.showQuickPick(
      items.filter((i) => i.count > 0),
      { placeHolder: 'Which run?' },
    );
    if (!picked) return;
    const { pairs } = await range.diffForRun(picked.run);
    await vscode.commands.executeCommand(
      'vscode.changes',
      `Run at ${shortWhen(picked.run.at)} — ${picked.count} file${picked.count === 1 ? '' : 's'}`,
      pairs,
    );
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
    /** Only the quiet poll, and only while something is waiting — but nothing outlives the host. */
    dispose: (): void => {
      if (quietTimer) clearInterval(quietTimer);
      quietTimer = undefined;
    },
    submit,
    sendSelected,
    previewBatch,
    copyNote,
    applyReport,
    applyFiledSoFar,
    clearSent,
    clearAll,
    restoreLastBatch,
    pickSession,
    reviewChanges,
    reviewAllChanges,
    reviewPreviousRun,
    nextChange,
    prevChange,
    markBaseline,
    clearBaseline,
    refresh,
    showLog,
    onAgentFinished,
    onExternalRunFinished,
    flushQueued,
    cancelQueued,
    isQueued: (): boolean => queued.size > 0,
    queuedIds: (): string[] => queued.list(),
    onQueueChange: (fn: () => void): void => {
      notifyQueue = fn;
    },
    onHookRunFinished,
    hookRunsReported: (): number => runsReported,
  };
}
