import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Claude Code keeps one JSONL transcript per working directory under
 * `~/.claude/projects/<slug>/<sessionId>.jsonl`. We only need each session's time span,
 * so files are sampled from both ends instead of parsed whole (they reach megabytes).
 */

export interface ClaudeSessionInfo {
  file: string;
  sessionId: string;
  /** ISO timestamp of the first entry. */
  startedAt: string;
  /** ISO timestamp of the last entry. */
  lastActivityAt: string;
}

/**
 * `/Users/me/my_repo.v2` → `-Users-me-my-repo-v2`. Claude Code normalises every character
 * that is not a letter, digit or dash — not just separators and dots.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Does a slug name a directory this window cares about?
 *
 * The slug is lossy — every character outside `[A-Za-z0-9-]` becomes `-` — so it cannot be
 * turned back into a path. Comparing slugs works anyway, in both directions: a session run
 * inside the workspace produces a longer slug that starts with ours, and one run in a parent
 * of it (a window open on one package, the agent at the repository root) produces a shorter
 * one that ours starts with. The trailing `-` is what keeps `app` from matching `app2`.
 *
 * With no folders to compare against, everything matches: better noisy than deaf.
 */
export type SlugScope =
  /** This directory, anything under it, and anything it sits under. */
  | 'related'
  /** This directory and the directories it sits under — nothing deeper. */
  | 'self-or-above';

/**
 * `'self-or-above'` exists because a deeper slug is ambiguous in a way the others are not.
 *
 * `/repo/frontend` and `/repo-frontend` produce the same string, so "starts with ours" cannot
 * tell a directory inside the workspace from a sibling whose name merely begins the same way.
 * That is tolerable for "did something here change" — both are worth a look — and wrong for
 * "is the agent this window is watching busy": the hook keys its markers by *repository* root,
 * so a deeper slug is always another repository, and letting its run end clear ours flipped
 * this window to idle in the middle of a turn.
 */
export function slugInScope(
  slug: string,
  roots: readonly string[],
  scope: SlugScope = 'related',
): boolean {
  if (roots.length === 0) return true;
  return roots.some(
    (r) =>
      slug === r ||
      r.startsWith(`${slug}-`) ||
      (scope === 'related' && slug.startsWith(`${r}-`)),
  );
}

function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Max window we consider "this session's work" — long-lived transcripts get capped. */
export const MAX_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Windows tried from each end. A single transcript entry (a large file read, a big tool
 * result) can be megabytes, so the first window may contain no timestamp at all.
 */
const EDGE_WINDOWS = [96 * 1024, 1024 * 1024, 8 * 1024 * 1024];

/** Timestamps are plain fields on every entry; scan for the first/last occurrence. */
function firstTimestamp(text: string): string | undefined {
  return /"timestamp"\s*:\s*"([^"]+)"/.exec(text)?.[1];
}

function lastTimestamp(text: string): string | undefined {
  let last: string | undefined;
  const re = /"timestamp"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

/** Every timestamp in a chunk, as epoch ms, in the order they appear. */
function allTimestamps(text: string): number[] {
  const out: number[] = [];
  const re = /"timestamp"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = Date.parse(m[1] ?? '');
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/**
 * The last window read from a transcript, keyed by the file's identity.
 *
 * Several answers come out of the same tail — when the session last spoke, when you last asked
 * for something, where the idle gaps are — and each was opening and reading the file again.
 * They memoize individually on size and mtime, which is exactly the thing that changes on every
 * write while a session is running, so during a run they all missed together and re-read the
 * same bytes. One entry, because only the newest read is ever wanted again immediately.
 */
let edgeCache: { key: string; text: string } | undefined;

async function readEdge(file: string, bytes: number, from: 'head' | 'tail'): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const { size, mtimeMs } = await handle.stat();
    const len = Math.min(bytes, size);
    const key = `${file}:${from}:${len}:${size}:${mtimeMs}`;
    if (edgeCache?.key === key) return edgeCache.text;
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, from === 'head' ? 0 : Math.max(0, size - len));
    const text = buf.toString('utf8');
    edgeCache = { key, text };
    return text;
  } finally {
    await handle.close();
  }
}

/** Grow the window until a timestamp turns up (or the file is exhausted). */
async function findTimestamp(file: string, from: 'head' | 'tail'): Promise<string | undefined> {
  let size = Infinity;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return undefined;
  }
  for (const bytes of EDGE_WINDOWS) {
    const found = from === 'head'
      ? firstTimestamp(await readEdge(file, bytes, 'head'))
      : lastTimestamp(await readEdge(file, bytes, 'tail'));
    if (found) return found;
    if (bytes >= size) break;
  }
  return undefined;
}

/**
 * How many of a directory's transcripts are actually opened. Callers only ever want the
 * newest session, and a busy project accumulates dozens of multi-megabyte files.
 */
const SAMPLE_NEWEST = 3;
/**
 * Short, because a stale base makes the panel report last-run figures that are seconds out
 * of date. Kept affordable by `memoized` below: a repeat call that finds the transcript
 * unchanged costs one `stat`.
 */
const CACHE_MS = 3_000;

/** Cached results keyed by the file's size and mtime — transcripts only ever grow. */
const memo = new Map<string, { key: string; value: unknown }>();
const MEMO_LIMIT = 200;

async function memoized<T>(file: string, tag: string, compute: () => Promise<T>): Promise<T> {
  let key: string;
  try {
    const st = await fs.stat(file);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    return compute();
  }
  const id = `${tag}::${file}`;
  const hit = memo.get(id);
  if (hit && hit.key === key) return hit.value as T;
  const value = await compute();
  if (memo.size > MEMO_LIMIT) memo.clear();
  memo.set(id, { key, value });
  return value;
}

const cache = new Map<string, { at: number; sessions: ClaudeSessionInfo[] }>();

/**
 * Sessions recorded for `cwd`, newest activity first. Empty when Claude Code has never
 * run there (or the transcripts are unreadable).
 *
 * Only the newest few files are read: `readdir` + `stat` is cheap, opening every
 * transcript is not (hundreds of megabytes in a long-lived project).
 */
export async function findSessions(cwd: string): Promise<ClaudeSessionInfo[]> {
  const dir = path.join(projectsDir(), projectSlug(cwd));
  const cached = cache.get(dir);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.sessions;

  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    cache.set(dir, { at: Date.now(), sessions: [] });
    return [];
  }
  const stamped: Array<{ file: string; name: string; mtimeMs: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      stamped.push({ file, name, mtimeMs: (await fs.stat(file)).mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: ClaudeSessionInfo[] = [];
  for (const entry of stamped.slice(0, SAMPLE_NEWEST)) {
    try {
      // The file's own mtime backs both ends up: never drop a session, or sort it by the
      // wrong endpoint, just because its entries are too big to sample.
      const mtime = new Date(entry.mtimeMs).toISOString();
      const lastActivityAt =
        (await memoized(entry.file, 'tail', () => findTimestamp(entry.file, 'tail'))) ?? mtime;
      const startedAt =
        (await memoized(entry.file, 'head', () => findTimestamp(entry.file, 'head'))) ??
        new Date(Date.parse(lastActivityAt) - MAX_SESSION_WINDOW_MS).toISOString();
      out.push({
        file: entry.file,
        sessionId: entry.name.replace(/\.jsonl$/, ''),
        startedAt,
        lastActivityAt,
      });
    } catch {
      // unreadable transcript — ignore
    }
  }
  out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  cache.set(dir, { at: Date.now(), sessions: out });
  return out;
}

/** The session that was (or is) running in `cwd`, if any. */
export async function latestSession(cwd: string): Promise<ClaudeSessionInfo | undefined> {
  return (await findSessions(cwd))[0];
}

/**
 * The newest session across several candidate directories — the folder VS Code has open,
 * the repository root, and the directory a detected Claude process actually runs in can
 * all differ (monorepo package, agent started in a subdirectory).
 */
export async function latestSessionAmong(cwds: readonly string[]): Promise<ClaudeSessionInfo | undefined> {
  const seen = new Set<string>();
  const found: ClaudeSessionInfo[] = [];
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    const s = await latestSession(cwd);
    if (s) found.push(s);
  }
  found.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return found[0];
}

/**
 * The assistant's own words from the end of a session, newest last.
 *
 * This — not the terminal — is where an agent's report-back is read from. Claude Code
 * repaints its TUI in place, so a terminal capture is mostly redraw frames and blank
 * lines: on a real 245-second run, 2000 lines of scrollback held 225 non-blank lines, all
 * of them spinner frames, and the reply itself had scrolled away. The transcript keeps the
 * exact text.
 *
 * Sidechain (subagent) entries are skipped: only the main thread reports back.
 */
export async function recentAssistantText(session: ClaudeSessionInfo, maxMessages = 12): Promise<string> {
  return memoized(session.file, `assistant:${maxMessages}`, () => computeRecentAssistantText(session, maxMessages));
}

async function computeRecentAssistantText(session: ClaudeSessionInfo, maxMessages: number): Promise<string> {
  for (const bytes of EDGE_WINDOWS) {
    let chunk: string;
    try {
      chunk = await readEdge(session.file, bytes, 'tail');
    } catch {
      return '';
    }
    const found: string[] = [];
    // A tail read starts mid-line, so unparseable lines are expected and skipped.
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('{')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const e = entry as {
        type?: string;
        isSidechain?: boolean;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (e.type !== 'assistant' || e.isSidechain) continue;
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          found.push(block.text);
        }
      }
    }
    if (found.length > 0) return found.slice(-maxMessages).join('\n');
    let size = Infinity;
    try {
      size = (await fs.stat(session.file)).size;
    } catch {
      return '';
    }
    if (bytes >= size) break;
  }
  return '';
}

/**
 * When the user last asked for something.
 *
 * This is the boundary that matches how the tool is actually used: you send notes, the agent
 * works, you look at what it changed. An idle-gap rule cannot express that — three requests
 * a few minutes apart are one continuous run, so "the last run" grows to include all of
 * them, which is exactly the accumulation this replaces.
 *
 * A real request has string content. Tool results are also recorded with `type: "user"` but
 * carry a list of `tool_result` blocks, and counting those would put the boundary at the
 * agent's own last tool call.
 *
 * Returns undefined when no request can be found, leaving the caller to fall back.
 */
export async function lastRequestStart(session: ClaudeSessionInfo): Promise<string | undefined> {
  return memoized(session.file, 'request', async () => {
    let size = 0;
    try {
      size = (await fs.stat(session.file)).size;
    } catch {
      return undefined;
    }
    for (const bytes of EDGE_WINDOWS) {
      let chunk: string;
      try {
        chunk = await readEdge(session.file, bytes, 'tail');
      } catch {
        return undefined;
      }
      let found: string | undefined;
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('{')) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const e = entry as {
          type?: string;
          isMeta?: boolean;
          isSidechain?: boolean;
          timestamp?: string;
          message?: { content?: unknown };
        };
        if (e.type !== 'user' || e.isSidechain || e.isMeta) continue;
        if (typeof e.timestamp !== 'string') continue;
        const content = e.message?.content;
        const isRequest =
          typeof content === 'string' ||
          (Array.isArray(content) &&
            content.length > 0 &&
            !content.some((b) => (b as { type?: string })?.type === 'tool_result'));
        if (isRequest) found = e.timestamp;
      }
      if (found) return found;
      if (bytes >= size) break;
    }
    return undefined;
  });
}

/**
 * Start of the last *run* inside a session: entries are walked back from the end and the
 * block is cut where two consecutive ones are more than `gapMs` apart.
 *
 * This is the agent's own record of when it was working, which is why it is preferred over
 * file modification times for "what changed in the last run": mtimes are moved by a
 * formatter, a build writing into a source tree, or your own save, and — worse — they place
 * a file the agent *committed* early in the run outside the cluster entirely.
 *
 * Falls back to the session start, which is always a safe over-approximation.
 */
export async function lastRunStart(session: ClaudeSessionInfo, gapMs: number): Promise<string> {
  return memoized(session.file, `run:${gapMs}`, () => computeLastRunStart(session, gapMs));
}

async function computeLastRunStart(session: ClaudeSessionInfo, gapMs: number): Promise<string> {
  let size = 0;
  try {
    size = (await fs.stat(session.file)).size;
  } catch {
    return session.startedAt;
  }
  for (const bytes of EDGE_WINDOWS) {
    let stamps: number[];
    try {
      stamps = allTimestamps(await readEdge(session.file, bytes, 'tail'));
    } catch {
      return session.startedAt;
    }
    // Transcripts are append-only, but never trust the order for a boundary calculation.
    stamps.sort((a, b) => a - b);
    for (let i = stamps.length - 1; i > 0; i--) {
      const here = stamps[i];
      const before = stamps[i - 1];
      if (here !== undefined && before !== undefined && here - before > gapMs) {
        return new Date(here).toISOString();
      }
    }
    // No gap in this window. Once the window covers the file, the whole session is one run.
    if (bytes >= size) break;
  }
  return session.startedAt;
}

/**
 * Start of the work to review: the session's own start, but never more than
 * `MAX_SESSION_WINDOW_MS` before its last activity (a transcript resumed over days would
 * otherwise reach back arbitrarily far).
 */
export function reviewWindowStart(session: ClaudeSessionInfo): string {
  const started = Date.parse(session.startedAt);
  const last = Date.parse(session.lastActivityAt);
  if (!Number.isFinite(started) || !Number.isFinite(last)) return session.startedAt;
  const capped = last - MAX_SESSION_WINDOW_MS;
  return started >= capped ? session.startedAt : new Date(capped).toISOString();
}
