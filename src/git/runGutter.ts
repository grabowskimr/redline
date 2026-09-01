import * as vscode from 'vscode';
import * as path from 'node:path';
import { emptySide, ReviewRange } from './reviewRange';
import { treeSide } from './treeSide';

/**
 * The run's changes in the editor's gutter.
 *
 * VS Code already draws these against HEAD, through the git extension's quick diff. That
 * answers "what is uncommitted", which in a worktree an agent has been working in for an hour
 * is nearly everything. This answers the question actually being asked — what did the *last
 * run* change in the file I am looking at — without opening a diff at all.
 *
 * It also lists what the run changed, under the same heading in the Source Control view.
 * That section existed and was always empty — a quick diff can only be contributed by a source
 * control, and a source control shows up in that view whether or not it has anything in it, so
 * the list was a hole where an obvious one belonged. Clicking an entry opens the same
 * comparison the panel does: the file as the run found it, beside the file now.
 */
export class RunGutter implements vscode.Disposable {
  private sc: vscode.SourceControl | undefined;
  private group: vscode.SourceControlResourceGroup | undefined;
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
      this.group?.dispose();
      this.group = undefined;
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
      // Nothing here is committed, so there is nothing to write a message about. The box is on
      // by default because most source controls are repositories; this one is a view of a run.
      this.sc.inputBox.visible = false;
      // "Changes", under "Claude's last run" — the way a repository reads. Naming it after the
      // run as well said the same thing twice, one line under itself.
      this.group = this.sc.createResourceGroup('run', 'Changes');
      this.group.hideWhenEmpty = true;
    }
    // Reassigning is what makes VS Code ask again: there is no "the original moved" event, and
    // the original does move — every run replaces it.
    this.sc.quickDiffProvider = { provideOriginalResource: (uri) => this.originalFor(uri) };
    this.list();
  }

  /**
   * What the run changed, as a list you can click through.
   *
   * Built from the comparison the panel has already computed, so this costs a walk of a map
   * rather than any git. Each entry opens the run's own two sides — the file as the run found
   * it, against the file now — which is the same thing *Last run* opens, one file at a time.
   */
  private list(): void {
    const group = this.group;
    if (!group) return;
    const run = this.range.runComparison();
    if (!run) {
      group.resourceStates = [];
      return;
    }
    const states: vscode.SourceControlResourceState[] = [];
    for (const [rel, status] of [...run.statuses].sort((a, b) => a[0].localeCompare(b[0]))) {
      const uri = vscode.Uri.file(path.join(run.root, rel));
      const from = status.kind === 'renamed' ? status.from : rel;
      // A file the run created has no earlier side; one it deleted has no current side. Both
      // are real outcomes of a run and both belong in the list, so each gets an empty stand-in
      // that keeps the real path in the editor's title.
      const left = status.kind === 'added' ? emptySide(uri, 'new file') : treeSide(run.root, run.before, from);
      const right = status.kind === 'deleted' ? emptySide(uri, 'deleted') : uri;
      states.push({
        resourceUri: uri,
        decorations: {
          strikeThrough: status.kind === 'deleted',
          tooltip: LABEL[status.kind] ?? 'changed in the last run',
        },
        command: {
          command: 'vscode.diff',
          title: 'Open the run’s changes to this file',
          arguments: [left, right, `${path.basename(rel)} — last run`],
        },
      });
    }
    // The group header carries its own count. `SourceControl.count` would add these to the
    // badge on the activity bar, on top of the git extension's count of the same files.
    group.resourceStates = states;
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
    this.group?.dispose();
    this.sc?.dispose();
    for (const s of this.subs) s.dispose();
  }
}

/** What the run did to a path, for the tooltip beside it. */
const LABEL: Record<string, string> = {
  added: 'Added in the last run',
  deleted: 'Deleted in the last run',
  renamed: 'Renamed in the last run',
  modified: 'Modified in the last run',
};
