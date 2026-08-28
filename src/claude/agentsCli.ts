import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Claude Code's own account of the sessions it is running.
 *
 * `claude agents --json` lists every interactive and background session with its working
 * directory, its real session id and whether it is busy. Redline used to work this out from
 * the process table — one `ps` plus an `lsof` per Claude process to recover a working
 * directory — which cost about a third of a second, could not see background agents, returned
 * nothing at all on Windows, and never yielded a session id at all: that had to be guessed
 * from which transcript file was modified most recently, which is what put replies in the
 * wrong session when two were open.
 *
 * Optional. An older CLI has no such subcommand, so every caller has to cope with nothing.
 */

export interface AgentSession {
  /** Claude Code's own id for the conversation — the thing `--resume` takes. */
  sessionId: string;
  cwd: string;
  kind: 'interactive' | 'background' | string;
  /** Absent for a background agent, which is not attached to a terminal. */
  pid?: number;
  name?: string;
  /** `idle` / `busy` for interactive, `state` for background. Free-form; treat as a label. */
  status?: string;
  startedAt?: number;
}

/** Long enough that a session cannot appear and vanish inside it; short enough to feel live. */
const CACHE_MS = 4_000;
/** The CLI is a node process starting up: fast, but not instant, and never worth blocking on. */
const TIMEOUT_MS = 5_000;

// Keyed by the executable: only one is ever used in earnest, but a cache that ignores what it
// asked is a cache that can answer for something else.
let cache: { at: number; key: string; sessions: AgentSession[] } | undefined;
let inFlight: Promise<AgentSession[]> | undefined;
/** Once the subcommand is known to be missing, stop paying to rediscover that. */
let unsupported = false;

function parse(raw: string): AgentSession[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) return [];
  const out: AgentSession[] = [];
  for (const entry of value) {
    const e = entry as Partial<AgentSession> & { state?: string };
    if (typeof e.sessionId !== 'string' || typeof e.cwd !== 'string' || !e.cwd) continue;
    const session: AgentSession = { sessionId: e.sessionId, cwd: e.cwd, kind: e.kind ?? 'interactive' };
    if (typeof e.pid === 'number') session.pid = e.pid;
    if (typeof e.name === 'string') session.name = e.name;
    // Interactive sessions report `status`, background ones `state`; both are just labels.
    const status = e.status ?? e.state;
    if (typeof status === 'string') session.status = status;
    if (typeof e.startedAt === 'number') session.startedAt = e.startedAt;
    out.push(session);
  }
  return out;
}

/**
 * Every session Claude Code knows about, or an empty list when it cannot say.
 *
 * Never throws: this is an optimisation over the process table, and a CLI that is missing,
 * older, or slow must not stop Redline finding a session the old way.
 */
export async function listAgentSessions(claude = 'claude'): Promise<AgentSession[]> {
  if (unsupported) return [];
  if (cache && cache.key === claude && Date.now() - cache.at < CACHE_MS) return cache.sessions;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { stdout } = await execFileP(claude, ['agents', '--json'], { timeout: TIMEOUT_MS });
      const sessions = parse(stdout);
      cache = { at: Date.now(), key: claude, sessions };
      return sessions;
    } catch (err) {
      // An exit code means the subcommand is not there; a timeout or a missing binary might
      // just be this once, so only the first is treated as permanent.
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'number' && code !== 0) unsupported = true;
      return [];
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}

/** Drop the cache — a session may have been started since. */
export function forgetAgentSessions(): void {
  cache = undefined;
}

/** For tests: forget that the subcommand was unavailable. */
export function resetAgentSupport(): void {
  unsupported = false;
  cache = undefined;
}
