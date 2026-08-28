import * as vscode from 'vscode';
import { isNoteKind, NoteKind } from './model/note';
import { TraceLevel } from './logger';

export type OutputTemplate = 'claude-prompt' | 'json';

/** What to do when a run finishes, wherever the prompt came from. */
export type OnRunFinished = 'notify' | 'reveal' | 'open' | 'nothing';

/** True when the only value present is the package.json default — i.e. the user set nothing. */
function isDefaultOnly<T>(i: { workspaceFolderValue?: T; workspaceValue?: T; globalValue?: T } | undefined): boolean {
  return (
    i !== undefined &&
    i.workspaceFolderValue === undefined &&
    i.workspaceValue === undefined &&
    i.globalValue === undefined
  );
}

export interface RenderConfig {
  outputTemplate: OutputTemplate;
  includeSnippet: boolean;
  includeGitContext: boolean;
  /** Add "only touch the files listed" to the prompt. */
  scopeGuard: boolean;
  /** Ask the agent to report back per note in a parseable format. */
  requestReport: boolean;
}

const SECTION = 'redline';
/** Pre-rename section; still read so an existing settings.json keeps working. */
const LEGACY_SECTION = 'localReview';

/** How many submitted batches are kept for Restore. */
export const ARCHIVE_LIMIT = 20;

/** Typed accessor over workspace configuration; fires when anything under `redline.*` changes. */
export class Config implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION) || e.affectsConfiguration(LEGACY_SECTION)) this._onDidChange.fire();
    });
  }

  /**
   * A `redline.*` value if the user set one, otherwise the old `localReview.*` value, so
   * settings written before the rename keep working without being rewritten. `inspect`
   * distinguishes "set to the default" from "not set", which `get` cannot.
   */
  private get<T>(key: string, fallback: T): T {
    const current = vscode.workspace.getConfiguration(SECTION).inspect<T>(key);
    const set =
      current?.workspaceFolderValue ??
      current?.workspaceValue ??
      current?.globalValue ??
      current?.defaultValue;
    if (set !== undefined && !isDefaultOnly(current)) return set;
    const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION).inspect<T>(key);
    const legacyValue = legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
    if (legacyValue !== undefined) return legacyValue;
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
  }

  get outputTemplate(): OutputTemplate {
    return this.get<string>('outputTemplate', 'claude-prompt') === 'json' ? 'json' : 'claude-prompt';
  }
  get includeSnippet(): boolean {
    return this.get('includeSnippet', true);
  }
  get includeGitContext(): boolean {
    return this.get('includeGitContext', true);
  }
  get scopeGuard(): boolean {
    return this.get('scopeGuard', true);
  }
  get requestReport(): boolean {
    return this.get('requestReport', true);
  }
  get confirmOnSubmit(): boolean {
    return this.get('confirmOnSubmit', true);
  }
  get defaultKind(): NoteKind {
    const v = this.get<string>('defaultKind', 'comment');
    return isNoteKind(v) ? v : 'comment';
  }
  get kindPrefixes(): boolean {
    return this.get('kindPrefixes', true);
  }
  get claudeAutoSubmit(): boolean {
    return this.get('claudeAutoSubmit', true);
  }
  get clearDoneAfterReport(): boolean {
    return this.get('clearDoneAfterReport', false);
  }
  get watchSessions(): boolean {
    return this.get('watchSessions', true);
  }
  get onRunFinished(): OnRunFinished {
    const v = this.get<string>('onRunFinished', 'notify');
    return v === 'open' || v === 'reveal' || v === 'nothing' ? v : 'notify';
  }
  get excludeGlobs(): string[] {
    const v = this.get<unknown>('excludeGlobs', []);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  }
  get maxFileLines(): number {
    return Math.max(1, Math.floor(this.get('maxFileLines', 50_000)));
  }
  get showStatusBar(): boolean {
    return this.get('showStatusBar', true);
  }
  get trace(): TraceLevel {
    const v = this.get<string>('trace', 'errors');
    return v === 'off' || v === 'verbose' ? v : 'errors';
  }

  renderConfig(): RenderConfig {
    return {
      outputTemplate: this.outputTemplate,
      includeSnippet: this.includeSnippet,
      includeGitContext: this.includeGitContext,
      scopeGuard: this.scopeGuard,
      requestReport: this.requestReport,
    };
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}
