import * as vscode from 'vscode';
import { Config } from '../config';
import { ReviewStore } from '../store/reviewStore';
import { isOpen } from '../model/note';
import { NoteIndex } from './noteIndex';
import { ReviewRange } from '../git/reviewRange';
import { SessionWatcher } from '../claude/sessionWatcher';
import { HookSignals } from '../claude/hookSignals';

/**
 * `$(comment-discussion) 3  $(git-compare) 12  ⟳ Claude working…`
 * Click: send the open notes, or open the panel when there are none.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private changedFiles = 0;
  private rangeLabel = '';

  private readonly sub: vscode.Disposable;

  /**
   * Set after construction, the way the panel's is: the signal channel is created later in
   * activation than this is.
   */
  signals: HookSignals | undefined;

  constructor(
    private readonly store: ReviewStore,
    private readonly config: Config,
    private readonly index: NoteIndex,
    private readonly range: ReviewRange,
    private readonly watcher: SessionWatcher,
  ) {
    this.item = vscode.window.createStatusBarItem('redline.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Redline';
    // The changed-file count comes from git, so it is refreshed only when the range says
    // so — never from `update()`, which runs on every store change.
    this.sub = range.onDidChange(() => void this.refreshRange());
    void this.refreshRange();
    this.update();
  }

  update(): void {
    if (!this.config.showStatusBar) {
      this.item.hide();
      return;
    }
    const open = this.store.notes.filter(isOpen).length;
    const sent = this.store.notes.filter((n) => n.sent);
    const addressed = sent.filter((n) => n.sent?.outcome || this.index.changedSinceSent(n.id)).length;

    const parts = [`$(comment-discussion) ${open}`];
    if (this.changedFiles > 0) parts.push(`$(git-compare) ${this.changedFiles}`);
    if (sent.length) parts.push(`$(send) ${addressed}/${sent.length}`);
    if (this.working) parts.push('$(loading~spin)');
    this.item.text = parts.join('  ');
    this.item.command = open > 0 ? 'redline.submit' : 'redline.focusPanel';

    const lines: string[] = [
      open ? `**${open}** open note${open === 1 ? '' : 's'} — click to send to Claude Code` : 'No open notes — click to open the panel',
    ];
    if (this.changedFiles > 0) {
      lines.push(`**${this.changedFiles}** changed file${this.changedFiles === 1 ? '' : 's'} ${this.rangeLabel} — "Review Latest Changes" opens the diff`);
    }
    if (sent.length) lines.push(`${sent.length} sent, ${addressed} addressed`);
    if (this.working) {
      // The monitor only ever attaches to an Orca terminal, so it has no label for a session
      // the hook is reporting on.
      const who = this.watcher.label;
      lines.push(
        who
          ? `Watching **${who}** — you'll be pinged when it finishes.`
          : `Claude is working — you'll be pinged when it finishes.`,
      );
    }
    this.item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    this.item.show();
  }

  /**
   * Whether to say a run is in flight, decided the same way the panel decides it.
   *
   * The panel prefers the hook, which reports from any terminal; the idle monitor is the
   * fallback and only sees Orca ones. Reading the monitor alone meant that with the plugin
   * installed and no Orca terminal the panel said "Claude is working…" while the status bar
   * said nothing at all.
   */
  private get working(): boolean {
    return this.signals?.running === true || this.watcher.state === 'working';
  }

  private async refreshRange(): Promise<void> {
    try {
      const s = await this.range.summary();
      const files = s?.recentCount ?? 0;
      const label = s?.recentLabel ?? '';
      if (files !== this.changedFiles || label !== this.rangeLabel) {
        this.changedFiles = files;
        this.rangeLabel = label;
        this.update();
      }
    } catch {
      // best effort
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
