import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger';
import { ReviewStore } from '../store/reviewStore';
import { GitService } from './gitApi';
import { lastRequestStart, lastRunStart, latestSessionAmong, reviewWindowStart } from '../claude/transcripts';
import { parseDiffByFile, parseHunks } from './hunks';
import { RUN_GRACE_MS, selectRunFiles } from './runFiles';
import { touchedPathsSince } from '../claude/touched';
import { differsFromSnapshot, readSnapshot, RunSnapshot } from '../claude/snapshot';

const execFileP = promisify(execFile);
const CACHE_MS = 2000;
/**
 * Hardest floor between two full recomputations.
 *
 * The workspace-wide watcher fires constantly while an agent writes files or a build runs,
 * and each
 * invalidation used to drop the cache outright — so the whole summary (four to six `git`
 * spawns plus a `stat` per changed file, against a 42k-file repo here) ran every 800ms for
 * as long as the churn lasted. Serving data up to a second old costs nothing anyone can
 * see; respawning git twice a second does.
 */
const MIN_RECOMPUTE_MS = 1200;

/** Cap on remembered agent working directories, so neither the set nor the reads grow. */
const MAX_CWD_HINTS = 4;

/** How many missing files a single walk will step over before giving up. */
const WALK_ATTEMPTS = 5;

/** A new file larger than this is not read just to count its lines. */
const MAX_NEW_FILE_SCAN_BYTES = 2 * 1024 * 1024;

/** Above this, a recomputation is worth explaining in the log. */
const SLOW_SUMMARY_MS = 500;

/** Safety net for the untracked listing, in case a create or delete event is missed. */
const UNTRACKED_TTL_MS = 60_000;

/** How long a resolved ref (the published floor, HEAD) is reused for. */
const REF_CACHE_MS = 15_000;

/**
 * How far a snapshot may predate the run it describes. The hook writes it as the request is
 * submitted and the transcript records the same moment, so this only absorbs clock jitter.
 */
const SNAPSHOT_TOLERANCE_MS = 60_000;
/**
 * Short: the base carries the run boundary, so a stale one makes the panel show last-run
 * figures from half a minute ago. Recomputing is cheap — the transcript readers memoize on
 * file size and mtime, so an unchanged session costs a `stat`.
 */
const BASE_CACHE_MS = 4_000;

/**
 * A gap longer than this between two file modifications starts a new "run". Long enough
 * to span an agent's thinking pauses, short enough to separate two work sessions.
 */
const DEFAULT_RUN_GAP_MS = 15 * 60 * 1000;


export interface Hunk {
  uri: vscode.Uri;
  /** 0-based inclusive. */
  start: number;
  end: number;
  /** Pure removal: `start` is the line the deleted block used to sit after. */
  deletion?: boolean;
}

interface ResolvedBase {
  base: string;
  label: string;
  origin: RangeSummary['origin'];
  /**
   * The last run inside the session, when the transcript could tell us where it starts.
   * Absent for a pinned baseline or a plain HEAD comparison, where there is no activity
   * record to read and file mtimes are the only signal left.
   */
  run?: { base: string; since: string };
}

export interface RangeSummary {
  /** Commit the review is measured from. */
  base: string;
  /** Short human label for the full range, e.g. `since the last commit`. */
  label: string;
  /** Every file that differs from the base. */
  files: string[];
  fileCount: number;
  origin: 'manual' | 'session' | 'local' | 'head';
  /**
   * The most recent burst of edits — "the last run". Files whose modification times form
   * one cluster at the end of the timeline, which is what you want to re-read after an
   * agent (or you) has just been working, regardless of which session did it.
   */
  recent: string[];
  recentCount: number;
  /** Label for the burst, e.g. `in the last run (since 14:31)`. */
  recentLabel: string;
  /** How many changed files are older than the burst. */
  olderCount: number;
  /**
   * How `recent` was decided. `hook` is exact — the agent reported its own edits.
   * `transcript` uses the session's activity record plus file times, so a file you saved
   * during the run counts as the agent's. `mtime` is the last-resort cluster.
   */
  recentSource: 'hook' | 'transcript' | 'mtime';
  /** True when the file list could not be read at all — distinct from "nothing changed". */
  unavailable?: boolean;
}

/**
 * "What changed that I should review?"
 *
 * The base commit is resolved, in order of preference:
 *   1. a baseline the user pinned explicitly (Mark Baseline),
 *   2. the commit HEAD pointed at when the current Claude Code session started — so work
 *      the agent committed *during* the session is included,
 *   3. HEAD — i.e. every uncommitted change.
 *
 * Comparing a commit against the working tree always includes uncommitted work, so this
 * holds even when VS Code is opened long after the agent finished.
 */
const IGNORED_PATH = /\/(?:\.git|node_modules|dist|out|build|\.next|coverage|\.turbo|\.nx)\//;

export class ReviewRange implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private root: string | undefined;
  /** Directories a Claude session was seen running in (added as sessions are detected). */
  private readonly cwdHints = new Set<string>();
  private cache: { at: number; summary: RangeSummary } | undefined;
  /** Something changed on disk: recompute when the floor above allows it. */
  private stale = false;
  /**
   * A recomputation already running. Two listeners react to every change event — the panel
   * strip and the status bar — and both ask for the summary synchronously, so without this
   * they each start their own round of git calls before either can populate the cache.
   */
  private inFlight: Promise<RangeSummary | undefined> | undefined;
  private baseCache: { at: number; value: ResolvedBase | undefined } | undefined;
  private hunkCache: { base: string; hunks: Hunk[] } | undefined;
  /** Base whose listing failure has already been surfaced, so it is reported once. */
  private reportedFailure: string | undefined;
  /** The run-start snapshot behind the current summary, if the hook provided one. */
  private snapshot: RunSnapshot | undefined;
  /** Untracked listing, reused until a file is created or deleted. */
  private untrackedCache: { at: number; files: string[] } | undefined;
  private untrackedDirty = true;
  private untrackedRefresh: Promise<string[]> | undefined;
  /**
   * The published floor costs up to four `merge-base` calls and only moves when you push or
   * pull; HEAD only moves on commit. In a 42k-file repo each spawn is ~0.18s of real work —
   * parallelising them saved 17%, not spawning them saves all of it.
   */
  private floorCache: { at: number; sha: string | undefined } | undefined;
  private headCache: { at: number; sha: string } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ReviewStore,
    private readonly logger: Logger,
    private readonly git?: GitService,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
    const onFsEvent = (uri: vscode.Uri): void => {
      // Build output and VCS internals churn constantly while an agent works; recomputing
      // the range for those would keep the panel busy for no benefit.
      if (IGNORED_PATH.test(uri.path)) return;
      this.invalidateSoon();
    };
    // Editing a file cannot change which files are untracked; creating or deleting one can.
    const onFsAddOrRemove = (uri: vscode.Uri): void => {
      if (IGNORED_PATH.test(uri.path)) return;
      this.untrackedDirty = true;
      this.invalidateSoon();
    };
    this.subs.push(
      watcher,
      watcher.onDidChange(onFsEvent),
      watcher.onDidCreate(onFsAddOrRemove),
      watcher.onDidDelete(onFsAddOrRemove),
      vscode.workspace.onDidSaveTextDocument((d) => onFsEvent(d.uri)),
    );
    // Warmed in the background: the first list is the expensive one, and nobody should be
    // waiting on it when it happens.
    void this.refreshUntracked();
  }

  // ── git plumbing ──────────────────────────────────────────────────────

  private async run(args: string[]): Promise<string> {
    const root = await this.repoRoot();
    if (!root) throw new Error('not a git repository');
    // core.quotePath is on by default, which would return `"caf\303\251.ts"` for
    // `café.ts` — a path that then fails every stat, URI and open downstream.
    const { stdout } = await execFileP('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }

  /** The repository root — `git diff` prints paths relative to it, not to the open folder. */
  async repoRoot(): Promise<string | undefined> {
    if (this.root) return this.root;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return undefined;
    try {
      const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: folder });
      this.root = stdout.trim() || folder;
    } catch {
      this.root = undefined;
    }
    return this.root;
  }

  // ── base resolution ───────────────────────────────────────────────────

  /** Remember that a Claude session runs in `cwd` — used to find its transcript. */
  addCwdHint(cwd: string): void {
    if (!cwd || this.cwdHints.has(cwd)) return;
    this.cwdHints.add(cwd);
    // Bounded: a long-lived window can otherwise see dozens of sessions.
    while (this.cwdHints.size > MAX_CWD_HINTS) {
      const oldest = this.cwdHints.values().next().value;
      if (oldest === undefined) break;
      this.cwdHints.delete(oldest);
    }
    this.invalidateBase();
  }

  /** Pin an explicit baseline: a snapshot of the working tree as it is right now. */
  async markNow(reason: string): Promise<boolean> {
    try {
      const head = (await this.run(['rev-parse', 'HEAD'])).trim();
      // `stash create` writes an unreferenced commit; nothing in the repo is modified.
      // It returns empty when the tree is clean, in which case HEAD *is* the snapshot.
      const created = (await this.run(['stash', 'create', `redline baseline (${reason})`])).trim();
      // `stash create` covers tracked changes only, so files that were already untracked
      // when the baseline was pinned have to be remembered separately or they would show
      // up as "changed since the pin" forever.
      const untracked = (await this.run(['ls-files', '--others', '--exclude-standard']))
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
      this.store.setBaseline({ sha: created || head, at: new Date().toISOString(), headSha: head, untracked });
      this.invalidateBase();
      return true;
    } catch (err) {
      this.logger.warn('could not mark a baseline', err);
      return false;
    }
  }

  clearBaseline(): void {
    this.store.setBaseline(undefined);
    this.invalidateBase();
  }

  /** Resolving the base reads Claude's transcripts, so it is cached separately and longer. */
  private async resolveBase(): Promise<ResolvedBase | undefined> {
    if (this.baseCache && Date.now() - this.baseCache.at < BASE_CACHE_MS) return this.baseCache.value;
    const value = await this.computeBase();
    this.baseCache = { at: Date.now(), value };
    return value;
  }

  private async computeBase(): Promise<ResolvedBase | undefined> {
    const root = await this.repoRoot();
    if (!root) return undefined;

    const pinned = this.store.baseline;
    if (pinned) {
      return { base: pinned.sha, label: `since ${shortTime(pinned.at)}`, origin: 'manual' };
    }

    // The Claude session that ran (or is running) here. The folder VS Code opened, the
    // repository root and the agent's own cwd can all differ, so all are candidates.
    try {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const session = await latestSessionAmong([...folders, root, ...this.cwdHints]);
      if (session) {
        const since = reviewWindowStart(session);
        const sha = await this.commitAt(since);
        if (sha) {
          const resolved: ResolvedBase = {
            base: sha,
            label: `since ${shortTime(since)} (Claude session)`,
            origin: 'session',
          };
          // Where the last run begins. The user's own last request first — that is the
          // question being asked ("what did it do about what I just sent?"). Only when no
          // request can be found does the idle-gap heuristic stand in.
          const runSince =
            (await lastRequestStart(session)) ??
            (await lastRunStart(session, Math.max(1, this.gapMinutes()) * 60 * 1000));
          if (Date.parse(runSince) > Date.parse(since)) {
            const runBase = await this.commitAt(runSince);
            if (runBase) resolved.run = { base: runBase, since: runSince };
          } else {
            // The whole session is one run: "the last run" and "the session" coincide.
            resolved.run = { base: sha, since };
          }
          return resolved;
        }
      }
    } catch (err) {
      this.logger.trace(`session-based base unavailable: ${String(err)}`);
    }

    // No session to go on. Everything this worktree has that the remote does not is the
    // best answer to "what changed here" — and it includes local commits, which a plain
    // HEAD comparison would hide.
    try {
      const floor = await this.publishedFloor();
      if (floor) {
        const head = await this.head();
        const label = floor === head ? 'since the last commit' : 'all local changes';
        return { base: floor, label, origin: floor === head ? 'head' : 'local' };
      }
    } catch (err) {
      this.logger.trace(`no published floor available: ${String(err)}`);
    }

    try {
      const head = await this.head();
      if (head) return { base: head, label: 'since the last commit', origin: 'head' };
    } catch (err) {
      this.logger.warn('could not resolve HEAD', err);
    }
    return undefined;
  }

  /**
   * What HEAD pointed at, at `since`. The reflog is asked first because it records HEAD
   * movements with their own timestamps and therefore survives amends and rebases, which
   * rewrite committer dates and would otherwise make a `--before` search come up empty.
   * Every fallback widens the range: showing too much beats hiding the agent's work.
   */
  private async commitAt(since: string): Promise<string | undefined> {
    const candidates: Array<() => Promise<string>> = [
      () => this.run(['rev-parse', '-q', '--verify', `HEAD@{${since}}`]),
      () => this.run(['rev-list', '-1', `--before=${since}`, 'HEAD']),
      // Oldest reflog entry — the widest view that is still this worktree's own history.
      // (`rev-list --reverse --walk-reflogs` is rejected by git, hence `reflog show`.)
      // The root commit is deliberately NOT a fallback: diffing from it lists the entire
      // project, which looks like a broken feature rather than a review.
      () => this.run(['reflog', 'show', '--format=%H', 'HEAD']).then((out) => lastLine(out)),
    ];
    for (const attempt of candidates) {
      try {
        const sha = (await attempt()).trim().split('\n')[0]?.trim();
        if (sha) return await this.clampToPublished(sha);
      } catch {
        // try the next strategy
      }
    }
    return undefined;
  }

  /**
   * The newest commit that is already published — where this worktree's own work begins.
   *
   * This is the floor for every automatic base. Without it a session that started before
   * a `git pull` is told that every file the pull brought in is part of "what changed":
   * thousands of files of other people's work. Measured against real worktrees, an
   * unclamped base reported 2353 changed files where the honest answer was none.
   *
   * `merge-base` against the tracking branch also *includes* commits the agent made but
   * has not pushed, which a plain `diff HEAD` would miss entirely.
   */
  private async publishedFloor(): Promise<string | undefined> {
    if (this.floorCache && Date.now() - this.floorCache.at < REF_CACHE_MS) return this.floorCache.sha;
    const sha = await this.computePublishedFloor();
    this.floorCache = { at: Date.now(), sha };
    return sha;
  }

  private async computePublishedFloor(): Promise<string | undefined> {
    // Asked all at once and then preferred in order: these are alternatives, and most of
    // them do not exist in a given repo, so trying them in sequence pays for every miss.
    const refs = ['@{upstream}', 'origin/HEAD', 'origin/main', 'origin/master'];
    const results = await Promise.all(
      refs.map(async (ref) => {
        try {
          return (await this.run(['merge-base', 'HEAD', ref])).trim().split('\n')[0]?.trim() || undefined;
        } catch {
          return undefined; // ref does not exist here
        }
      }),
    );
    return results.find((sha) => sha !== undefined);
  }

  /** Never review further back than the last published commit. */
  private async clampToPublished(base: string): Promise<string> {
    const floor = await this.publishedFloor();
    if (!floor || floor === base) return base;
    if (await this.isAncestor(base, floor)) {
      this.logger.info(`base ${base.slice(0, 8)} predates the last published commit; using ${floor.slice(0, 8)}`);
      return floor;
    }
    return base;
  }

  /** HEAD, reused briefly: it only moves on commit, and every caller pays a spawn. */
  private async head(): Promise<string> {
    if (this.headCache && Date.now() - this.headCache.at < REF_CACHE_MS) return this.headCache.sha;
    const sha = (await this.run(['rev-parse', 'HEAD'])).trim();
    if (sha) this.headCache = { at: Date.now(), sha };
    return sha;
  }

  private async isAncestor(maybeOlder: string, maybeNewer: string): Promise<boolean> {
    try {
      await this.run(['merge-base', '--is-ancestor', maybeOlder, maybeNewer]);
      return true;
    } catch {
      return false; // non-zero exit: not an ancestor
    }
  }

  // ── queries ───────────────────────────────────────────────────────────

  /** Changed files (tracked + untracked) with a short label. Cached for a couple of seconds. */
  async summary(): Promise<RangeSummary | undefined> {
    if (this.cache) {
      const age = Date.now() - this.cache.at;
      if (age < MIN_RECOMPUTE_MS) return this.cache.summary;
      if (!this.stale && age < CACHE_MS) return this.cache.summary;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.computeSummary().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async computeSummary(): Promise<RangeSummary | undefined> {
    const t0 = Date.now();
    const resolved = await this.resolveBase();
    const tBase = Date.now();
    if (!resolved) return undefined;
    const files = new Set<string>();
    let untrackedNow: string[] = [];
    let unavailable = false;
    try {
      // Both listings are independent reads, and a `git` spawn costs far more in latency
      // than in work — measured at ~0.18s each when run one after another.
      const [tracked, untrackedFiles] = await Promise.all([
        // --name-only (not hunk parsing) so deletions, renames and mode changes all count.
        this.changedSince(resolved.base),
        this.untracked(),
      ]);
      for (const f of tracked) files.add(f);
      // Files that were already untracked when a baseline was pinned are not part of the
      // snapshot, so they would otherwise show as "changed" forever. Hide them only while
      // they stay untouched: an edit after the pin is exactly what we want to review.
      const pinned = this.store.baseline;
      const preexisting = new Set(pinned?.untracked ?? []);
      const pinnedAt = pinned ? Date.parse(pinned.at) : Number.NaN;
      untrackedNow = untrackedFiles;
      for (const file of untrackedNow) {
        if (preexisting.has(file) && Number.isFinite(pinnedAt) && !(await this.modifiedAfter(file, pinnedAt))) {
          continue;
        }
        files.add(file);
      }
    } catch (err) {
      // "0 files changed" and "could not read the file list" look identical in the panel
      // otherwise, and the second one silently hides the agent's entire run.
      unavailable = true;
      this.reportListFailure(resolved.base, err);
    }
    const tFiles = Date.now();
    const all = [...files].sort();

    let recent: string[] | undefined;
    let recentSince: string | undefined;
    let recentSource: RangeSummary['recentSource'] = 'mtime';
    if (resolved.run && !unavailable) {
      try {
        const inRun = await this.filesInRun(all, resolved.run, untrackedNow);
        recent = inRun.files;
        recentSince = resolved.run.since;
        recentSource = inRun.attributed ? 'hook' : 'transcript';
      } catch (err) {
        this.logger.trace(`run-scoped diff unavailable, falling back to mtimes: ${String(err)}`);
      }
    }
    if (!recent) {
      const burst = await this.lastRun(all);
      recent = burst.files;
      recentSince = burst.since ? new Date(burst.since).toISOString() : undefined;
    }

    const summary: RangeSummary = {
      base: resolved.base,
      label: resolved.label,
      origin: resolved.origin,
      files: all,
      fileCount: all.length,
      recent,
      recentCount: recent.length,
      recentLabel: recentSince ? `in the last run (since ${shortTime(recentSince)})` : 'in the last run',
      olderCount: all.length - recent.length,
      recentSource,
    };
    if (unavailable) summary.unavailable = true;
    // Logged only when it is slow enough to be felt, so a report of "the panel is laggy"
    // comes with the breakdown instead of guesswork.
    const total = Date.now() - t0;
    if (total > SLOW_SUMMARY_MS) {
      this.logger.info(
        `changes computed in ${total}ms — base ${tBase - t0}ms, files ${tFiles - tBase}ms, run ${Date.now() - tFiles}ms ` +
          `(${all.length} changed, ${recent.length} in the last run, via ${recentSource})`,
      );
    }
    this.cache = { at: Date.now(), summary };
    this.stale = false;
    return summary;
  }

  /** Gather the inputs `selectRunFiles` needs, then let it apply the rules. */
  private async filesInRun(
    files: readonly string[],
    run: { base: string; since: string },
    untracked: readonly string[],
  ): Promise<{ files: string[]; attributed: boolean }> {
    const since = Date.parse(run.since);
    // The stats do not depend on the commit lookups, so start everything at once.
    const statsPromise = Promise.all(files.map(async (f) => [f, await this.mtimeOf(f)] as const));
    const head = await this.head();
    const committed = new Set(head && head !== run.base ? await this.changedBetween(run.base, head) : []);
    const mtimes = new Map<string, number | undefined>(await statsPromise);

    // The hook, when it is installed, is the only signal that distinguishes the agent's
    // edits from yours or a formatter's.
    const root = await this.repoRoot();

    // The run-start snapshot answers this precisely for files that were already modified
    // when the request was submitted — the case git cannot help with.
    this.snapshot = root ? await this.snapshotFor(root) : undefined;

    // A snapshot older than the run it is meant to describe means the hook did not fire for
    // this request — uninstalled, a session started before it was set up, or writing
    // somewhere else. Trusting it reports the *previous* run's edits as this one's, which is
    // the exact failure this whole mechanism exists to prevent.
    if (this.snapshot) {
      const snapAt = Date.parse(this.snapshot.at);
      const runAt = Date.parse(run.since);
      if (Number.isFinite(snapAt) && Number.isFinite(runAt) && snapAt < runAt - SNAPSHOT_TOLERANCE_MS) {
        this.logger.info(
          `ignoring a snapshot from ${this.snapshot.at}: the run started at ${run.since}, so the hook did not record this request`,
        );
        this.snapshot = undefined;
      }
    }

    if (this.snapshot && root) {
      const snap = this.snapshot;
      const snapAt = Date.parse(snap.at);
      const verdicts = await Promise.all(
        files.map(async (f) => {
          // Covered by the snapshot: compare the bytes, which is exact.
          if (snap.has(f)) return [f, await differsFromSnapshot(snap, root, f)] as const;
          // Not covered — it was clean when the run began, or it is untracked, which the
          // snapshot deliberately does not list. Date it against the run's start instead of
          // assuming it belongs to this run.
          const mtime = await this.mtimeOf(f);
          if (mtime === undefined) return [f, true] as const; // deleted: always worth seeing
          return [f, mtime >= snapAt - RUN_GRACE_MS] as const;
        }),
      );
      return {
        files: verdicts.filter(([, changed]) => changed).map(([f]) => f),
        attributed: true,
      };
    }

    let attributed: Set<string> | undefined;
    if (root) {
      // Newest hints only: this reads a log file per candidate, and hints accumulate for as
      // long as the window stays open.
      const cwds = [root, ...[...this.cwdHints].slice(-MAX_CWD_HINTS)];
      for (const cwd of new Set(cwds)) {
        const found = await touchedPathsSince(cwd, root, since - RUN_GRACE_MS);
        if (found) {
          attributed = attributed ? new Set([...attributed, ...found]) : found;
        }
      }
    }

    const selection: Parameters<typeof selectRunFiles>[1] = {
      committed,
      mtimeOf: (f) => mtimes.get(f),
      since,
    };
    // Only trust attribution that actually says something. An empty log is ambiguous — the
    // agent may have changed nothing, or the hook may not have fired at all (installed after
    // this session started, a different settings profile) — and treating silence as "nothing
    // changed" would hide the whole run.
    const trusted = attributed !== undefined && attributed.size > 0;
    if (trusted && attributed) {
      selection.attributed = attributed;
      selection.untracked = new Set(untracked);
    }
    return { files: selectRunFiles(files, selection), attributed: trusted };
  }

  /**
   * The run-start snapshot for this repository.
   *
   * The repository root is preferred outright rather than taking the newest of several
   * candidates: the hook keys its state by the root, and earlier versions keyed it by the
   * agent's working directory — so a subdirectory can still hold a stale, often empty,
   * snapshot whose timestamp would beat the real one.
   */
  private async snapshotFor(root: string): Promise<RunSnapshot | undefined> {
    const atRoot = await readSnapshot(root);
    if (atRoot) return atRoot;
    for (const cwd of [...this.cwdHints].slice(-MAX_CWD_HINTS)) {
      const found = await readSnapshot(cwd);
      if (found) return found;
    }
    return undefined;
  }

  /** Tracked paths that differ between two commits — what was committed during the run. */
  private async changedBetween(from: string, to: string): Promise<string[]> {
    const out = await this.run(['diff', '--name-only', '--no-color', from, to, '--']);
    return out.split('\n').map((f) => f.trim()).filter(Boolean);
  }

  private async mtimeOf(file: string): Promise<number | undefined> {
    const root = await this.repoRoot();
    if (!root) return undefined;
    try {
      return (await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, file)))).mtime;
    } catch {
      return undefined;
    }
  }

  /** Tracked paths that differ between `base` and the working tree (staged or not). */
  private async changedSince(base: string): Promise<string[]> {
    const out = await this.run(['diff', '--name-only', '--no-color', base, '--']);
    return out.split('\n').map((f) => f.trim()).filter(Boolean);
  }

  /**
   * New files git does not know about yet.
   *
   * `ls-files --others --exclude-standard` walks the whole working tree applying gitignore —
   * 823-1203ms in a 42k-file repo — so the answer is reused until it can have changed. Only
   * a file being created or deleted can change it; editing one cannot. A time limit backs
   * that up in case a watcher event is missed.
   *
   * The git extension's own state was tried here and is not usable: it opens repositories
   * asynchronously, so both `getRepository` and the change arrays are empty for a while
   * after startup, and an empty answer cannot be told from "not scanned yet".
   */
  private async untracked(): Promise<string[]> {
    const fresh = this.untrackedCache && Date.now() - this.untrackedCache.at < UNTRACKED_TTL_MS;
    if (this.untrackedCache && !this.untrackedDirty && fresh) return this.untrackedCache.files;

    // Known answer, even a stale one: hand it back and correct it in the background. This
    // walk measured 1.2-2.7s in a 42k-file repo and was the single largest part of a
    // recomputation, so blocking on it makes every refresh feel slow to save a second or two
    // of accuracy about files that have only just appeared.
    // Never blocked on, not even the first time. The walk is started and whatever is known
    // so far is returned; when it lands, `invalidate` re-renders with the full list. The
    // alternative is a panel that shows nothing for three seconds after opening a large
    // repository, to be accurate about files that were created moments ago.
    void this.refreshUntracked();
    return this.untrackedCache?.files ?? [];
  }

  /** One walk at a time; re-renders if the answer actually moved. */
  private async refreshUntracked(): Promise<string[]> {
    if (this.untrackedRefresh) return this.untrackedRefresh;
    this.untrackedRefresh = (async () => {
      try {
        const out = await this.run(['ls-files', '--others', '--exclude-standard']);
        const files = out.split('\n').map((f) => f.trim()).filter(Boolean);
        const changed =
          this.untrackedCache === undefined ||
          this.untrackedCache.files.length !== files.length ||
          files.some((f, i) => this.untrackedCache?.files[i] !== f);
        this.untrackedCache = { at: Date.now(), files };
        this.untrackedDirty = false;
        if (changed && this.cache) this.invalidate(true);
        return files;
      } catch (err) {
        this.logger.trace(`could not list untracked files: ${String(err)}`);
        this.untrackedDirty = false; // do not spin on a failing repo
        return [];
      } finally {
        this.untrackedRefresh = undefined;
      }
    })();
    return this.untrackedRefresh;
  }

  /** Report a failed file listing once per base, not on every 2-second cache miss. */
  private reportListFailure(base: string, err: unknown): void {
    if (this.reportedFailure === base) {
      this.logger.trace(`still cannot list changed files for ${base}`);
      return;
    }
    this.reportedFailure = base;
    void this.logger.reportError(`could not list the files changed since ${base.slice(0, 8)}`, err);
  }

  private async modifiedAfter(file: string, since: number): Promise<boolean> {
    const root = await this.repoRoot();
    if (!root) return true;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, file)));
      return stat.mtime > since;
    } catch {
      return true; // gone, or unreadable: treat as changed rather than hide it
    }
  }

  /**
   * The trailing cluster of modification times. Files that no longer exist (deleted) are
   * always included: there is no mtime to place them, and a deletion is exactly the kind
   * of change you want to see.
   */
  private async lastRun(files: readonly string[]): Promise<{ files: string[]; since?: number }> {
    const root = await this.repoRoot();
    if (!root || files.length === 0) return { files: [...files] };
    const gapMs = Math.max(1, this.gapMinutes()) * 60 * 1000;
    const stamped: Array<{ file: string; mtime: number | undefined }> = [];
    for (const file of files) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, file)));
        stamped.push({ file, mtime: stat.mtime });
      } catch {
        stamped.push({ file, mtime: undefined }); // deleted
      }
    }
    const dated = stamped.filter((s): s is { file: string; mtime: number } => s.mtime !== undefined);
    const undated = stamped.filter((s) => s.mtime === undefined).map((s) => s.file);
    if (dated.length === 0) return { files: [...files] };
    dated.sort((a, b) => b.mtime - a.mtime);
    const cluster: string[] = [];
    let previous = dated[0]?.mtime ?? 0;
    let since = previous;
    for (const entry of dated) {
      if (previous - entry.mtime > gapMs) break;
      cluster.push(entry.file);
      previous = entry.mtime;
      since = entry.mtime;
    }
    return { files: [...cluster, ...undated].sort(), since };
  }

  private gapMinutes(): number {
    // `localReview.*` is still honoured after the rename, same as everywhere else.
    const v =
      vscode.workspace.getConfiguration('redline').get<number>('lastRunGapMinutes') ??
      vscode.workspace.getConfiguration('localReview').get<number>('lastRunGapMinutes') ??
      DEFAULT_RUN_GAP_MS / 60_000;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_RUN_GAP_MS / 60_000;
  }

  /** Absolute URIs of the changed files (the last run's, or all of them). */
  async changedUris(scope: 'recent' | 'all' = 'all'): Promise<vscode.Uri[]> {
    const root = await this.repoRoot();
    const summary = await this.summary();
    if (!root || !summary) return [];
    const files = scope === 'recent' ? summary.recent : summary.files;
    return files.map((f) => vscode.Uri.file(path.join(root, f)));
  }

  /** Left/right pairs for VS Code's multi-file diff editor. */
  async diffResources(scope: 'recent' | 'all' = 'all'): Promise<Array<[vscode.Uri, vscode.Uri | undefined, vscode.Uri]>> {
    const summary = await this.summary();
    if (!summary) return [];
    const api = await this.git?.getApi();
    const root = await this.repoRoot();
    const uris = await this.changedUris(scope);
    // For the last run, compare against the snapshot taken when the request was submitted:
    // otherwise a file edited in an earlier run shows those older lines here too, which is
    // not "what changed in the last run" by any reading.
    const snapshot = scope === 'recent' ? this.snapshot : undefined;
    return uris.map((uri) => {
      let original: vscode.Uri | undefined;
      const rel = root ? path.relative(root, uri.fsPath) : undefined;
      const stored = snapshot && rel !== undefined ? snapshot.storedPath(rel) : undefined;
      if (stored !== undefined) return [uri, vscode.Uri.file(stored), uri];
      try {
        original = api?.toGitUri(uri, summary.base);
      } catch {
        original = undefined;
      }
      return [uri, original, uri];
    });
  }

  /** Changed line ranges, for walking hunk by hunk. */
  async hunks(): Promise<Hunk[]> {
    const root = await this.repoRoot();
    const summary = await this.summary();
    if (!root || !summary) return [];
    // Keyed by the snapshot too: the ranges differ entirely depending on which side the
    // comparison uses, so a new run must not reuse the previous run's hunks.
    const key = `${summary.base}::${this.snapshot?.at ?? ''}`;
    if (this.hunkCache?.base === key) return this.hunkCache.hunks;
    const startedAt = Date.now();
    const out: Hunk[] = [];
    const fromSnapshot = new Set<string>();
    try {
      // Files the run-start snapshot covers: compare against that copy, so navigation agrees
      // with the diff the panel opens instead of walking earlier runs' lines as well.
      if (this.snapshot) {
        const snap = this.snapshot;
        const covered = summary.recent.filter((f) => snap.has(f));
        const results = await Promise.all(
          covered.map(async (rel) => {
            const stored = snap.storedPath(rel);
            if (stored === undefined) return undefined;
            try {
              // `--no-index` compares two paths outside the repository; it exits 1 when they
              // differ, which `run` surfaces as a throw, so the output is read either way.
              const diff = await this.run(['diff', '--no-index', '-U0', '--no-color', stored, path.join(root, rel)]);
              return { rel, ranges: parseHunks(diff) };
            } catch (err) {
              const stdout = (err as { stdout?: string }).stdout;
              return typeof stdout === 'string' ? { rel, ranges: parseHunks(stdout) } : undefined;
            }
          }),
        );
        for (const r of results) {
          if (!r) continue;
          fromSnapshot.add(r.rel);
          for (const range of r.ranges) {
            out.push({ uri: vscode.Uri.file(path.join(root, r.rel)), start: range.start, end: range.end });
          }
        }
      }

      const diff = await this.run(['diff', '-U0', '--no-color', summary.base, '--']);
      for (const file of parseDiffByFile(diff)) {
        if (fromSnapshot.has(file.path)) continue; // already covered, more precisely
        for (const h of file.hunks) {
          const hunk: Hunk = { uri: vscode.Uri.file(path.join(root, file.path)), start: h.start, end: h.end };
          if (h.deletion) hunk.deletion = true;
          out.push(hunk);
        }
      }
      // A new file has no diff to parse, so its whole body is the hunk. The listing comes
      // from the cached accessor: calling `ls-files` here was costing 1-2.6s in a large
      // repository, which is what made the first `⌥F7` feel broken.
      const changed = new Set(summary.files);
      const newFiles = (await this.untracked()).filter((rel) => changed.has(rel));
      const counted = await Promise.all(
        newFiles.map(async (rel) => {
          const uri = vscode.Uri.file(path.join(root, rel));
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            // Reading a large file only to count its lines is not worth it; one range
            // covering the start is enough to navigate to it.
            if (stat.size > MAX_NEW_FILE_SCAN_BYTES) return { uri, lines: 1 };
            const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            return { uri, lines: Math.max(1, text.split('\n').length) };
          } catch {
            return { uri, lines: 1 };
          }
        }),
      );
      for (const { uri, lines } of counted) out.push({ uri, start: 0, end: lines - 1 });
    } catch (err) {
      this.logger.warn('could not compute hunks', err);
    }
    out.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath) || a.start - b.start);
    const took = Date.now() - startedAt;
    if (took > SLOW_SUMMARY_MS) this.logger.info(`hunks computed in ${took}ms (${out.length} hunks)`);
    this.hunkCache = { base: key, hunks: out };
    return out;
  }

  /** Jump to the next / previous changed hunk (wraps across files). */
  async walk(direction: 1 | -1, scope: 'recent' | 'all' = 'recent'): Promise<boolean> {
    const all = await this.hunks();
    let hunks = all;
    if (scope === 'recent') {
      const uris = new Set((await this.changedUris('recent')).map((u) => u.toString()));
      const filtered = all.filter((h) => uris.has(h.uri.toString()));
      if (filtered.length > 0) hunks = filtered;
    }
    if (hunks.length === 0) return false;
    const ed = vscode.window.activeTextEditor;

    const pick = (from: readonly Hunk[]): Hunk | undefined => {
      if (from.length === 0) return undefined;
      if (!ed) return direction === 1 ? from[0] : from[from.length - 1];
      const here = ed.document.uri.fsPath;
      const line = ed.selection.active.line;
      // Must agree with the localeCompare ordering above or navigation skips files.
      const cmp = (h: Hunk): number => {
        const byPath = h.uri.fsPath.localeCompare(here);
        if (byPath !== 0) return -byPath;
        return h.start === line ? 0 : h.start < line ? 1 : -1;
      };
      return direction === 1
        ? (from.find((h) => cmp(h) < 0) ?? from[0])
        : ([...from].reverse().find((h) => cmp(h) > 0) ?? from[from.length - 1]);
    };

    // A hunk can name a file that is no longer there: a deletion, or something removed since
    // the hunks were computed. Skip past those rather than failing the whole command.
    let remaining = hunks;
    for (let attempt = 0; attempt < WALK_ATTEMPTS && remaining.length > 0; attempt++) {
      const target = pick(remaining);
      if (!target) return false;
      try {
        const doc = await vscode.workspace.openTextDocument(target.uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const range = new vscode.Range(target.start, 0, Math.min(target.end, doc.lineCount - 1), 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.selection = new vscode.Selection(range.start, range.start);
        return true;
      } catch (err) {
        this.logger.trace(`skipping ${target.uri.fsPath}: ${String(err)}`);
        const gone = target.uri.toString();
        remaining = remaining.filter((h) => h.uri.toString() !== gone);
        // The cached hunks describe a tree that has moved on.
        this.hunkCache = undefined;
      }
    }
    return false;
  }

  // ── invalidation ──────────────────────────────────────────────────────

  /**
   * @param force drop the cached summary outright. Used when the user asked for fresh data
   *   (Refresh, opening a diff); a watcher event marks it stale instead, so the recompute
   *   floor can absorb a storm of them.
   */
  invalidate(force = false): void {
    this.stale = true;
    if (force) this.cache = undefined;
    this.hunkCache = undefined;
    this._onDidChange.fire();
  }

  /**
   * Also drop the (expensive) base resolution — the run boundary lives there, so a stale
   * one is what makes the panel report figures from half a minute ago.
   *
   * @param force skip the recompute floor. True for a one-off the user is waiting on (a
   *   pinned baseline); false for a repeating signal such as the agent touching files,
   *   where the floor is the only thing keeping a long run from respawning git constantly.
   */
  invalidateBase(force = true): void {
    this.baseCache = undefined;
    this.untrackedDirty = true;
    this.floorCache = undefined;
    this.headCache = undefined;
    this.invalidate(force);
  }

  private invalidateSoon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.invalidate();
    }, 800);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
    this._onDidChange.dispose();
  }
}

function lastLine(out: string): string {
  const lines = out.split('\n').filter((l) => l.trim());
  return lines[lines.length - 1] ?? '';
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
