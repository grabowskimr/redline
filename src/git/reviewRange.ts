import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger';
import { ReviewStore } from '../store/reviewStore';
import { Config } from '../config';
import { roundStart } from '../model/note';
import { GitService } from './gitApi';
import { lastRequestStart, lastRunStart, latestSessionAmong, reviewWindowStart } from '../claude/transcripts';
import { parseDiffByFile, parseHunks } from './hunks';
import { RUN_GRACE_MS, selectRunFiles } from './runFiles';
import { touchedPathsSince } from '../claude/touched';
import { differsFromSnapshot, readSnapshot, RunSnapshot } from '../claude/snapshot';
import { PastRun, readRunTrees, RunTree, RunTrees } from '../claude/runTrees';
import { binaryPaths, GitRunner, nulFields, snapshotWorkingTree, treeChanges, TreeChange } from './snapshotTree';
import { treeSide } from './treeSide';

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

/**
 * Scheme for the empty side of a comparison.
 *
 * An added file has nothing at the base and a deleted one has nothing now. `vscode.changes`
 * accepts an absent resource for that, but the multi-file editor renders a missing side
 * poorly — a repeated header over sliced content. A real, empty, read-only document is a
 * side it can lay out like any other, and it reads correctly: everything added, or
 * everything removed.
 */
export const EMPTY_SIDE_SCHEME = 'redline-empty';

/**
 * An empty stand-in that keeps the real path visible in the editor's title.
 *
 * `note` is appended to the file name, which is what the multi-file diff shows above each
 * entry — so "MissingBandAlert.tsx (new file)" beside the real name says what happened without
 * having to open it. Only ever applied to the empty side, so the mangled extension costs
 * nothing: there is no content to highlight.
 */
export function emptySide(uri: vscode.Uri, note?: string): vscode.Uri {
  const path = note ? `${uri.path} (${note})` : uri.path;
  return uri.with({ scheme: EMPTY_SIDE_SCHEME, path, query: '', fragment: '' });
}

/** Serves nothing, for the side of a comparison that does not exist. */
export function registerEmptySideProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(EMPTY_SIDE_SCHEME, {
    provideTextDocumentContent: () => '',
  });
}

/** What happened to a path between two points. Decides which sides a diff has. */
type ChangeStatus = TreeChange;

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
 * How long a snapshot of the working tree is reused for.
 *
 * Taking one costs about a second in a 42k-file repository — the same walk the untracked
 * listing used to cost, and it replaces it. The run's own end is snapshotted by the hook and
 * costs nothing to read, so this only paces the panel while the agent is still writing.
 */
const TREE_CACHE_MS = 4_000;

/**
 * How long "this is not a git repository" is believed for. Short, because `git init` should
 * not need a window reload — long enough that a folder without a repository costs nothing.
 */
const ROOT_MISS_MS = 30_000;
/** Finding the root is one cheap call; anything longer means git is wedged. */
const ROOT_TIMEOUT_MS = 10_000;

/** Beyond this a snapshot is not worth waiting for, and the older signals cover the gap. */
/**
 * How long any single git call may take before it is killed.
 *
 * Generous: `git add -A` over a 42,000-file monorepo is measured at about two seconds warm and
 * six and a half cold, and a `diff` over a large range is slower still. This is the "something
 * is stuck" boundary, not a performance budget.
 */
export const GIT_TIMEOUT_MS = 60_000;

/** How many git processes may run at once for a per-file fan-out. */
const GIT_FANOUT = 8;

/** How many files may be read whole at once. Both sides of each, so this is 2× in memory. */
const FILE_FANOUT = 16;

/** `Promise.all` with a ceiling, in source order. */
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

const SNAPSHOT_TIMEOUT_MS = 30_000;

/**
 * How long a snapshot is trusted once the working tree is known to have moved on.
 *
 * A tree nothing has changed since is not stale at all, however old it is — which is the
 * common case, and why an idle window takes no snapshots. This only bounds the other
 * direction: if snapshotting starts failing, an answer that is quietly out of date is worse
 * than falling back to signals that correct themselves.
 */
const TREE_STALE_MS = 60_000;

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
 *   1. a baseline the user pinned explicitly (Pin Baseline Here),
 *   2. the commit HEAD pointed at when the current Claude Code session started — so work
 *      the agent committed *during* the session is included,
 *   3. the published floor: `merge-base HEAD <upstream>`, everything this worktree has that
 *      the remote does not. This is what answers for a repository opened cold, with no
 *      session to read, which is the common case.
 *   4. HEAD — i.e. every uncommitted change.
 *
 * Comparing a commit against the working tree always includes uncommitted work, so all four
 * hold even when VS Code is opened long after the agent finished.
 *
 * `docs/review-range.md` covers this, and the run boundary, at more length.
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
  /** Per-path status behind the current summary: which sides of a comparison exist. */
  private statuses = new Map<string, ChangeStatus>();
  /** The same, measured from the start of the last run rather than from the base. */
  private runStatuses = new Map<string, ChangeStatus>();
  /**
   * The pair of tree snapshots the current summary was computed from, when the hook made one
   * available. Also what the diff editor compares against, so the panel's counts and the
   * diff it opens can never disagree.
   */
  private treeState: { base: string; before: string; now: string } | undefined;
  /** Our own snapshot of the working tree, and when it was taken. */
  private treeSnap: { at: number; tree: string } | undefined;
  private treeInFlight: Promise<void> | undefined;
  /** When the working tree last changed, so a snapshot can be known to still describe it. */
  private lastChangeAt = 0;
  private binaryCache: { key: string; paths: Set<string> } | undefined;
  private snapshots = 0;
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
  private rootCache: { at: number; root: string | undefined } | undefined;
  private headCache: { at: number; sha: string } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ReviewStore,
    private readonly logger: Logger,
    private readonly git?: GitService,
    /** Optional so the range can be built before settings are, as the tests do. */
    private readonly config?: Config,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
    const onFsEvent = (uri: vscode.Uri): void => {
      // Build output and VCS internals churn constantly while an agent works; recomputing
      // the range for those would keep the panel busy for no benefit.
      if (IGNORED_PATH.test(uri.path)) return;
      this.lastChangeAt = Date.now();
      this.invalidateSoon();
    };
    // Editing a file cannot change which files are untracked; creating or deleting one can.
    const onFsAddOrRemove = (uri: vscode.Uri): void => {
      if (IGNORED_PATH.test(uri.path)) return;
      this.lastChangeAt = Date.now();
      this.untrackedDirty = true;
      this.invalidateSoon();
    };
    this.subs.push(
      watcher,
      watcher.onDidChange(onFsEvent),
      watcher.onDidCreate(onFsAddOrRemove),
      watcher.onDidDelete(onFsAddOrRemove),
      vscode.workspace.onDidSaveTextDocument((d) => onFsEvent(d.uri)),
      // A folder added or removed can change which repository this is, or introduce one.
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.root = undefined;
        this.rootCache = undefined;
        this.invalidate(true);
      }),
      // Trust turns the whole feature on, and nothing has been computed until now.
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.root = undefined;
        this.rootCache = undefined;
        this.invalidate(true);
      }),
    );
    // Warmed in the background: the first list is the expensive one, and nobody should be
    // waiting on it when it happens.
    void this.refreshUntracked();
  }

  // ── git plumbing ──────────────────────────────────────────────────────

  private async run(args: string[], env?: Record<string, string>, timeoutMs?: number): Promise<string> {
    // A repository controls its own git configuration, `.gitattributes` filters and
    // `core.fsmonitor`, all of which git will execute. Running any of this before the user has
    // said they trust the folder would hand a hostile repository the ability to run code, so
    // the whole feature waits — which is what the manifest declares as "limited" support.
    if (!vscode.workspace.isTrusted) throw new Error('the workspace is not trusted');
    const root = await this.repoRoot();
    if (!root) throw new Error('not a git repository');
    // core.quotePath is on by default, which would return `"caf\303\251.ts"` for
    // `café.ts` — a path that then fails every stat, URI and open downstream.
    const { stdout } = await execFileP('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: root,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 32 * 1024 * 1024,
      // Every call is bounded, not only the ones that ask. A `git` that never returns — an
      // index lock held by another process, a network filesystem, a wedged `core.fsmonitor` —
      // used to pin the in-flight summary promise for the life of the window: the panel and
      // the status bar simply stopped updating, silently, with no way back but a reload.
      timeout: timeoutMs ?? GIT_TIMEOUT_MS,
    });
    return stdout;
  }

  /**
   * The runner shape the snapshot helpers take.
   *
   * Bounded, unlike the rest: staging the working tree is the one call here that walks every
   * file, and a `git` that never returns would otherwise leave the snapshot permanently in
   * flight — which reads as "the tree has not changed" rather than as a failure.
   */
  private get runner(): GitRunner {
    return (args, env) => this.run(args, env, SNAPSHOT_TIMEOUT_MS);
  }

  /** The repository root — `git diff` prints paths relative to it, not to the open folder. */
  async repoRoot(): Promise<string | undefined> {
    // Nothing that reads a repository runs before the folder is trusted, including this: it is
    // the gate every other path goes through, so refusing here makes the whole feature inert
    // rather than half-live.
    if (!vscode.workspace.isTrusted) return undefined;
    if (this.root) return this.root;
    // A negative answer is cached too, briefly. Without that, a window open on a folder that
    // is not a repository spawned `git rev-parse` on every call — and the workspace-wide
    // watcher makes those calls continuously while anything writes files.
    if (this.rootCache && Date.now() - this.rootCache.at < ROOT_MISS_MS) return this.rootCache.root;
    // Every folder, not just the first: in a multi-root workspace the repository is often not
    // the folder that happens to be listed first, and taking only that one left the whole
    // feature dead with no explanation.
    for (const folder of (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)) {
      try {
        const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], {
          cwd: folder,
          timeout: ROOT_TIMEOUT_MS,
        });
        const root = stdout.trim();
        if (root) {
          this.root = root;
          this.rootCache = { at: Date.now(), root };
          return root;
        }
      } catch {
        // not a repository, or git is unavailable; try the next folder
      }
    }
    this.rootCache = { at: Date.now(), root: undefined };
    return undefined;
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
        // Independent: one asks git which commit the window starts at, the other reads the
        // transcript for the last request. Run one after the other and the whole base
        // resolution waits for a `git` spawn *and* a file read that never needed each other.
        const [sha, request] = await Promise.all([this.commitAt(since), lastRequestStart(session)]);
        if (sha) {
          const resolved: ResolvedBase = {
            base: sha,
            label: `since ${shortTime(since)} (Claude session)`,
            origin: 'session',
          };
          // Where the last run begins. The round you are working through wins when one is
          // open — everything the agent has done since you sent it, however many messages that
          // took. Otherwise the user's own last request, which is the question being asked
          // ("what did it do about what I just sent?"), and only when neither can be found
          // does the idle-gap heuristic stand in.
          const asked = request ?? (await lastRunStart(session, Math.max(1, this.gapMinutes()) * 60 * 1000));
          /*
           * The round you are still working through, if one is open: the oldest send among the
           * notes you have not settled. Read straight from the store rather than held here, so
           * it cannot go stale — approving the last note puts the transcript back in charge on
           * the next resolve.
           */
          const round = roundStart(this.store.notes);
          const runSince =
            round && Number.isFinite(Date.parse(round)) && Date.parse(round) < Date.parse(asked)
              ? round
              : asked;
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
      // Both are cached and neither depends on the other; asking in sequence cost a spawn's
      // worth of latency for nothing.
      const [floor, head] = await Promise.all([this.publishedFloor(), this.head()]);
      if (floor) {
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

    // Two tree snapshots answer the whole question exactly, so they are tried first and
    // everything below is the fallback for when the hook is not installed.
    const fromTrees = await this.summaryFromTrees(resolved, t0, tBase);
    if (fromTrees) {
      this.cache = { at: Date.now(), summary: fromTrees };
      this.stale = false;
      return fromTrees;
    }

    const files = new Set<string>();
    let untrackedNow: string[] = [];
    let unavailable = false;
    try {
      // Both listings are independent reads, and a `git` spawn costs far more in latency
      // than in work — measured at ~0.18s each when run one after another.
      const [tracked, untrackedFiles] = await Promise.all([
        // --name-status (not hunk parsing) so deletions, renames and mode changes all count,
        // and so the diff knows which sides each path has.
        this.changedSinceWithStatus(resolved.base),
        this.untracked(),
      ]);
      this.statuses = tracked;
      for (const f of tracked.keys()) files.add(f);
      // Never tracked: an addition as far as any comparison is concerned.
      for (const f of untrackedFiles) this.statuses.set(f, { kind: 'added' });
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

    this.treeState = undefined;
    this.runStatuses.clear();
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

  /**
   * The summary, computed from a pair of tree snapshots.
   *
   * Undefined whenever the pair is not there or not usable, and the caller then falls back to
   * the older signals. The two are deliberately not blended: mixing an exact answer with a
   * heuristic one produces a third thing that is neither, and that is what the earlier
   * versions of this did.
   */
  private async summaryFromTrees(
    resolved: ResolvedBase,
    t0: number,
    tBase: number,
  ): Promise<RangeSummary | undefined> {
    if (!resolved.run) return undefined;
    const root = await this.repoRoot();
    if (!root) return undefined;
    const trees = await this.runTrees(root, resolved.run);
    const before = trees?.before;
    if (!before) return undefined;
    // Two sessions working in one repository overwrite each other's markers, so a "before"
    // recorded by one session and a "stop" from another describe different runs. Falling back
    // to the older signals gives a wider answer; pairing them would give a wrong one.
    const after = trees?.after;
    const pairedSession =
      before.session === undefined || after?.session === undefined || before.session === after.session;
    if (!pairedSession) {
      this.logger.info(
        `two sessions have run here: the snapshot is from ${before.session?.slice(0, 8)} and the stop from ` +
          `${after?.session?.slice(0, 8)}, so the last run is measured the slower way`,
      );
      return undefined;
    }
    const now = await this.currentTree(root, Date.parse(before.at), after);
    if (!now) return undefined;

    let all: Map<string, ChangeStatus>;
    let run: Map<string, ChangeStatus>;
    try {
      // Independent reads of the same object store; each is about 20ms.
      [all, run] = await Promise.all([
        treeChanges(resolved.base, now, this.runner),
        treeChanges(before.tree, now, this.runner),
      ]);
    } catch (err) {
      this.logger.trace(`could not compare snapshots, falling back: ${String(err)}`);
      return undefined;
    }
    const tFiles = Date.now();

    // Files that were already untracked when a baseline was pinned are not part of it, so
    // they would otherwise show as added forever. Hidden only while they stay untouched.
    const pinned = this.store.baseline;
    const preexisting = new Set(pinned?.untracked ?? []);
    const pinnedAt = pinned ? Date.parse(pinned.at) : Number.NaN;
    // Only the untracked files that were already there when a baseline was pinned need a
    // timestamp, and they were being stat-ed one at a time in a loop — serial latency for a
    // question every file can answer independently.
    const needsDating = [...all].filter(
      ([file, status]) => status.kind === 'added' && preexisting.has(file) && Number.isFinite(pinnedAt),
    );
    const dated = new Map(
      await Promise.all(needsDating.map(async ([file]) => [file, await this.modifiedAfter(file, pinnedAt)] as const)),
    );
    const files = [...all.keys()].filter((file) => dated.get(file) !== false).sort();

    // Everything the run touched, including a file it put *back* to its committed state —
    // which is what "remove the comment I added" looks like from here. That file differs from
    // nothing at the base, so it is legitimately absent from All while being the whole point
    // of Last. The two scopes answer different questions and neither contains the other:
    //
    //   All  — what differs from the base commit
    //   Last — what this run changed
    //
    // Filtering Last down to All was hiding exactly the changes a review had just produced.
    const recent = [...run.keys()].sort();
    const inRun = new Set(recent);

    this.statuses = all;
    this.runStatuses = run;
    this.treeState = { base: resolved.base, before: before.tree, now };
    this.snapshot = undefined; // the trees supersede it

    const summary: RangeSummary = {
      base: resolved.base,
      label: resolved.label,
      origin: resolved.origin,
      files,
      fileCount: files.length,
      recent,
      recentCount: recent.length,
      recentLabel: `in the last run (since ${shortTime(before.at)})`,
      // Files changed since the base that this run did not touch — not a subtraction of the
      // two counts, which no longer overlap completely.
      olderCount: files.filter((f) => !inRun.has(f)).length,
      recentSource: 'hook',
    };
    const total = Date.now() - t0;
    if (total > SLOW_SUMMARY_MS) {
      this.logger.info(
        `changes computed from snapshots in ${total}ms — base ${tBase - t0}ms, trees ${tFiles - tBase}ms ` +
          `(${files.length} changed, ${recent.length} in the last run)`,
      );
    }
    return summary;
  }

  /**
   * The tree recorded when this run's request was submitted.
   *
   * Checked against the run the transcript reports: a snapshot older than that belongs to an
   * earlier run, which would report the *previous* run's work as this one's — the exact
   * failure this mechanism exists to prevent. The hook writes it and the transcript records
   * the same moment, so the tolerance only absorbs clock jitter.
   */
  private async runTrees(root: string, run: { since: string }): Promise<RunTrees | undefined> {
    let trees = await readRunTrees(root);
    if (!trees) {
      for (const cwd of [...this.cwdHints].slice(-MAX_CWD_HINTS)) {
        trees = await readRunTrees(cwd);
        if (trees) break;
      }
    }
    const before = trees?.before;
    if (!before) return undefined;
    const snapAt = Date.parse(before.at);
    const runAt = Date.parse(run.since);
    if (Number.isFinite(snapAt) && Number.isFinite(runAt) && snapAt < runAt - SNAPSHOT_TOLERANCE_MS) {
      this.logger.info(
        `ignoring a snapshot from ${before.at}: the run started at ${run.since}, so the hook did not record this request`,
      );
      return undefined;
    }
    return trees;
  }

  /**
   * The working tree as it stands, as a tree object.
   *
   * Never blocked on. The hook's end-of-run snapshot is preferred whenever it is newer than
   * ours, which is the common case for someone reading the panel after the agent stops: the
   * answer is then two `diff-tree` calls and nothing else. Otherwise the last known tree is
   * returned and a new one is taken in the background — measured at 1.3s in a 42k-file repo
   * from a shell and over ten times that inside a busy extension host, which is far too long
   * to hold a refresh for. When there is no tree at all yet, this returns nothing and the
   * summary falls back to the older signals until one lands.
   */
  private async currentTree(root: string, runStartedAt: number, after: RunTree | undefined): Promise<string | undefined> {
    const afterAt = after ? Date.parse(after.at) : Number.NaN;
    // Only if it belongs to *this* run: while the agent is working, the newest stop marker is
    // the previous run's, and reading it as "now" would report that this run changed nothing.
    const belongsToRun = Number.isFinite(afterAt) && Number.isFinite(runStartedAt) && afterAt >= runStartedAt;
    if (after && belongsToRun && afterAt > (this.treeSnap?.at ?? 0)) {
      this.treeSnap = { at: afterAt, tree: after.tree };
      return after.tree;
    }
    const snap = this.treeSnap;
    if (snap) {
      const age = Date.now() - snap.at;
      // Nothing has changed since it was taken, so it is not merely fresh — it is exact.
      // This is what keeps an idle window from snapshotting at all. The time limit is the
      // same safety net the untracked listing has, in case a watcher event was missed.
      if (this.lastChangeAt <= snap.at && age < UNTRACKED_TTL_MS) return snap.tree;
      // Changed, but too recently to be worth another walk: pace it.
      if (age < TREE_CACHE_MS) return snap.tree;
      void this.refreshTree(root);
      // Serve the previous tree while the new one is taken, but not indefinitely: past this
      // the answer would be quietly wrong, and the older signals are self-correcting.
      return age < TREE_STALE_MS ? snap.tree : undefined;
    }
    void this.refreshTree(root);
    return undefined;
  }

  /**
   * How many snapshots have been taken. Each one walks the working tree, so this is the
   * number to watch if the panel ever feels expensive — and what the tests assert stays at
   * zero while nothing changes.
   */
  get snapshotCount(): number {
    return this.snapshots;
  }

  /** One snapshot at a time; re-renders if the tree actually moved. */
  private async refreshTree(root: string): Promise<void> {
    if (this.treeInFlight) return this.treeInFlight;
    this.snapshots++;
    this.treeInFlight = (async () => {
      const started = Date.now();
      const tree = await snapshotWorkingTree(root, this.runner, (why) =>
        this.logger.warn(`could not snapshot the working tree: ${why}`),
      );
      if (!tree) return;
      const moved = tree !== this.treeSnap?.tree;
      this.treeSnap = { at: started, tree };
      const took = Date.now() - started;
      if (took > SLOW_SUMMARY_MS) this.logger.trace(`snapshotted the working tree in ${took}ms`);
      if (moved && this.cache) this.invalidate(true);
    })().finally(() => {
      this.treeInFlight = undefined;
    });
    return this.treeInFlight;
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
      // In batches. Comparing bytes reads both sides of a file whole, so a two-hundred-file
      // run all at once is both copies of every one of them alive in the extension host at the
      // same moment — hundreds of megabytes, to answer a question about which files changed.
      const verdicts = await inBatches(files, FILE_FANOUT, async (f) => {
          // Covered by the snapshot: compare the bytes, which is exact.
          if (snap.has(f)) return [f, await differsFromSnapshot(snap, root, f)] as const;
          // Not covered — it was clean when the run began, or it is untracked, which the
          // snapshot deliberately does not list. Date it against the run's start, including
          // new files: one created two runs ago and untouched since is not this run's work.
          const mtime = await this.mtimeOf(f);
          if (mtime === undefined) return [f, true] as const; // deleted: always worth seeing
          return [f, mtime >= snapAt - RUN_GRACE_MS] as const;
      });
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
    return nulFields(await this.run(['diff', '--name-only', '-z', '--no-color', from, to, '--']));
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
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

  /**
   * Changed paths and what happened to each: `A` added, `D` deleted, `R` renamed (with the
   * path it came from), anything else modified.
   *
   * The status decides which sides of a comparison exist. Without it the diff was handed a
   * git URI at the base for a file that was *added* since — a ref that has no such path — so
   * the entry could not resolve and simply did not appear. Same shape of bug as handing it a
   * missing path for a file that was deleted.
   */
  private async changedSinceWithStatus(base: string): Promise<Map<string, ChangeStatus>> {
    const fields = nulFields(await this.run(['diff', '--name-status', '-z', '--no-color', base, '--']));
    const map = new Map<string, ChangeStatus>();
    for (let i = 0; i < fields.length; ) {
      const code = (fields[i++] ?? '').trim();
      if (!code) continue;
      // A rename is three records: the status, the old path and the new one.
      if (code.startsWith('R') || code.startsWith('C')) {
        const was = fields[i++];
        const now = fields[i++];
        if (now) map.set(now, was && code.startsWith('R') ? { kind: 'renamed', from: was } : { kind: 'added' });
        continue;
      }
      const p = fields[i++];
      if (!p) continue;
      map.set(
        p,
        code.startsWith('A') ? { kind: 'added' } : code.startsWith('D') ? { kind: 'deleted' } : { kind: 'modified' },
      );
    }
    return map;
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
        const files = nulFields(await this.run(['ls-files', '--others', '--exclude-standard', '-z']));
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
    // Through `Config`, like every other setting: reading the section directly meant the
    // `localReview.*` fallback beside it could never fire, because a key with a manifest
    // default never comes back undefined.
    return this.config?.lastRunGapMinutes ?? DEFAULT_RUN_GAP_MS / 60_000;
  }

  /** Absolute URIs of the changed files (the last run's, or all of them). */
  async changedUris(scope: 'recent' | 'all' = 'all'): Promise<vscode.Uri[]> {
    const root = await this.repoRoot();
    const summary = await this.summary();
    if (!root || !summary) return [];
    const files = scope === 'recent' ? summary.recent : summary.files;
    return files.map((f) => vscode.Uri.file(path.join(root, f)));
  }

  /** Binary paths for one comparison, remembered so opening a diff twice costs one call. */
  private async binaryIn(from: string, to: string): Promise<Set<string>> {
    const key = `${from}..${to}`;
    if (this.binaryCache?.key === key) return this.binaryCache.paths;
    const paths = await binaryPaths(from, to, this.runner);
    this.binaryCache = { key, paths };
    return paths;
  }

  /**
   * What happened to the files in a scope: how many arrived, went, moved or were edited.
   *
   * For the title of the diff, which otherwise says only how many files there are — and a
   * deletion reads exactly like an edit until you open it.
   */
  async statusBreakdown(scope: 'recent' | 'all'): Promise<string> {
    const summary = await this.summary();
    if (!summary) return '';
    const files = scope === 'recent' ? summary.recent : summary.files;
    const from = scope === 'recent' && this.runStatuses.size > 0 ? this.runStatuses : this.statuses;
    const counts = { added: 0, deleted: 0, renamed: 0, modified: 0 };
    for (const f of files) counts[from.get(f)?.kind ?? 'modified']++;
    const parts = [
      counts.added ? `${counts.added} new` : '',
      counts.deleted ? `${counts.deleted} deleted` : '',
      counts.renamed ? `${counts.renamed} moved` : '',
      counts.modified ? `${counts.modified} edited` : '',
    ].filter(Boolean);
    // Nothing to add when they are all the same thing and the count already said so.
    return parts.length > 1 ? parts.join(', ') : '';
  }

  /**
   * What the last run is being compared against, for anything that wants to show the run's
   * changes itself — the editor gutter, for one.
   *
   * Only what has already been computed for the panel: this is asked for every file that
   * opens, so it must not start any work of its own.
   */
  runComparison(): { root: string; before: string; statuses: ReadonlyMap<string, ChangeStatus> } | undefined {
    const trees = this.treeState;
    if (!trees || !this.root || this.runStatuses.size === 0) return undefined;
    return { root: this.root, before: trees.before, statuses: this.runStatuses };
  }

  /**
   * Runs that have already finished, newest first.
   *
   * Sending a follow-up moves the boundary, and until now that put the run before it out of
   * reach — its trees were still in the object store, but nothing remembered which they were.
   */
  async pastRuns(): Promise<PastRun[]> {
    const root = await this.repoRoot();
    if (!root) return [];
    let trees = await readRunTrees(root);
    if (!trees?.history) {
      for (const cwd of [...this.cwdHints].slice(-MAX_CWD_HINTS)) {
        const found = await readRunTrees(cwd);
        if (found?.history) {
          trees = found;
          break;
        }
      }
    }
    return trees?.history ?? [];
  }

  /**
   * The diff of a run that has already finished.
   *
   * Both sides come from snapshots rather than from disk: the working tree has moved on since,
   * and showing today's file beside that run's starting point would attribute everything since
   * to it.
   */
  async diffForRun(run: PastRun): Promise<{ pairs: Array<[vscode.Uri, vscode.Uri, vscode.Uri]>; count: number }> {
    const root = await this.repoRoot();
    if (!root) return { pairs: [], count: 0 };
    const changes = await treeChanges(run.tree, run.after, this.runner);
    const pairs = [...changes].map(([rel, status]) => {
      const uri = vscode.Uri.file(path.join(root, rel));
      const from = status.kind === 'renamed' ? status.from : rel;
      const left = status.kind === 'added' ? emptySide(uri, 'new file') : treeSide(root, run.tree, from);
      const right = status.kind === 'deleted' ? emptySide(uri, 'deleted') : treeSide(root, run.after, rel);
      return [uri, left, right] as [vscode.Uri, vscode.Uri, vscode.Uri];
    });
    return { pairs, count: pairs.length };
  }

  /** Left/right pairs for VS Code's multi-file diff editor. */
  async diffResources(scope: 'recent' | 'all' = 'all'): Promise<Array<[vscode.Uri, vscode.Uri, vscode.Uri]>> {
    const summary = await this.summary();
    if (!summary) return [];
    const api = await this.git?.getApi();
    const root = await this.repoRoot();
    const uris = await this.changedUris(scope);

    // With snapshots there is a real document on both sides of every entry, and for the last
    // run the left side is the file as the run found it — so what is shown is this run's work
    // rather than every change since the base commit.
    const trees = this.treeState;
    if (trees && trees.base === summary.base && root) {
      const left = scope === 'recent' ? trees.before : summary.base;
      const statuses = scope === 'recent' ? this.runStatuses : this.statuses;
      // Only asked when a diff is actually opened, not on every refresh.
      const binary = await this.binaryIn(left, trees.now);
      return uris.map((uri) => {
        const rel = path.relative(root, uri.fsPath);
        const status = statuses.get(rel);
        // A path absent from the left tree — a file the run created — resolves to an empty
        // document, which reads as the whole file arriving. Nothing to special-case.
        const from = status?.kind === 'renamed' ? status.from : rel;
        const modified = status?.kind === 'deleted' ? emptySide(uri, 'deleted') : uri;
        // Added: nothing to read out of the snapshot, and saying so is more use than an
        // unlabelled empty pane.
        if (status?.kind === 'added') {
          return [uri, emptySide(uri, 'new file'), modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
        }
        // An image cannot be served as text. Compared against the base instead, where the git
        // extension has a resource the editor can load properly. An added one never reaches
        // here — it was answered above, where there is nothing to compare against at all.
        if (binary.has(from) || binary.has(rel)) {
          let original: vscode.Uri | undefined;
          try {
            original = api?.toGitUri(vscode.Uri.file(path.join(root, from)), summary.base);
          } catch {
            original = undefined;
          }
          return [uri, original ?? emptySide(uri), modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
        }
        return [uri, treeSide(root, left, from), modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
      });
    }
    // For the last run, compare against the snapshot taken when the request was submitted:
    // otherwise a file edited in an earlier run shows those older lines here too, which is
    // not "what changed in the last run" by any reading.
    const snapshot = scope === 'recent' ? this.snapshot : undefined;
    // A deleted file has nothing to show on the right. Handing the multi-file diff a path
    // that is not there gives it a side it cannot open, and the entry does not render.
    const gone = new Set(
      (await Promise.all(uris.map(async (u) => ((await this.exists(u)) ? undefined : u.toString())))).filter(
        (v): v is string => v !== undefined,
      ),
    );
    return uris.map((uri) => {
      let original: vscode.Uri | undefined;
      const rel = root ? path.relative(root, uri.fsPath) : undefined;
      const stored = snapshot && rel !== undefined ? snapshot.storedPath(rel) : undefined;
      const modified = gone.has(uri.toString()) ? emptySide(uri, 'deleted') : uri;
      if (stored !== undefined) return [uri, vscode.Uri.file(stored), modified];

      const status = rel !== undefined ? this.statuses.get(rel) : undefined;
      // Added: nothing exists at the base, so the left side is empty and the diff reads as
      // the whole file arriving. Renamed: the left side is the path it came from, which does
      // exist there.
      if (status?.kind === 'added') return [uri, emptySide(uri, 'new file'), modified];
      try {
        const left =
          status?.kind === 'renamed' && root
            ? vscode.Uri.file(path.join(root, status.from))
            : uri;
        original = api?.toGitUri(left, summary.base);
      } catch {
        original = emptySide(uri);
      }
      return [uri, original ?? emptySide(uri), modified];
    });
  }

  /** Changed line ranges, for walking hunk by hunk. */
  async hunks(): Promise<Hunk[]> {
    const root = await this.repoRoot();
    const summary = await this.summary();
    if (!root || !summary) return [];
    // Keyed by the snapshot too: the ranges differ entirely depending on which side the
    // comparison uses, so a new run must not reuse the previous run's hunks.
    const key = `${summary.base}::${this.treeState?.before ?? this.snapshot?.at ?? ''}`;
    if (this.hunkCache?.base === key) return this.hunkCache.hunks;
    const startedAt = Date.now();
    const out: Hunk[] = [];
    const fromRun = new Set<string>();
    try {
      // The run's own lines, from the tree recorded when its request was submitted. One diff
      // for every file at once, against a snapshot rather than a directory of copies.
      if (this.treeState) {
        const recent = new Set(summary.recent);
        try {
          const runDiff = await this.run(['diff', '-U0', '--no-color', this.treeState.before, '--']);
          for (const file of parseDiffByFile(runDiff)) {
            if (!recent.has(file.path)) continue;
            fromRun.add(file.path);
            for (const h of file.hunks) {
              const hunk: Hunk = { uri: vscode.Uri.file(path.join(root, file.path)), start: h.start, end: h.end };
              if (h.deletion) hunk.deletion = true;
              out.push(hunk);
            }
          }
        } catch (err) {
          this.logger.trace(`could not diff against the run snapshot: ${String(err)}`);
        }
      }

      // Files the run-start snapshot covers: compare against that copy, so navigation agrees
      // with the diff the panel opens instead of walking earlier runs' lines as well.
      if (this.snapshot) {
        const snap = this.snapshot;
        const covered = summary.recent.filter((f) => snap.has(f));
        // In batches. One `git diff --no-index` per changed file, all at once, is five hundred
        // git processes for a five-hundred-file run — enough to starve the machine the editor
        // is running on, for a keypress that walks to the next hunk.
        const results = await inBatches(covered, GIT_FANOUT, async (rel) => {
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
        });
        for (const r of results) {
          if (!r) continue;
          fromRun.add(r.rel);
          for (const range of r.ranges) {
            out.push({ uri: vscode.Uri.file(path.join(root, r.rel)), start: range.start, end: range.end });
          }
        }
      }

      const diff = await this.run(['diff', '-U0', '--no-color', summary.base, '--']);
      for (const file of parseDiffByFile(diff)) {
        if (fromRun.has(file.path)) continue; // already covered, more precisely
        for (const h of file.hunks) {
          const hunk: Hunk = { uri: vscode.Uri.file(path.join(root, file.path)), start: h.start, end: h.end };
          if (h.deletion) hunk.deletion = true;
          out.push(hunk);
        }
      }
      // A new file has no diff to parse, so its whole body is the hunk. Which files those are
      // comes from the status map computed alongside the summary — calling `ls-files` here was
      // costing 1-2.6s in a large repository, which is what made the first `⌥F7` feel broken.
      const changed = new Set(summary.files);
      const newFiles = [...this.statuses]
        .filter(([rel, status]) => status.kind === 'added' && changed.has(rel))
        .map(([rel]) => rel);
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
