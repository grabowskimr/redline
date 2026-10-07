import * as vscode from 'vscode';
import * as path from 'node:path';
import { ReviewFiles, ReviewFilesState } from '../view/reviewFiles';
import { ViewerRange } from './range';
import { Logger } from '../logger';

type FileRow = ReviewFilesState['files'][number];
export interface ChangeNode {
  id: string;
  name: string;
  path: string;
  parent?: ChangeNode;
  children?: ChangeNode[];
  file?: FileRow;
}

/** Native resource URIs let VS Code resolve the user's file icon theme itself. */
export function fileTree(files: readonly FileRow[]): ChangeNode[] {
  const roots: ChangeNode[] = [],
    folders = new Map<string, ChangeNode>();
  for (const file of files) {
    const parts = file.path.split('/');
    let parent: ChangeNode | undefined;
    for (let i = 0; i < parts.length - 1; i++) {
      const folder = parts.slice(0, i + 1).join('/');
      let node = folders.get(folder);
      if (!node) {
        node = { id: `folder:${folder}`, name: parts[i]!, path: folder, parent, children: [] };
        (parent?.children ?? roots).push(node);
        folders.set(folder, node);
      }
      parent = node;
    }
    (parent?.children ?? roots).push({
      id: file.id,
      name: parts.at(-1)!,
      path: file.path,
      parent,
      file,
    });
  }
  const compact = (nodes: ChangeNode[]): void => {
    for (const node of nodes) {
      while (node.children?.length === 1 && node.children[0]!.children) {
        const child = node.children[0]!;
        node.name += '/' + child.name;
        node.path = child.path;
        node.children = child.children;
        for (const next of node.children!) next.parent = node;
      }
      if (node.children) compact(node.children);
    }
  };
  compact(roots);
  return roots;
}

export class ChangesView implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly tree: vscode.TreeView<ChangeNode>;
  private nodes: ChangeNode[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private revealedVersion?: number;
  private reloadNotice?: Promise<void>;

  constructor(
    readonly files: ReviewFiles,
    private readonly range: ViewerRange,
    private readonly logger: Logger,
  ) {
    this.tree = vscode.window.createTreeView('redline.changes', {
      treeDataProvider: this,
      showCollapseAll: true,
      manageCheckboxStateManually: true,
    });
    this.subscriptions.push(
      this.tree,
      files.onDidChange(() => this.publish()),
      range.onDidChange(() => this.scheduleRefresh()),
      this.tree.onDidChangeVisibility((e) => {
        if (e.visible) void this.refresh();
      }),
      this.tree.onDidChangeCheckboxState((e) => {
        const ids = e.items
          .filter(([, state]) => state === vscode.TreeItemCheckboxState.Checked)
          .flatMap(([node]) => (node.file ? [node.file.id] : []));
        if (files.state.scope === 'unreviewed' && ids.length) {
          void files
            .markAll(ids)
            .catch((error) => logger.reportError('Could not save acceptance.', error));
        }
      }),
    );
    this.publish();
  }
  getChildren(node?: ChangeNode): ChangeNode[] {
    return node ? (node.children ?? []) : this.nodes;
  }
  getParent(node: ChangeNode): ChangeNode | undefined {
    return node.parent;
  }
  getTreeItem(node: ChangeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.children
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.resourceUri = vscode.Uri.file(path.join(this.files.state.root ?? '', node.path));
    item.iconPath = new vscode.ThemeIcon(node.children ? 'folder' : 'file');
    if (node.file) {
      const file = node.file,
        stats = file.stats,
        pending = this.files.state.pendingIds?.includes(file.id);
      item.description = pending
        ? 'Saving…'
        : stats?.binary
          ? 'Binary'
          : stats
            ? `+${stats.added} −${stats.deleted}`
            : undefined;
      item.tooltip = `${file.path}${file.available ? '\nOpen saved diff' : '\nThis file cannot be compared as a regular file.'}`;
      item.contextValue = file.available ? 'redline.changedFile' : 'redline.unavailableFile';
      item.command = {
        command: 'redline.openReviewFile',
        title: 'Open diff',
        arguments: [file.id],
      };
      if (this.files.state.scope === 'unreviewed' && file.available) {
        item.checkboxState = {
          state: pending
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked,
          tooltip: pending ? 'Saving acceptance' : 'Accept this displayed file version',
        };
      }
    }
    return item;
  }
  private publish(): void {
    if (this.disposed) return;
    const state = this.files.state;
    this.nodes = fileTree(state.files);
    this.tree.title = state.scope === 'unreviewed' ? 'Unreviewed' : 'Last run';
    this.tree.description =
      state.scope === 'unreviewed'
        ? `${state.files.length} left · ${state.acceptedCount ?? 0} accepted`
        : `${state.files.length} ${state.files.length === 1 ? 'file' : 'files'}`;
    const session = this.range.session;
    const context = session
      ? `${session.label} · ${path.basename(session.root)}`
      : 'Choose a Claude Code session';
    this.tree.message =
      state.markError ??
      state.error ??
      `${context}\n${state.scope === 'unreviewed' ? `Since each file’s last acceptance · ${state.baseLabel ?? ''}` : state.label}${this.range.pendingAt ? '\nA prompt is pending; showing the latest completed changes.' : ''}`;
    void vscode.commands.executeCommand('setContext', 'redline.scope', state.scope);
    this.changed.fire(undefined);
    if (state.selectedId && state.selectionVersion !== this.revealedVersion) {
      this.revealedVersion = state.selectionVersion;
      const find = (nodes: ChangeNode[]): ChangeNode | undefined => {
        for (const node of nodes) {
          if (node.id === state.selectedId) return node;
          const child = node.children && find(node.children);
          if (child) return child;
        }
        return undefined;
      };
      const node = find(this.nodes);
      if (node) {
        void this.tree
          .reveal(node, { select: true, focus: false, expand: true })
          .then(undefined, () => undefined);
      }
    }
  }
  scheduleRefresh(): void {
    if (!this.tree.visible || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 250);
  }
  async refresh(
    scope: 'recent' | 'unreviewed' = this.files.state.scope === 'unreviewed'
      ? 'unreviewed'
      : 'recent',
  ): Promise<void> {
    if (this.disposed) return;
    try {
      await this.files.refresh(scope);
    } catch (error) {
      await this.logger.reportError('Could not load changes.', error);
    }
  }
  async show(
    scope: 'recent' | 'unreviewed' = this.files.state.scope === 'unreviewed'
      ? 'unreviewed'
      : 'recent',
  ): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('redline.changes.focus');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "command 'redline.changes.focus' not found"
      ) {
        throw error;
      }
      // During a 1.x upgrade the extension host can load this code while the
      // workbench still has redline.cards registered. Opening the old container
      // cannot repair that manifest mismatch; the window must reload its views.
      this.reloadNotice ??= this.offerReload().finally(() => {
        this.reloadNotice = undefined;
      });
      await this.reloadNotice;
      return false;
    }
    await this.refresh(scope);
    return true;
  }
  private async offerReload(): Promise<void> {
    this.logger.warn(
      'The Changes view focus command is unavailable. Reload the VS Code window to reload its view contributions.',
    );
    const action = await vscode.window.showInformationMessage(
      'VS Code has not loaded Code Redline’s Changes view. Reload this window to finish loading the updated extension.',
      'Reload Window',
    );
    if (action === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
  async pickSession(): Promise<void> {
    const sessions = await this.range.sessions();
    const choices = sessions.map((session) => ({
      label: session.label,
      description: path.basename(session.root),
      detail: `${session.root} · ${session.at}`,
      root: session.root,
      session: session.id as string | undefined,
    }));
    for (const root of this.range.repositories()) {
      if (!sessions.some((session) => session.root === root)) {
        choices.push({
          label: path.basename(root),
          description: 'No recorded session yet',
          detail: root,
          root,
          session: undefined,
        });
      }
    }
    if (!choices.length) {
      void vscode.window.showInformationMessage('Open a Git workspace to review Claude changes.');
      return;
    }
    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Watch Claude Code session',
      placeHolder: 'Only repositories open in this workspace are listed',
    });
    if (selected) {
      this.range.selectRepository(selected.root, selected.session);
      await this.refresh();
    }
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
