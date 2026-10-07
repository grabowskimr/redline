import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from './logger';
import { ViewerRange } from './viewer/range';
import { ChangesView, ChangeNode } from './viewer/changesView';
import { ReviewFiles } from './view/reviewFiles';
import { registerEmptySideProvider } from './git/emptySide';
import { registerTreeSideProvider } from './git/treeSide';
import { gitIn } from './git/savedComparison';
import { repositoryRoot, stateDirectory } from './claude/statePaths';
import { openWorkingFileAction } from './commands/openWorkingFile';
import { setUpHook } from './commands/hookSetup';

export interface RedlineAPI {
  range: ViewerRange;
  files: ReviewFiles;
  view: ChangesView;
  ready: Promise<void>;
}

/** Code Redline 2.0 is a local diff viewer. It never writes to an agent terminal. */
export async function activate(context: vscode.ExtensionContext): Promise<RedlineAPI> {
  const logger = new Logger('Code Redline');
  let disposed = false;
  context.subscriptions.push({
    dispose: () => {
      disposed = true;
    },
  });
  const roots = () =>
    (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => repositoryRoot(folder.uri.fsPath));
  const range = new ViewerRange(roots, context.workspaceState);
  const files = new ReviewFiles(range, context.workspaceState);
  const view = new ChangesView(files, range, logger);
  context.subscriptions.push(
    logger,
    range,
    files,
    view,
    registerEmptySideProvider(),
    registerTreeSideProvider(gitIn, async (candidate) => {
      if (!vscode.workspace.isTrusted || !candidate) return undefined;
      const canonical = await fs.realpath(candidate).catch(() => undefined);
      return canonical && roots().includes(canonical) ? canonical : undefined;
    }),
  );

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'redline.reviewChanges': () => view.show('recent'),
    'redline.reviewUnreviewed': () => view.show('unreviewed'),
    'redline.pickSession': () => view.pickSession(),
    'redline.refresh': () => {
      range.invalidate();
      return view.refresh();
    },
    'redline.openReviewFile': (value) =>
      files.open(typeof value === 'string' ? value : ((value as ChangeNode)?.file?.id ?? '')),
    'redline.openWorkingFile': openWorkingFileAction(files),
    'redline.markAllReviewed': () =>
      files.state.scope === 'unreviewed' ? files.markAll() : undefined,
    'redline.markReviewed': (value) => {
      const id = typeof value === 'string' ? value : (value as ChangeNode)?.file?.id;
      return id && files.state.scope === 'unreviewed' ? files.mark(id, true) : undefined;
    },
    'redline.nextUnreviewed': async () => {
      if (files.state.scope !== 'unreviewed' && !(await view.show('unreviewed'))) return;
      return files.nextUnreviewed();
    },
    'redline.setUpHook': () => setUpHook(context, logger),
    'redline.showLog': () => logger.show(),
    'redline.focusPanel': () => view.show(),
  };
  for (const [id, command] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await command(...args);
        } catch (error) {
          await logger.reportError('Could not complete the review action.', error);
          return undefined;
        }
      }),
    );
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.command = 'redline.focusPanel';
  const updateStatus = () => {
    logger.setLevel(vscode.workspace.getConfiguration('redline').get('trace', 'errors'));
    status.text = `$(diff) Redline${files.state.root ? ` ${files.state.files.length}` : ''}`;
    status.tooltip = 'Code Redline — open Claude Code changes';
    if (vscode.workspace.getConfiguration('redline').get('showStatusBar', true)) status.show();
    else status.hide();
  };
  context.subscriptions.push(
    status,
    files.onDidChange(updateStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(() => range.invalidate()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => range.invalidate()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('redline')) {
        updateStatus();
        range.invalidate();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (files.state.scope === 'unreviewed' && vscode.workspace.getWorkspaceFolder(doc.uri)) {
        range.invalidate();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        files.state.scope === 'unreviewed' &&
        event.document.uri.scheme === 'file' &&
        vscode.workspace.getWorkspaceFolder(event.document.uri) &&
        event.contentChanges.length
      ) {
        view.scheduleRefresh();
      }
    }),
  );
  updateStatus();
  // Native file events also cover edits made outside VS Code. Ignore Git's object/ref
  // writes so capturing and accepting a snapshot cannot trigger a refresh loop.
  const workingFiles = vscode.workspace.createFileSystemWatcher('**/*');
  const workingChanged = (uri: vscode.Uri) => {
    if (
      files.state.scope !== 'unreviewed' ||
      !view.tree.visible ||
      !vscode.workspace.getWorkspaceFolder(uri)
    ) {
      return;
    }
    if (uri.path.split('/').includes('.git')) return;
    range.invalidate();
  };
  context.subscriptions.push(
    workingFiles,
    workingFiles.onDidCreate(workingChanged),
    workingFiles.onDidChange(workingChanged),
    workingFiles.onDidDelete(workingChanged),
  );

  // One event source for all workspace repositories. No recursive transcript watcher,
  // session-process polling, webview messaging, or per-tool activity updates.
  const ready = (async () => {
    const directory = path.join(os.homedir(), '.claude', 'redline');
    await fs.mkdir(directory, { recursive: true });
    if (disposed) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(directory), 'repo-*/runs.json'),
    );
    const changed = (uri: vscode.Uri) => {
      if (roots().some((root) => path.dirname(uri.fsPath) === stateDirectory(root))) {
        range.invalidate();
      }
    };
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(changed),
      watcher.onDidChange(changed),
      watcher.onDidDelete(changed),
    );
    if (view.tree.visible) await view.refresh();
  })().catch((error) => logger.reportError('Could not watch Claude run records.', error));
  return { range, files, view, ready };
}
export function deactivate(): void {}
