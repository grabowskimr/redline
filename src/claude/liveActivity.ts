import * as vscode from 'vscode';
import * as path from 'node:path';
import { HookSignals } from './hookSignals';
import { touchedSince } from './touched';

/**
 * What the session is doing, while it is doing it.
 *
 * A Claude Code session shows its own work in its own terminal — which is no help when the
 * terminal is in another window, or another app, or behind the editor you are reading. The
 * panel had no way of saying anything between "a run started" and "a run finished", so a long
 * turn was indistinguishable from a hung one.
 *
 * The hook already records every file the agent writes, as it writes it. That is enough to say
 * what it is working on right now without asking the session anything, and without a second
 * Claude to ask.
 */

export interface Activity {
  running: boolean;
  /** The file it touched most recently, repository-relative. */
  file?: string;
  /** How many distinct files this run has touched so far. */
  files?: number;
}

/** Files touched before this are the previous run's, not this one's. */
const RUN_GRACE_MS = 60_000;

export class LiveActivity implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Activity>();
  readonly onDidChange = this._onDidChange.event;

  private readonly subs: vscode.Disposable[] = [];
  private state: Activity = { running: false };
  private runStartedAt = 0;

  constructor(
    private readonly signals: HookSignals,
    /**
     * Where the repository is.
     *
     * A function rather than the whole `ReviewRange`, which is the only thing this module
     * wanted from it — and taking the class made `claude/` and `git/` point at each other,
     * when everything else in `claude/` is about the session and knows nothing about git.
     */
    private readonly repoRoot: () => Promise<string | undefined>,
  ) {
    this.subs.push(
      this._onDidChange,
      signals.onDidStartRun(() => {
        this.runStartedAt = Date.now();
        this.update({ running: true });
      }),
      // Debounced upstream, so this is at most one read per burst of writes.
      signals.onDidTouch(() => void this.refresh()),
      signals.onDidEndRun(() => this.update({ running: false })),
    );
  }

  get current(): Activity {
    return { ...this.state };
  }

  /**
   * Read what the run has touched so far.
   *
   * The log is parsed from a cache keyed on its size and mtime, so a burst of writes to the
   * same file costs one read between them.
   */
  private async refresh(): Promise<void> {
    if (!this.signals.running) {
      // A write with no run around it is someone else's: a formatter, a build, or you.
      if (this.state.running) this.update({ running: false });
      return;
    }
    const root = await this.repoRoot();
    if (!root) return;
    const since = (this.runStartedAt || Date.now()) - RUN_GRACE_MS;
    const entries = (await touchedSince(root, since)) ?? [];
    if (entries.length === 0) {
      this.update({ running: true });
      return;
    }
    const files = new Set(entries.map((e) => e.file));
    const newest = entries[entries.length - 1];
    const file = newest ? path.relative(root, newest.file) || path.basename(newest.file) : undefined;
    this.update({
      running: true,
      ...(file && !file.startsWith('..') ? { file } : {}),
      files: files.size,
    });
  }

  private update(next: Activity): void {
    // Only when something visible moved: this fires on every write the agent makes.
    if (next.running === this.state.running && next.file === this.state.file && next.files === this.state.files) {
      return;
    }
    this.state = next;
    this._onDidChange.fire(this.current);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
