import * as vscode from 'vscode';
import * as path from 'node:path';
import { ReviewRange } from './reviewRange';
import { treeSide } from './treeSide';

/**
 * The run's changes in the editor's gutter.
 *
 * VS Code already draws these against HEAD, through the git extension's quick diff. That
 * answers "what is uncommitted", which in a worktree an agent has been working in for an hour
 * is nearly everything. This answers the question actually being asked — what did the *last
 * run* change in the file I am looking at — without opening a diff at all.
 *
 * A source control with nothing in its list: no group, no count, no commit box. It exists
 * purely to contribute a quick diff, which is the only way an extension can put marks in that
 * gutter.
 */
export class RunGutter implements vscode.Disposable {
  private sc: vscode.SourceControl | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly range: ReviewRange,
    private readonly enabled: () => boolean,
  ) {
    this.subs.push(this.range.onDidChange(() => this.sync()));
    this.sync();
  }

  /**
   * Create the provider only once there is a run to compare against, and drop it when there
   * is not.
   *
   * A quick diff can only be contributed by a source control, and a source control appears in
   * the Source Control view whether or not it has anything in it. A folder where Claude has
   * never run should not grow an empty section named after a feature it is not using.
   */
  sync(): void {
    if (!this.enabled()) {
      this.sc?.dispose();
      this.sc = undefined;
      return;
    }
    // Created on the first run and then kept. The comparison comes and goes as the summary
    // falls back and recovers, and disposing on every gap would have the Source Control view
    // flickering an entry in and out while the agent works.
    if (!this.sc) {
      if (this.range.runComparison() === undefined) return;
      this.sc = vscode.scm.createSourceControl('redlineRun', "Claude's last run");
    }
    // Reassigning is what makes VS Code ask again: there is no "the original moved" event, and
    // the original does move — every run replaces it.
    this.sc.quickDiffProvider = { provideOriginalResource: (uri) => this.originalFor(uri) };
  }

  /**
   * The file as the run found it, or nothing.
   *
   * Nothing is the common answer and has to stay cheap: this is asked for every file that
   * opens. Everything it needs is already computed for the panel, so it costs a lookup.
   */
  private originalFor(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined;
    const run = this.range.runComparison();
    if (!run) return undefined;
    const rel = path.relative(run.root, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const status = run.statuses.get(rel);
    // Untouched by the run: no marks, which is the point — only what the run did shows.
    if (!status || status.kind === 'deleted') return undefined;
    // Added by the run: it had no earlier version, and an empty original would mark every
    // line as new, which is true but says nothing.
    if (status.kind === 'added') return undefined;
    return treeSide(run.root, run.before, status.kind === 'renamed' ? status.from : rel);
  }

  dispose(): void {
    this.sc?.dispose();
    for (const s of this.subs) s.dispose();
  }
}
