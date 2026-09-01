import * as vscode from 'vscode';
import { execFile, type ChildProcess } from 'node:child_process';
import { Logger } from '../logger';
import { orcaExecutable, SessionTarget, targetByKey } from './claudeSession';

const PROBE_MS = 1500;
const IDLE_POLL_MS = 8000;
const BUSY_CONFIRM_MS = 4000;
const FINISH_CONFIRM_MS = 6000;
const WAIT_CHUNK_MS = 5 * 60 * 1000;
const AWAIT_RUN_GRACE_MS = 90 * 1000;

export type WatchState = 'off' | 'idle' | 'working';

export interface RunEvent {
  target: SessionTarget;
  /** True when the run was started outside the extension (a prompt typed in Orca). */
  external: boolean;
  /**
   * The monitor attached while this run was already in progress (window reload, VS Code
   * started late). The working tree is already half-changed — do not snapshot it.
   */
  midRun?: boolean;
}

/**
 * Standing monitor for the Claude Code session in this workspace (Orca only — VS Code
 * terminals cannot be probed). Detects idle→busy→idle transitions via
 * `orca terminal wait --for tui-idle`, so runs started directly in Orca are seen too:
 * a baseline can be taken when a run starts and the diff offered when it ends.
 */
export class SessionWatcher implements vscode.Disposable {
  private readonly _onRunStarted = new vscode.EventEmitter<RunEvent>();
  readonly onRunStarted = this._onRunStarted.event;
  private readonly _onDidFinish = new vscode.EventEmitter<RunEvent>();
  readonly onDidFinish = this._onDidFinish.event;
  private readonly _onDidChangeState = new vscode.EventEmitter<WatchState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private generation = 0;
  /** In-flight `terminal wait` processes, so dispose can end them. */
  private readonly pending = new Set<ChildProcess>();
  private _state: WatchState = 'off';
  private target: SessionTarget | undefined;
  /** The current (or imminent) run was triggered by a batch send from the extension. */
  private batchRun = false;
  /** Set on watch(): the batch's run hasn't been observed busy yet. */
  private awaitingRunSince: number | undefined;

  constructor(private readonly logger: Logger) {}

  get state(): WatchState {
    return this._state;
  }

  get label(): string {
    return this.target?.label ?? '';
  }

  /** Start (or re-target) the standing monitor. Returns false for non-Orca targets. */
  monitor(target: SessionTarget): boolean {
    if (!target.orcaHandle) return false;
    if (this.target?.key === target.key && this._state !== 'off') return true;
    this.target = target;
    const gen = ++this.generation;
    this.setState('idle');
    void this.loop(target, gen);
    this.logger.info(`monitoring ${target.label}`);
    return true;
  }

  /** A batch was just sent: the next run belongs to it (suppresses the external flow). */
  watch(target: SessionTarget): boolean {
    if (!target.orcaHandle) return false; // unwatchable target: never latch batchRun
    this.batchRun = true;
    this.awaitingRunSince = Date.now();
    const ok = this.monitor(target);
    if (ok) this.setState('working'); // optimistic — the paste is about to start a run
    else this.batchRun = false;
    return ok;
  }

  stop(): void {
    this.generation++;
    this.target = undefined;
    this.batchRun = false;
    this.awaitingRunSince = undefined;
    // The loop can be parked inside a `terminal wait` that runs for minutes. Bumping the
    // generation stops the next iteration, not the one in flight, so without this a child
    // outlives the watcher — and toggling `redline.watchSessions` collects one each time.
    this.killPending();
    this.setState('off');
  }

  private setState(state: WatchState): void {
    this._state = state;
    this._onDidChangeState.fire(state);
  }

  private async loop(target: SessionTarget, gen: number): Promise<void> {
    let current = target;
    let firstObservation = true;
    while (this.generation === gen) {
      // ── idle: cheap probes until the TUI stops being idle ──────────────
      const probe = await this.waitOnce(current, PROBE_MS);
      if (this.generation !== gen) return;
      if (probe === 'idle') firstObservation = false;
      if (probe === 'gone') {
        const fresh = await targetByKey(current.key, this.logger);
        if (!fresh?.orcaHandle) {
          this.logger.info(`session gone: ${current.label}`);
          this.stop();
          return;
        }
        current = fresh;
        continue;
      }
      if (probe === 'idle') {
        if (this._state === 'working' && this.awaitingRunSince !== undefined) {
          // A batch was sent but the run hasn't been observed busy yet (autoSubmit off,
          // user still reading the paste). Don't declare a finish for a run that never
          // started; give it a grace window, then quietly stand down (batchRun stays set
          // so the eventual run is still classified as ours).
          if (Date.now() - this.awaitingRunSince < AWAIT_RUN_GRACE_MS) {
            await delay(IDLE_POLL_MS);
            continue;
          }
          this.awaitingRunSince = undefined;
          this.setState('idle');
          this.logger.info('batch sent but no run observed — standing down');
          continue;
        }
        if (this._state === 'working') {
          // busy → idle: confirm before declaring the run finished.
          await delay(FINISH_CONFIRM_MS);
          if (this.generation !== gen) return;
          if ((await this.waitOnce(current, PROBE_MS)) === 'idle') {
            const external = !this.batchRun;
            this.batchRun = false;
            this.setState('idle');
            this.logger.info(`run finished (${external ? 'external' : 'batch'}): ${current.label}`);
            this._onDidFinish.fire({ target: current, external });
          }
          continue;
        }
        await delay(IDLE_POLL_MS);
        continue;
      }
      // ── busy ────────────────────────────────────────────────────────────
      this.awaitingRunSince = undefined; // the run is real now
      if (this._state !== 'working') {
        // idle → busy: confirm it's a real run, not a rendering blip.
        await delay(BUSY_CONFIRM_MS);
        if (this.generation !== gen) return;
        if ((await this.waitOnce(current, PROBE_MS)) !== 'timeout') continue;
        const midRun = firstObservation;
        this.setState('working');
        this.logger.info(`run started (${this.batchRun ? 'batch' : 'external'}${midRun ? ', attached mid-run' : ''}): ${current.label}`);
        const event: RunEvent = { target: current, external: !this.batchRun };
        if (midRun) event.midRun = true;
        this._onRunStarted.fire(event);
      }
      // Block in long chunks until idle.
      await this.waitOnce(current, WAIT_CHUNK_MS);
    }
  }

  private waitOnce(target: SessionTarget, timeoutMs: number): Promise<'idle' | 'timeout' | 'gone'> {
    return new Promise((resolve) => {
      void orcaExecutable().then((bin) => {
        const child = execFile(
          bin,
          ['terminal', 'wait', '--terminal', target.orcaHandle ?? '', '--for', 'tui-idle', '--timeout-ms', String(timeoutMs), '--json'],
          { timeout: timeoutMs + 30_000, maxBuffer: 1024 * 1024 },
          (err, stdout) => {
            // Observed shapes (Orca): satisfied → exit 0, `{ok:true, result:{wait:{satisfied:true}}}`;
            // timeout → exit 1, `{ok:false, error:{code:"timeout"}}`.
            try {
              const parsed = JSON.parse(String(stdout || '{}')) as {
                ok?: boolean;
                result?: { wait?: { satisfied?: boolean } };
                error?: { code?: string; message?: string };
              };
              if (parsed.ok && parsed.result?.wait?.satisfied) return resolve('idle');
              if (parsed.error?.code === 'timeout' || /timeout/i.test(parsed.error?.message ?? '')) return resolve('timeout');
              if (parsed.ok) return resolve('idle');
            } catch {
              // fall through to the error heuristics
            }
            if (err) {
              if (/timeout|timed.?out/i.test(`${stdout ?? ''}${String(err)}`)) return resolve('timeout');
              this.logger.warn('orca terminal wait failed', err);
              return resolve('gone');
            }
            return resolve('idle');
          },
        );
        // `terminal wait` blocks for up to five minutes. Without this, disposing the watcher
        // (window reload, extension deactivation) leaves that process running.
        this.pending.add(child);
        child.once('exit', () => this.pending.delete(child));
      });
    });
  }

  /** Kill any `terminal wait` still blocking, so nothing outlives the watch that started it. */
  private killPending(): void {
    for (const child of this.pending) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    this.pending.clear();
  }

  dispose(): void {
    this.stop();
    this._onRunStarted.dispose();
    this._onDidFinish.dispose();
    this._onDidChangeState.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
