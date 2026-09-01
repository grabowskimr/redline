/**
 * Enough of the editor's API to run the extension's own modules under plain mocha.
 *
 * Half of this codebase imports `vscode`, and until now that put half of it out of reach of
 * the unit suite — the four largest files had no test that so much as loaded them. The
 * integration suite can reach them, but it costs half a minute a run and cannot easily be
 * pointed at one function.
 *
 * Deliberately small and honest: everything here either does the real thing (`Uri.file`,
 * `EventEmitter`, `Position`) or does nothing and records that it was asked. Nothing pretends
 * to an editor behaviour it does not have — a test that needs one is an integration test.
 * Anything not modelled is absent, so a module reaching for it fails loudly rather than
 * quietly seeing `undefined`.
 */

import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private readonly listeners: Array<Listener<T>> = [];
  readonly event = (fn: Listener<T>): { dispose(): void } => {
    this.listeners.push(fn);
    return {
      dispose: (): void => {
        const at = this.listeners.indexOf(fn);
        if (at >= 0) this.listeners.splice(at, 1);
      },
    };
  };
  fire(value: T): void {
    for (const fn of [...this.listeners]) fn(value);
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
}

export class Selection extends Range {}

/** Enough of a URI to be compared, joined and turned back into a path. */
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = '',
    readonly fragment = '',
  ) {}
  static file(p: string): Uri {
    return new Uri('file', p);
  }
  static parse(value: string): Uri {
    const at = value.indexOf(':');
    return new Uri(value.slice(0, at), value.slice(at + 1));
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...parts].join('/'));
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: { scheme?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

/** What the stub was asked to show, so a test can assert on it instead of on a screenshot. */
export const shown: { messages: string[]; warnings: string[]; statusBar: string[] } = {
  messages: [],
  warnings: [],
  statusBar: [],
};

export function resetStub(): void {
  shown.messages.length = 0;
  shown.warnings.length = 0;
  shown.statusBar.length = 0;
  state.trusted = true;
  state.folders = [];
  state.settings = {};
  state.settingDefaults = {};
  state.clipboard = '';
  state.editors.length = 0;
  threads.length = 0;
  (workspace.textDocuments as unknown[]).length = 0;
}

/** Everything a test can set before exercising a module. */
export const state: {
  trusted: boolean;
  folders: Array<{ uri: Uri }>;
  settings: Record<string, unknown>;
  /** What the manifest declares, as distinct from what a user has set. */
  settingDefaults: Record<string, unknown>;
  clipboard: string;
  /** Editors a test has opened. `window.visibleTextEditors` reads this. */
  editors: Array<{ document: unknown }>;
} = { trusted: true, folders: [], settings: {}, settingDefaults: {}, clipboard: '', editors: [] };

/** Every thread any controller made, and whether it is still alive. */
export const threads: Array<{ uri: Uri; disposed: boolean }> = [];

const noop = (): void => undefined;
const disposable = { dispose: noop };

export const window = {
  showInformationMessage: (m: string): Promise<undefined> => {
    shown.messages.push(m);
    return Promise.resolve(undefined);
  },
  showWarningMessage: (m: string): Promise<undefined> => {
    shown.warnings.push(m);
    return Promise.resolve(undefined);
  },
  showErrorMessage: (m: string): Promise<undefined> => {
    shown.warnings.push(m);
    return Promise.resolve(undefined);
  },
  setStatusBarMessage: (m: string): { dispose(): void } => {
    shown.statusBar.push(m);
    return disposable;
  },
  showQuickPick: (): Promise<undefined> => Promise.resolve(undefined),
  showInputBox: (): Promise<undefined> => Promise.resolve(undefined),
  withProgress: <T>(_o: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  get visibleTextEditors(): unknown[] {
    return state.editors;
  },
  activeTextEditor: undefined as unknown,
  onDidChangeVisibleTextEditors: () => disposable,
  onDidChangeActiveTextEditor: () => disposable,
  onDidChangeTextEditorSelection: () => disposable,
  createTextEditorDecorationType: () => ({ dispose: noop }),
  showTextDocument: (): Promise<never> => Promise.reject(new Error('no editor in the stub')),
  terminals: [] as unknown[],
  onDidCloseTerminal: () => disposable,
  // Swallows everything. `Logger` writes here on construction, so any module that logs was
  // otherwise unreachable from these tests.
  createOutputChannel: (): Record<string, unknown> => ({
    appendLine: noop,
    append: noop,
    show: noop,
    clear: noop,
    dispose: noop,
  }),
};

export const workspace = {
  get isTrusted(): boolean {
    return state.trusted;
  },
  get workspaceFolders(): Array<{ uri: Uri }> | undefined {
    return state.folders.length > 0 ? state.folders : undefined;
  },
  textDocuments: [] as unknown[],
  onDidChangeTextDocument: () => disposable,
  onDidOpenTextDocument: () => disposable,
  onDidCloseTextDocument: () => disposable,
  onDidSaveTextDocument: () => disposable,
  onDidRenameFiles: () => disposable,
  onDidDeleteFiles: () => disposable,
  onDidGrantWorkspaceTrust: () => disposable,
  onDidChangeWorkspaceFolders: () => disposable,
  onDidChangeConfiguration: () => disposable,
  createFileSystemWatcher: () => ({
    onDidChange: () => disposable,
    onDidCreate: () => disposable,
    onDidDelete: () => disposable,
    dispose: noop,
  }),
  openTextDocument: (): Promise<never> => Promise.reject(new Error('no document in the stub')),
  /**
   * `inspect` reports where a value came from, and the stub used to lie about it.
   *
   * It put whatever a test had set into `defaultValue` — the slot the real API reserves for
   * the manifest's default — and left every scope field undefined. `Config.get` reads that to
   * decide whether a value was actually chosen by someone (`isDefaultOnly`), so under test the
   * answer was always "no": the `inspect` branch never ran, and the fallback to the old
   * `localReview.*` section it guards was dead code no test could reach. That fallback exists
   * because one setting silently stopped honouring the rename for months.
   *
   * `state.settings` is what a user has set, so it belongs in the workspace slot.
   * `state.settingDefaults` is the manifest's, for a test that needs to tell the two apart.
   */
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback?: T): T | undefined =>
      (state.settings[`${section}.${key}`] as T) ??
      (state.settingDefaults[`${section}.${key}`] as T) ??
      fallback,
    inspect: <T>(key: string) => ({
      key: `${section}.${key}`,
      defaultValue: state.settingDefaults[`${section}.${key}`] as T | undefined,
      globalValue: undefined as T | undefined,
      workspaceValue: state.settings[`${section}.${key}`] as T | undefined,
      workspaceFolderValue: undefined as T | undefined,
    }),
  }),
  /**
   * A real filesystem, because that is what this API is.
   *
   * Stubbing it to do nothing would make every test of anything that stores a file pass
   * without storing one. Tests point it at a temp directory.
   */
  fs: {
    stat: async (uri: Uri) => {
      const s = await nodeFs.stat(uri.fsPath);
      return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    },
    readFile: async (uri: Uri): Promise<Uint8Array> => nodeFs.readFile(uri.fsPath),
    writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
      await nodeFs.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await nodeFs.writeFile(uri.fsPath, content);
    },
    createDirectory: async (uri: Uri): Promise<void> => {
      await nodeFs.mkdir(uri.fsPath, { recursive: true });
    },
    delete: async (uri: Uri, opts?: { recursive?: boolean }): Promise<void> => {
      await nodeFs.rm(uri.fsPath, { recursive: opts?.recursive ?? false, force: true });
    },
    readDirectory: async (uri: Uri): Promise<Array<[string, number]>> => {
      const entries = await nodeFs.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? 2 : 1]);
    },
  },
  /** The folder a file belongs to: the longest configured one that contains it. */
  getWorkspaceFolder: (uri: Uri): { uri: Uri; name: string; index: number } | undefined => {
    let best: { uri: Uri; name: string; index: number } | undefined;
    state.folders.forEach((f, index) => {
      const root = f.uri.fsPath.replace(/\/$/, '');
      if (uri.fsPath === root || uri.fsPath.startsWith(`${root}/`)) {
        if (!best || root.length > best.uri.fsPath.length) {
          best = { uri: f.uri, name: root.slice(root.lastIndexOf('/') + 1), index };
        }
      }
    });
    return best;
  },
  /** A path relative to whichever folder contains it, or the path itself. */
  asRelativePath: (target: Uri | string, _includeFolder?: boolean): string => {
    const full = typeof target === 'string' ? target : target.fsPath;
    for (const f of state.folders) {
      const root = f.uri.fsPath.replace(/\/$/, '');
      if (full.startsWith(`${root}/`)) return full.slice(root.length + 1);
    }
    return full;
  },
};

export const commands = {
  executeCommand: (): Promise<undefined> => Promise.resolve(undefined),
  registerCommand: () => disposable,
};

export const env = {
  clipboard: {
    writeText: (t: string): Promise<void> => {
      state.clipboard = t;
      return Promise.resolve();
    },
    readText: (): Promise<string> => Promise.resolve(state.clipboard),
  },
  openExternal: (): Promise<boolean> => Promise.resolve(true),
};

export const scm = {
  createSourceControl: () => ({
    createResourceGroup: () => ({ resourceStates: [] as unknown[], dispose: noop }),
    inputBox: { visible: true },
    dispose: noop,
    quickDiffProvider: undefined as unknown,
  }),
};

export const comments = {
  createCommentController: (_id: string, label: string) => ({
    label,
    options: {},
    commentingRangeProvider: undefined as unknown,
    createCommentThread: (uri: Uri, range: Range, initial: unknown[]) => {
      const record = { uri, disposed: false };
      threads.push(record);
      return {
        uri,
        range,
        label: '',
        canReply: true,
        contextValue: '',
        collapsibleState: 0,
        state: 0,
        comments: [...initial],
        dispose: (): void => {
          record.disposed = true;
        },
      };
    },
    dispose: noop,
  }),
};


export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
export const CommentThreadState = { Unresolved: 0, Resolved: 1 };
export const CommentMode = { Editing: 0, Preview: 1 };
export const ProgressLocation = { Window: 10, Notification: 15 };
export const ThemeIcon = class {
  constructor(readonly id: string) {}
};
export const ThemeColor = class {
  constructor(readonly id: string) {}
};
export const MarkdownString = class {
  constructor(public value = '') {}
};
export const Disposable = {
  from: (...items: Array<{ dispose(): void }>) => ({
    dispose: (): void => items.forEach((i) => i.dispose()),
  }),
};

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
