import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '../logger';
import { projectSlug, slugInScope, SlugScope } from './transcripts';

/**
 * Push notifications from the Redline hook, in place of asking repeatedly whether anything
 * happened.
 *
 * The hook writes to `~/.claude/redline/<slug>/` as the agent works, so watching that one
 * small directory says exactly when the agent touched a file and when a run ended. Polling
 * cannot beat it: an interval is either too slow to feel immediate or too expensive to run,
 * and a workspace-wide watcher fires for builds and formatters as well.
 *
 * Optional, like the hook itself. With no hook installed this simply never fires and the
 * timer-based paths still carry the feature.
 */
/** Long enough to absorb a burst of edits, short enough to feel immediate. */
const TOUCH_DEBOUNCE_MS = 500;

/**
 * How long to let a report file settle before reading it.
 *
 * Short: the whole point is that an answer lands while the agent is still working, and a
 * second of that is a second of watching a card say nothing. Long enough that a write in two
 * parts is read once, not twice.
 */
const REPORT_DEBOUNCE_MS = 250;
/**
 * Repeat end-of-run signals inside this window are the same run.
 *
 * Only reached when the marker cannot be read. The marker itself carries the session and the
 * moment, which says exactly what a create-plus-change pair is, so a time window is no longer
 * the first line of defence — it used to swallow a *second* session's stop as a duplicate and
 * leave that run marked live until `MAX_RUN_MS`.
 */
const END_RUN_QUIET_MS = 5_000;
/** A run believed to be in flight for longer than this has lost its end signal. */
const MAX_RUN_MS = 30 * 60_000;

/**
 * A run that has not written a single marker for this long has probably died.
 *
 * The hook writes on every tool call, so a working agent is never quiet for minutes at a
 * stretch — but a long `Bash` (a test suite) is, so this can only ever be a suspicion. It is
 * never acted on by itself: it turns a silent thirty-minute hold into an offer to send anyway,
 * which was the whole complaint. A crashed agent or a killed terminal writes no `stopped.json`
 * at all, and until this there was nothing on screen to suggest the signal had been lost.
 */
const STALE_RUN_MS = 5 * 60_000;

/** How many stop markers to remember, so a create-plus-change pair is handled once. */
const SEEN_STOPS = 8;

/** A run whose marker could not be read, so it has no session to be told apart by. */
const UNATTRIBUTED = '';

export class HookSignals implements vscode.Disposable {
  private readonly _onDidTouch = new vscode.EventEmitter<void>();
  /** The agent changed a file. */
  readonly onDidTouch = this._onDidTouch.event;

  private readonly _onDidEndRun = new vscode.EventEmitter<void>();
  /** The agent stopped — the moment to read its report and offer the diff. */
  readonly onDidEndRun = this._onDidEndRun.event;

  private readonly _onDidStartRun = new vscode.EventEmitter<void>();
  /** A new request was submitted, so the run boundary has moved. */
  readonly onDidStartRun = this._onDidStartRun.event;

  private readonly _onDidReport = new vscode.EventEmitter<void>();
  /**
   * The agent wrote its report file.
   *
   * It is asked to write it again each time it settles a note, not once at the end, so this
   * fires several times during a run — which is the point: the card can answer a note seconds
   * after the edit instead of when the whole turn finishes.
   */
  readonly onDidReport = this._onDidReport.event;

  private readonly subs: vscode.Disposable[] = [];
  private touchTimer: NodeJS.Timeout | undefined;
  private reportTimer: NodeJS.Timeout | undefined;
  private lastEndRun = 0;
  private everHeard = false;
  /** When the hook last said anything at all, for `maybeStale`. */
  private lastSignalAt = 0;
  /**
   * The runs believed to be in flight, by the session that started them.
   *
   * This was one flag — a start time and an end time — and `runs.json`/`stopped.json` are
   * keyed by repository root, not by session. Two Claude sessions in one repository therefore
   * shared it: A started, B started, A stopped, and "ended after started" made the flag false
   * while B was mid-turn, so the queue flushed straight into B's turn. That is the exact thing
   * the queue exists to prevent, and B was not even the session the notes were meant for.
   *
   * What the markers can promise: each one names the session it belongs to, so a stop can be
   * matched to the start it ends. What they cannot: they are single-slot files that two
   * sessions overwrite, so a start can be missed if a second session publishes before this
   * reads. A missed start means a stop that matches nothing, which leaves the *other* run
   * standing — holding a moment longer, which is the side to err on.
   */
  private readonly runs = new Map<string, number>();
  /** `pending.at` of the request already counted as started, so a rewrite is not a new run. */
  private pendingAt: string | undefined;
  /** `session|at` of stop markers already handled: one write arrives as create *and* change. */
  private readonly seenStops: string[] = [];
  /** Marker reads run in the order the events arrived, or a stop can overtake its own start. */
  private markerWork: Promise<void> = Promise.resolve();

  /**
   * Whether the plugin has said anything at all for this folder.
   *
   * The panel used to read "not watched" between runs for everyone without Orca, including
   * people whose plugin was working perfectly — the watcher it was reporting on only ever
   * attaches to Orca terminals. Having heard from the hook is the honest answer to "is
   * anything keeping an eye on this".
   */
  get reporting(): boolean {
    return this.everHeard;
  }

  constructor(logger: Logger) {
    const dir = HookSignals.directory();
    try {
      // Recursive: a directory appears per working directory, including ones first used
      // after this watcher was created.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '**/*'),
        false,
        false,
        true, // deletions are housekeeping, not news
      );
      const onEvent = (uri: vscode.Uri): void => {
        // This workspace's runs only. The hook writes one directory per working directory and
        // this watches the lot, so a run in an unrelated repository used to wake every open
        // window: a change-summary recomputation and a session discovery, several times a
        // second, for work that cannot touch anything on screen.
        if (!HookSignals.ours(uri)) return;
        this.everHeard = true;
        this.lastSignalAt = Date.now();
        // Exact names only. Snapshot copies live in the same tree under percent-encoded
        // names, so a repository file called `touched.jsonl` would otherwise look like one.
        const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
        if (name === 'stopped.json') {
          // A run in a repository *below* this one is another repository's run — the hook keys
          // its markers by repository root — and clearing this window's state on it was how a
          // nested project's finish flipped this one to idle mid-turn.
          if (!HookSignals.ours(uri, 'self-or-above')) return;
          this.queueMarker(() => this.runStopped(uri));
          return;
        }
        // Written as a request is submitted: the run boundary has moved, which is the only
        // thing that makes re-reading the transcript worthwhile. `runs.json` is the current
        // hook's marker and `manifest.json` an older one's, so both are watched.
        if (name === 'runs.json' || name === 'manifest.json') {
          if (!HookSignals.ours(uri, 'self-or-above')) return;
          this.queueMarker(() => this.runStarted(uri, name === 'runs.json'));
          return;
        }
        if (name === 'report.json') {
          // Written in pieces as the agent works, so a burst is normal. Coalesce it: reading
          // and applying is cheap, but not free, and half a write is worth nothing.
          if (this.reportTimer) clearTimeout(this.reportTimer);
          this.reportTimer = setTimeout(() => {
            this.reportTimer = undefined;
            this._onDidReport.fire();
          }, REPORT_DEBOUNCE_MS);
          return;
        }
        if (name !== 'touched.jsonl') return;
        // The log is appended to once per tool call, which can be several times a second.
        // Coalesce the burst: each signal costs a full change-summary recomputation.
        if (this.touchTimer) clearTimeout(this.touchTimer);
        this.touchTimer = setTimeout(() => {
          this.touchTimer = undefined;
          this._onDidTouch.fire();
        }, TOUCH_DEBOUNCE_MS);
      };
      this.subs.push(watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent));
      logger.info(`watching ${dir} for hook signals`);
    } catch (err) {
      logger.warn('could not watch for hook signals', err);
    }
  }

  /** Read one marker file, tolerating the half-written and the missing alike. */
  private static async marker(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
    try {
      return JSON.parse(await fs.readFile(uri.fsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined; // renamed into place, but a reader can still lose the race
    }
  }

  /** Marker reads are chained: a stop read must not overtake the start it ends. */
  private queueMarker(work: () => Promise<void>): void {
    this.markerWork = this.markerWork.then(work, work).catch(() => undefined);
  }

  /**
   * `runs.json` changed.
   *
   * Two separate things come out of this, and conflating them is a bug:
   *
   * - **The boundary may have moved**, so anything showing a diff has to recompute. That is
   *   true of every write and is what `onDidStartRun` is for.
   * - **A request is in flight**, which holds the send queue and puts "Claude is working" on
   *   the panel. That is true only while the hook has an unsettled request marker.
   *
   * Hook 1 wrote this file once, at submit, so the two were the same event. Hook 2 writes it
   * three times a run — at submit, when the run first changes something, and when the run is
   * settled at `Stop` — and the last of those is a run *ending*. Treating it as a start left
   * the panel claiming the agent was busy for `MAX_RUN_MS` whenever the watcher delivered
   * `runs.json` after the `stopped.json` written a moment later, which it is free to do.
   */
  private async runStarted(uri: vscode.Uri, current: boolean): Promise<void> {
    // `manifest.json` is the older hook's marker and names no session, so every run it
    // reports shares one slot — the single-flag behaviour, for the people who still have it.
    const marker = current ? await HookSignals.marker(uri) : undefined;
    const version = typeof marker?.['version'] === 'number' ? (marker['version'] as number) : 1;
    if (marker && version >= 2) {
      const pending = marker['pending'] as { session?: unknown; at?: unknown } | undefined;
      const at = typeof pending?.at === 'string' ? pending.at : undefined;
      if (at) {
        // Only a request not seen before: promotion rewrites the file mid-run without a new
        // one, and re-stamping the start there would keep pushing `maybeStale` out of reach.
        if (at !== this.pendingAt) {
          this.pendingAt = at;
          const session = typeof pending?.session === 'string' ? pending.session : UNATTRIBUTED;
          this.runs.set(session, Date.now());
        }
      } else {
        // Settled. `stopped.json` is what ends the run; this must not resurrect it.
        this.pendingAt = undefined;
      }
    } else {
      const before = marker?.['before'] as { session?: unknown } | undefined;
      const session = typeof before?.session === 'string' ? before.session : UNATTRIBUTED;
      this.runs.set(session, Date.now());
    }
    this._onDidStartRun.fire();
  }

  private async runStopped(uri: vscode.Uri): Promise<void> {
    const marker = await HookSignals.marker(uri);
    const session = typeof marker?.['session'] === 'string' ? (marker['session'] as string) : undefined;
    const at = typeof marker?.['at'] === 'string' ? (marker['at'] as string) : undefined;
    if (session !== undefined && at) {
      // The marker says which run this is, so the same one arriving twice is exact rather
      // than a guess at a quiet window — and two sessions stopping a second apart are two
      // ends, not a duplicate.
      const key = `${session}|${at}`;
      if (this.seenStops.includes(key)) return;
      this.seenStops.push(key);
      if (this.seenStops.length > SEEN_STOPS) this.seenStops.shift();
      // Only the run that ended. A stop naming a session nobody started leaves the other runs
      // exactly where they are — guessing which of them it "really" meant is how a stop in one
      // session used to clear another session's turn.
      if (!this.runs.delete(session)) {
        // Except a run that could not be attributed in the first place: an unreadable
        // `runs.json`, or the older hook that names no session. There is nothing to match it
        // against, and one unattributed run plus one stop is far more likely to be the same
        // turn than two, so believing the stop beats stranding it until `MAX_RUN_MS`.
        this.runs.delete(UNATTRIBUTED);
      }
    } else {
      // Unreadable, or a hook too old to name the session. Nothing can be matched, so this
      // falls back to what it always did: one flag, cleared, guarded by a quiet window.
      const now = Date.now();
      if (now - this.lastEndRun < END_RUN_QUIET_MS) return;
      this.lastEndRun = now;
      this.runs.clear();
    }
    this._onDidEndRun.fire();
  }

  /**
   * Whether the agent is working on something right now.
   *
   * Derived from the hook's own markers — a request was submitted and has not stopped — so
   * it holds in a plain terminal, where the Orca idle monitor cannot see anything at all.
   * A run that never reports its end is not believed indefinitely: without that, one missed
   * `Stop` would leave the panel claiming Claude is busy forever.
   *
   * True while *any* session in this repository is mid-turn. The markers cannot promise that
   * the run still standing is the one the notes are meant for — only that a turn is in
   * progress somewhere in this repository — and sending into someone else's turn is the
   * failure worth avoiding.
   */
  get running(): boolean {
    const now = Date.now();
    for (const [session, startedAt] of this.runs) {
      if (now - startedAt < MAX_RUN_MS) return true;
      this.runs.delete(session);
    }
    return false;
  }

  /**
   * A run that is believed live but has gone quiet — probably dead, never certainly.
   *
   * Nothing acts on this by itself. It is what lets the panel say the agent may no longer be
   * running, and what turns a held note into an offer to send it anyway, instead of a silent
   * wait for `MAX_RUN_MS` that nothing on screen explained.
   */
  get maybeStale(): boolean {
    return this.running && this.lastSignalAt > 0 && Date.now() - this.lastSignalAt > STALE_RUN_MS;
  }

  static directory(home = os.homedir()): string {
    return path.join(home, '.claude', 'redline');
  }

  /** Whether a signal comes from a directory this window is looking at. */
  static ours(uri: vscode.Uri, scope: SlugScope = 'related'): boolean {
    const slug = uri.path.split('/redline/')[1]?.split('/')[0];
    return !!slug && slugInScope(slug, HookSignals.workspaceSlugs(), scope);
  }

  private static workspaceSlugs(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => projectSlug(f.uri.fsPath));
  }

  /**
   * Make sure the directory exists so the watcher has something to attach to — a watcher on
   * a missing path does not reliably start reporting when it appears. Only when Claude Code
   * is present: otherwise this would create a folder for a tool the user does not have.
   */
  static async ensureDirectory(): Promise<void> {
    const claude = vscode.Uri.file(path.join(os.homedir(), '.claude'));
    try {
      await vscode.workspace.fs.stat(claude);
    } catch {
      return;
    }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(HookSignals.directory()));
    } catch {
      // not writable; the watcher just never fires
    }
  }

  dispose(): void {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this._onDidReport.dispose();
    if (this.touchTimer) clearTimeout(this.touchTimer);
    for (const s of this.subs) s.dispose();
    this._onDidTouch.dispose();
    this._onDidEndRun.dispose();
    this._onDidStartRun.dispose();
  }
}
