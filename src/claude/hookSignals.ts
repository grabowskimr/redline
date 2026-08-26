import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '../logger';

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
/** Repeat end-of-run signals inside this window are the same run. */
const END_RUN_QUIET_MS = 5_000;
/** A run believed to be in flight for longer than this has lost its end signal. */
const MAX_RUN_MS = 30 * 60_000;

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

  private readonly subs: vscode.Disposable[] = [];
  private touchTimer: NodeJS.Timeout | undefined;
  private lastEndRun = 0;
  private runStartedAt = 0;
  private runEndedAt = 0;

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
        // Exact names only. Snapshot copies live in the same tree under percent-encoded
        // names, so a repository file called `touched.jsonl` would otherwise look like one.
        const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
        if (name === 'stopped.json') {
          // One write can arrive as both a create and a change, and a turn can end more
          // than once in quick succession. A run is reported once.
          const now = Date.now();
          if (now - this.lastEndRun < END_RUN_QUIET_MS) return;
          this.lastEndRun = now;
          this.runEndedAt = now;
          this._onDidEndRun.fire();
          return;
        }
        // The snapshot manifest is written as a request is submitted: the run boundary has
        // moved, which is the only thing that makes re-reading the transcript worthwhile.
        if (name === 'manifest.json') {
          this.runStartedAt = Date.now();
          this._onDidStartRun.fire();
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

  /**
   * Whether the agent is working on something right now.
   *
   * Derived from the hook's own markers — a request was submitted and has not stopped — so
   * it holds in a plain terminal, where the Orca idle monitor cannot see anything at all.
   * A run that never reports its end is not believed indefinitely: without that, one missed
   * `Stop` would leave the panel claiming Claude is busy forever.
   */
  get running(): boolean {
    if (this.runStartedAt === 0 || this.runEndedAt >= this.runStartedAt) return false;
    return Date.now() - this.runStartedAt < MAX_RUN_MS;
  }

  static directory(home = os.homedir()): string {
    return path.join(home, '.claude', 'redline');
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
    if (this.touchTimer) clearTimeout(this.touchTimer);
    for (const s of this.subs) s.dispose();
    this._onDidTouch.dispose();
    this._onDidEndRun.dispose();
    this._onDidStartRun.dispose();
  }
}
