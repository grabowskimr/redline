import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger';
import { deliveryToken, discardHandover, stageForHandover } from './handover';

const execFileP = promisify(execFile);

/** A place we can deliver a prompt to. */
export interface SessionTarget {
  /** Stable identity used to remember "where the batch went": `vscode:<name>` / `orca:<handle>`. */
  key: string;
  label: string;
  kind: 'vscode' | 'orca';
  cwd: string;
  pid: number;
  inWorkspace: boolean;
  terminal?: vscode.Terminal;
  orcaHandle?: string;
}

interface Proc {
  pid: number;
  ppid: number;
  comm: string;
}

async function listProcesses(): Promise<Proc[]> {
  if (process.platform === 'win32') return [];
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,comm=']);
  const out: Proc[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: (m[3] ?? '').trim() });
  }
  return out;
}

async function cwdOf(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const n = stdout.split('\n').find((l) => l.startsWith('n'));
    return n ? n.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

function ancestorMatches(p: Proc, byPid: Map<number, Proc>, test: (p: Proc) => boolean): boolean {
  let cur: Proc | undefined = p;
  for (let i = 0; cur && i < 12; i++) {
    if (test(cur)) return true;
    cur = byPid.get(cur.ppid);
  }
  return false;
}

function isClaudeProcess(p: Proc): boolean {
  const base = path.basename(p.comm);
  return base === 'claude' || base === 'claude.js';
}

// ─── Orca CLI ────────────────────────────────────────────────────────────────

export async function orcaExecutable(): Promise<string> {
  if (process.env['ORCA_CLI_COMMAND']) return process.env['ORCA_CLI_COMMAND'];
  // Outside Orca's own terminals bare `orca` on Linux is the GNOME screen reader.
  const name = process.platform === 'linux' ? 'orca-ide' : 'orca';
  // The extension host's PATH may lack /usr/local/bin (app launched from the Dock).
  for (const dir of ['/usr/local/bin', '/opt/homebrew/bin', path.join(process.env['HOME'] ?? '', '.local/bin')]) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return name;
}

interface OrcaTerminal {
  handle: string;
  title: string | null;
  worktreePath?: string;
  preview?: string;
}

export async function orcaTerminals(): Promise<OrcaTerminal[]> {
  const { stdout } = await execFileP(await orcaExecutable(), ['terminal', 'list', '--json'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { ok?: boolean; result?: { terminals?: OrcaTerminal[] } };
  if (!parsed.ok) throw new Error('orca terminal list failed');
  return parsed.result?.terminals ?? [];
}

// ─── discovery ───────────────────────────────────────────────────────────────

/**
 * Find running Claude Code sessions as deliverable targets. Best-effort, macOS/Linux.
 * Sorted: in-workspace first, then reachable ones.
 */
export async function findTargets(logger: Logger): Promise<SessionTarget[]> {
  let procs: Proc[];
  try {
    procs = await listProcesses();
  } catch (err) {
    logger.warn('could not list processes', err);
    return [];
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const claudes = procs.filter(isClaudeProcess);
  if (claudes.length === 0) return [];

  const terminalPids = new Map<number, vscode.Terminal>();
  await Promise.all(
    vscode.window.terminals.map(async (t) => {
      const pid = await t.processId;
      if (pid) terminalPids.set(pid, t);
    }),
  );
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let orcaTerms: OrcaTerminal[] | undefined;

  const targets: SessionTarget[] = [];
  for (const c of claudes) {
    const cwd = (await cwdOf(c.pid)) ?? '';
    const inWorkspace = folders.some((f) => cwd === f || cwd.startsWith(f + path.sep));
    // VS Code integrated terminal?
    let terminal: vscode.Terminal | undefined;
    let cur: Proc | undefined = c;
    for (let i = 0; cur && i < 12; i++) {
      terminal = terminalPids.get(cur.pid);
      if (terminal) break;
      cur = byPid.get(cur.ppid);
    }
    if (terminal) {
      targets.push({
        key: `vscode:${terminal.name}:${cwd}`,
        label: `${terminal.name} (terminal)`,
        kind: 'vscode',
        cwd,
        pid: c.pid,
        inWorkspace,
        terminal,
      });
      continue;
    }
    // Orca?
    if (ancestorMatches(c, byPid, (p) => /orca/i.test(p.comm))) {
      try {
        orcaTerms ??= await orcaTerminals();
      } catch (err) {
        logger.warn('orca CLI unavailable', err);
        orcaTerms = [];
      }
      const same = orcaTerms.filter(
        (t) => t.worktreePath && (cwd === t.worktreePath || cwd.startsWith(t.worktreePath + path.sep)),
      );
      const term =
        same.find((t) => /claude/i.test(t.title ?? '')) ??
        same.find((t) => /claude|esc to interrupt|✳/i.test(t.preview ?? '')) ??
        same[0];
      if (term) {
        const worktree = path.basename(term.worktreePath ?? cwd);
        targets.push({
          key: `orca:${term.handle}`,
          label: `${term.title?.trim() || 'Claude Code'} — ${worktree} (Orca)`,
          kind: 'orca',
          cwd,
          pid: c.pid,
          inWorkspace,
          orcaHandle: term.handle,
        });
        continue;
      }
    }
    targets.push({
      key: `external:${c.pid}`,
      label: `pid ${c.pid} (external terminal — unreachable)`,
      kind: 'vscode',
      cwd,
      pid: c.pid,
      inWorkspace,
    });
  }
  targets.sort(
    (a, b) =>
      Number(b.inWorkspace) - Number(a.inWorkspace) ||
      Number(!!b.terminal || !!b.orcaHandle) - Number(!!a.terminal || !!a.orcaHandle),
  );
  return targets;
}

export function isReachable(t: SessionTarget): boolean {
  return !!t.terminal || !!t.orcaHandle;
}

const LAST_TARGET_KEY = 'redline.lastTarget';

/**
 * Choose the target for a send. Only sessions running **in this workspace** qualify:
 * pushing review notes into a Claude session that is working on a different worktree
 * would be worse than not sending at all. Returns undefined when there is none, and the
 * caller falls back to the clipboard.
 */
export async function resolveTarget(
  context: vscode.ExtensionContext,
  logger: Logger,
  opts: { interactive: boolean } = { interactive: true },
): Promise<SessionTarget | undefined> {
  const candidates = (await findTargets(logger)).filter((t) => isReachable(t) && t.inWorkspace);
  if (candidates.length === 0) return undefined;
  const preferredKey = context.workspaceState.get<string>(LAST_TARGET_KEY);
  const preferred = candidates.find((t) => t.key === preferredKey);
  if (preferred) return preferred;
  if (candidates.length === 1 || !opts.interactive) return candidates[0];
  return pickTarget(context, logger, candidates);
}

/** Quick pick over targets; remembers the choice for this workspace. */
export async function pickTarget(
  context: vscode.ExtensionContext,
  logger: Logger,
  pool?: SessionTarget[],
): Promise<SessionTarget | undefined> {
  const targets = pool ?? (await findTargets(logger)).filter(isReachable);
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('Redline: no reachable Claude Code session found.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    targets.map((t) => ({
      label: t.label,
      description: t.inWorkspace ? t.cwd : `${t.cwd}  ⚠ outside this workspace`,
      target: t,
    })),
    { placeHolder: 'Which Claude Code session should receive review notes?' },
  );
  if (!picked) return undefined;
  await context.workspaceState.update(LAST_TARGET_KEY, picked.target.key);
  return picked.target;
}

export async function rememberTarget(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.workspaceState.update(LAST_TARGET_KEY, key);
}

// ─── delivery ────────────────────────────────────────────────────────────────

export type SendMode = 'inline' | 'file';

/** Wrap text in a bracketed-paste sequence so the TUI treats newlines as part of one paste. */
/**
 * Type the handover token and submit it. Short enough that none of the paste machinery
 * matters — no bracketed paste, no waiting for the input to settle.
 */
async function deliverToken(
  token: string,
  target: SessionTarget,
  context: vscode.ExtensionContext,
  logger: Logger,
  opts: { autoSubmit: boolean },
): Promise<SendResult> {
  await rememberTarget(context, target.key);
  if (target.terminal) {
    target.terminal.show(true);
    target.terminal.sendText(token, opts.autoSubmit);
    return { ok: true, message: `Sent to ${target.label}.`, target };
  }
  if (target.orcaHandle) {
    const bin = await orcaExecutable();
    const args = ['terminal', 'send', '--terminal', target.orcaHandle, '--text', token, '--json'];
    if (opts.autoSubmit) args.push('--enter');
    try {
      await execFileP(bin, args);
    } catch (err) {
      logger.error('orca terminal send failed', err);
      return { ok: false, message: 'Sending to the Orca terminal failed (see log).', target };
    }
    return { ok: true, message: `Sent to ${target.label}.`, target };
  }
  return { ok: false, message: `${target.label} is not reachable.`, target };
}

/** Longest wait for the agent's input to settle before Enter is pressed. */
const SUBMIT_IDLE_TIMEOUT_MS = 5_000;
/** Fallback pause when the terminal cannot report idleness. */
const SUBMIT_DELAY_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Block until the agent's interface stops changing, so Enter is not pressed into a terminal
 * that is still ingesting the prompt. Falls back to a fixed pause if the wait is unavailable.
 */
async function waitForIdle(bin: string, handle: string, logger: Logger): Promise<void> {
  try {
    await execFileP(bin, [
      'terminal',
      'wait',
      '--terminal',
      handle,
      '--for',
      'tui-idle',
      '--timeout-ms',
      String(SUBMIT_IDLE_TIMEOUT_MS),
      '--json',
    ]);
  } catch (err) {
    // A timeout exits non-zero; so does an older CLI without `wait`. Either way, pressing
    // Enter after a pause is better than not pressing it.
    logger.trace(`terminal wait before submit did not settle: ${String(err)}`);
    await delay(SUBMIT_DELAY_MS);
  }
}

export function bracketedPaste(text: string): string {
  return `\u001b[200~${text.replace(/\r?\n/g, '\r')}\u001b[201~`;
}

/** Remove outbox files older than a day (only relevant for `file` mode). */
async function cleanOutbox(dir: vscode.Uri, keep?: string): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [name] of entries) {
      if (name === keep) continue;
      const uri = vscode.Uri.joinPath(dir, name);
      const st = await vscode.workspace.fs.stat(uri);
      if (st.mtime < cutoff) await vscode.workspace.fs.delete(uri);
    }
  } catch {
    // best effort
  }
}

export interface SendResult {
  ok: boolean;
  message: string;
  target?: SessionTarget;
}

/**
 * Hand a rendered batch to a running Claude Code session.
 *  - `inline` (default): the whole prompt as one bracketed paste.
 *  - `file`: written to extension storage, a one-line pointer typed instead.
 */
export async function sendBatchToClaude(
  text: string,
  context: vscode.ExtensionContext,
  logger: Logger,
  opts: { autoSubmit: boolean; mode?: SendMode; target?: SessionTarget },
): Promise<SendResult> {
  const target = opts.target ?? (await resolveTarget(context, logger));
  if (!target) {
    const any = await findTargets(logger);
    const here = any.filter((t) => t.inWorkspace);
    return {
      ok: false,
      message: here.length
        ? `Claude Code is running here (pid ${here[0]?.pid}) but in a terminal we cannot type into — paste the clipboard there.`
        : 'No Claude Code session found in this folder — the notes are on the clipboard.',
    };
  }
  await rememberTarget(context, target.key);

  // Preferred: hand the batch to the plugin and type a short token. Only the token has to
  // survive being typed, which removes the size-dependent failure that made a long prompt
  // land in the input without ever being submitted.
  let handedOver = false;
  if (opts.mode !== 'file' && target.cwd) {
    const token = await deliveryToken(target.cwd);
    if (token) {
      try {
        await stageForHandover(target.cwd, text.trimEnd());
        handedOver = true;
        logger.info(`staged ${text.length} chars for the Redline plugin; sending "${token}"`);
        return await deliverToken(token, target, context, logger, opts);
      } catch (err) {
        logger.warn('could not hand the batch to the plugin; typing it instead', err);
        await discardHandover(target.cwd);
        handedOver = false;
      }
    }
  }
  void handedOver;

  const dir = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'outbox');
  let payload: string;
  if (opts.mode === 'file') {
    await vscode.workspace.fs.createDirectory(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `review-${stamp}.md`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), Buffer.from(text, 'utf8'));
    void cleanOutbox(dir, name);
    payload = `I reviewed the generated code and left my feedback in ${vscode.Uri.joinPath(dir, name).fsPath} — read that file and work through it.`;
  } else {
    void cleanOutbox(dir);
    payload = text.trimEnd();
  }

  if (target.terminal) {
    // `sendText` writes straight to the pty, where a newline is Enter and would submit each
    // line as its own prompt. Bracketed paste is what keeps it one message.
    target.terminal.show(true);
    target.terminal.sendText(bracketedPaste(payload), false);
    if (opts.autoSubmit) {
      // Enter separately, as on the Orca path. There is no way to ask a VS Code terminal
      // whether it has settled, so this is a pause rather than a condition.
      await delay(SUBMIT_DELAY_MS);
      target.terminal.sendText('', true);
    }
    logger.info(`sent batch to terminal "${target.terminal.name}" (pid ${target.pid})`);
    return { ok: true, message: `Sent to ${target.label}.`, target };
  }
  if (target.orcaHandle) {
    // Sent raw: `terminal send --text` types into the agent's input box, where newlines
    // stay newlines and only `--enter` submits. Wrapping this in bracketed paste markers
    // is unnecessary, and a session was seen storing them as literal `<ESC>[200~` text at
    // the head of the prompt.
    const bin = await orcaExecutable();
    try {
      await execFileP(bin, ['terminal', 'send', '--terminal', target.orcaHandle, '--text', payload, '--json']);
      if (opts.autoSubmit) {
        // Enter goes as its own keystroke, once the agent's input has actually settled.
        //
        // Appending `--enter` to the same call, or pressing it after a fixed pause, submitted
        // a long prompt only sometimes: the input is still taking the text in, and how long
        // that takes depends on the size of the prompt and what the agent is doing. Waiting
        // for the interface to go quiet is the condition that actually matters — measured at
        // 264ms for a 540-character prompt, but it is the wait, not the number, that counts.
        await waitForIdle(bin, target.orcaHandle, logger);
        await execFileP(bin, ['terminal', 'send', '--terminal', target.orcaHandle, '--enter', '--json']);
      }
    } catch (err) {
      logger.error('orca terminal send failed', err);
      return { ok: false, message: 'Sending to the Orca terminal failed (see log).', target };
    }
    logger.info(`sent batch to Orca terminal ${target.orcaHandle}`);
    return { ok: true, message: `Sent to ${target.label}.`, target };
  }
  return { ok: false, message: `${target.label} is not reachable.`, target };
}

/** Recent output of the target's terminal (for parsing the agent's report-back). */
/**
 * Orca's `terminal read` response. The transcript lives in `result.terminal.tail` as an
 * array of lines — not `result.text`, which is what this used to look for, so every read
 * came back empty and no report was ever applied.
 */
interface TerminalRead {
  tail?: string[];
  limited?: boolean;
  oldestCursor?: string;
  nextCursor?: string;
  latestCursor?: string;
}

/** Pages to follow before giving up — a bound, not an expected count. */
const MAX_READ_PAGES = 20;
/** Lines of terminal history kept; the report is always at the very end. */
const KEEP_LINES = 2000;

async function readPage(handle: string, cursor?: string): Promise<TerminalRead | undefined> {
  const args = ['terminal', 'read', '--terminal', handle];
  if (cursor !== undefined) args.push('--cursor', cursor, '--limit', '1000');
  args.push('--json');
  const { stdout } = await execFileP(await orcaExecutable(), args, { maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { result?: { terminal?: TerminalRead } };
  return parsed.result?.terminal;
}

/**
 * The visible transcript of an Orca terminal.
 *
 * A plain read returns only a one-line tail preview, so the history is paged: start at
 * `oldestCursor`, then follow `nextCursor` while the response is still `limited`. Only the
 * newest `KEEP_LINES` are kept — the agent's report is the last thing it printed.
 */
export async function readTarget(target: SessionTarget, logger: Logger): Promise<string | undefined> {
  if (!target.orcaHandle) return undefined; // VS Code offers no API to read terminal contents
  try {
    const first = await readPage(target.orcaHandle);
    if (!first) return undefined;
    const preview = (first.tail ?? []).join('\n');
    // Annotated: without it `cursor` and `t` infer through each other (TS7022).
    let cursor: string | undefined = first.oldestCursor;
    if (cursor === undefined) return preview || undefined;

    const lines: string[] = [];
    for (let page = 0; page < MAX_READ_PAGES; page++) {
      const t: TerminalRead | undefined = await readPage(target.orcaHandle, cursor);
      if (!t) break;
      lines.push(...(t.tail ?? []));
      if (lines.length > KEEP_LINES) lines.splice(0, lines.length - KEEP_LINES);
      const next = t.nextCursor;
      // Stop at the end of the buffer, and never spin on a cursor that is not advancing.
      if (!t.limited || next === undefined || next === t.latestCursor || next === cursor) break;
      cursor = next;
    }
    return lines.join('\n') || preview || undefined;
  } catch (err) {
    logger.warn('orca terminal read failed', err);
    return undefined;
  }
}

/** Find a target by its remembered key (e.g. the one a batch was sent to). */
export async function targetByKey(key: string, logger: Logger): Promise<SessionTarget | undefined> {
  return (await findTargets(logger)).find((t) => t.key === key);
}
