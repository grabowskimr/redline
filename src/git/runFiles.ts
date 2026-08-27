/**
 * Deciding which changed files belong to the agent's last run.
 *
 * Pure — no `vscode`, no `git` — so the rules below can be tested directly. They have been
 * wrong in both directions before: a mtime-only cluster dropped files the agent committed
 * early or touched before a long pause, and a git-range-only test silently widened "the
 * last run" to the whole session whenever the agent committed nothing.
 */

/** Slack around the run's start: the transcript records when the agent spoke, the write follows. */
export const RUN_GRACE_MS = 60 * 1000;

export interface RunSelection {
  /** Files whose *committed* state changed during the run (`run.base..HEAD`). */
  committed: ReadonlySet<string>;
  /**
   * Files the agent itself changed, from the Redline hook. When present this is trusted as
   * the whole answer for uncommitted work: it is the only signal that can tell the agent's
   * edits from yours, or from a formatter's. Undefined when the hook is not installed.
   */
  attributed?: ReadonlySet<string>;
  /**
   * Files git does not track yet.
   *
   * Always part of the review. A file that does not exist in any base has never been looked
   * at, whichever run created it — and dating it against the newest run hid exactly the thing
   * most worth reading: a file the agent wrote two prompts ago and has not touched since.
   */
  untracked?: ReadonlySet<string>;
  /** Modification time in epoch ms, or undefined when the file is gone or unreadable. */
  mtimeOf: (file: string) => number | undefined;
  /** Epoch ms the run started. */
  since: number;
  graceMs?: number;
}

/**
 * Each half of the answer comes from the only place that can give it:
 *
 * - **Committed work** from git. A file committed early in the run has a working-tree mtime
 *   from before the run started, so a timestamp test alone would drop it.
 * - **Uncommitted work** from mtimes. Git has no timestamp for an edit that was never
 *   committed, so a range test alone cannot separate this run from the one before it.
 *
 * A file that cannot be dated (deleted, unreadable) is kept: a deletion is worth seeing, and
 * hiding a change is worse than showing one.
 */
export function selectRunFiles(files: readonly string[], selection: RunSelection): string[] {
  if (!Number.isFinite(selection.since)) return [...files];
  const floor = selection.since - (selection.graceMs ?? RUN_GRACE_MS);
  const attributed = selection.attributed;
  return files.filter((file) => {
    if (selection.committed.has(file)) return true;
    const mtime = selection.mtimeOf(file);
    // Deleted or unreadable: no way to place it, and a deletion is worth seeing.
    if (mtime === undefined) return true;
    // Never tracked: the whole file is unreviewed work, so it stays in the review.
    if (selection.untracked?.has(file)) return true;
    if (attributed) {
      // The hook knows who wrote what, so a timestamp is not needed for anything it names.
      return attributed.has(file);
    }
    return mtime >= floor;
  });
}
