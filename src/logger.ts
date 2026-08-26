import * as vscode from 'vscode';

export type TraceLevel = 'off' | 'errors' | 'verbose';

/**
 * Thin wrapper around an OutputChannel. Verbosity is controlled by `redline.trace`.
 * Never throws.
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private level: TraceLevel = 'errors';

  constructor(name = 'Redline') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  setLevel(level: TraceLevel): void {
    this.level = level;
  }

  show(): void {
    this.channel.show(true);
  }

  trace(message: string, ...details: unknown[]): void {
    if (this.level !== 'verbose') return;
    this.write('TRACE', message, details);
  }

  info(message: string, ...details: unknown[]): void {
    if (this.level === 'off') return;
    this.write('INFO ', message, details);
  }

  warn(message: string, ...details: unknown[]): void {
    if (this.level === 'off') return;
    this.write('WARN ', message, details);
  }

  error(message: string, err?: unknown, ...details: unknown[]): void {
    if (this.level === 'off') return;
    const errText = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err !== undefined ? String(err) : '';
    this.write('ERROR', errText ? `${message}: ${errText}` : message, details);
  }

  /**
   * Log an error and show a single non-modal warning toast with a "Show log" action.
   */
  async reportError(userMessage: string, err?: unknown): Promise<void> {
    this.error(userMessage, err);
    try {
      const choice = await vscode.window.showWarningMessage(`Redline: ${userMessage}`, 'Show log');
      if (choice === 'Show log') this.show();
    } catch {
      // never throw from error reporting
    }
  }

  private write(tag: string, message: string, details: unknown[]): void {
    try {
      const ts = new Date().toISOString();
      let line = `[${ts}] ${tag} ${message}`;
      if (details.length > 0) {
        line +=
          ' ' +
          details
            .map((d) => {
              try {
                return typeof d === 'string' ? d : JSON.stringify(d);
              } catch {
                return String(d);
              }
            })
            .join(' ');
      }
      this.channel.appendLine(line);
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.channel.dispose();
  }
}
