import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ChangesView, fileTree } from '../../viewer/changesView';
import { Logger } from '../../logger';

const row = (path: string) => ({ id: path, path, available: true, reviewed: false });
describe('native Changes view', () => {
  describe('opening after an extension update', () => {
    let execute: typeof vscode.commands.executeCommand;
    let notify: typeof vscode.window.showInformationMessage;
    let calls: string[];
    let refreshed: string[];
    let view: ChangesView;
    beforeEach(() => {
      execute = vscode.commands.executeCommand;
      notify = vscode.window.showInformationMessage;
      calls = [];
      refreshed = [];
      view = Object.assign(Object.create(ChangesView.prototype) as ChangesView, {
        logger: new Logger(),
        refresh: async (scope: string) => {
          refreshed.push(scope);
        },
      });
    });
    afterEach(() => {
      vscode.commands.executeCommand = execute;
      vscode.window.showInformationMessage = notify;
    });
    const missingFocus = async (id: string) => {
      calls.push(id);
      if (id === 'redline.changes.focus') {
        throw new Error("command 'redline.changes.focus' not found");
      }
      return undefined;
    };
    it('opens the registered view and then loads the requested scope', async () => {
      vscode.commands.executeCommand = (async (id: string) => {
        calls.push(id);
        return undefined;
      }) as typeof execute;
      await view.show('unreviewed');
      assert.deepEqual(calls, ['redline.changes.focus']);
      assert.deepEqual(refreshed, ['unreviewed']);
    });
    it('offers a window reload when VS Code still has the old view registration', async () => {
      vscode.commands.executeCommand = missingFocus as typeof execute;
      let message = '';
      vscode.window.showInformationMessage = ((text: string, ...actions: string[]) => {
        message = text;
        assert.deepEqual(actions, ['Reload Window']);
        return Promise.resolve('Reload Window');
      }) as unknown as typeof notify;
      await view.show('recent');
      assert.match(message, /Changes view.*Reload this window/);
      assert.deepEqual(calls, ['redline.changes.focus', 'workbench.action.reloadWindow']);
      assert.deepEqual(refreshed, [], 'Do not publish to a view that is not registered');
    });
    it('shares one pending recovery notification across rapid clicks and lets users defer', async () => {
      vscode.commands.executeCommand = missingFocus as typeof execute;
      let notifications = 0;
      let dismiss!: () => void;
      vscode.window.showInformationMessage = (() => {
        notifications++;
        return new Promise<undefined>((resolve) => {
          dismiss = () => resolve(undefined);
        });
      }) as unknown as typeof notify;
      const first = view.show('recent'),
        second = view.show('unreviewed');
      await new Promise((done) => setImmediate(done));
      assert.equal(notifications, 1);
      dismiss();
      await Promise.all([first, second]);
      assert.ok(!calls.includes('workbench.action.reloadWindow'));
      // Dismissing does not permanently hide recovery: the next click can offer it again.
      const retry = view.show('recent');
      await new Promise((done) => setImmediate(done));
      assert.equal(notifications, 2);
      dismiss();
      await retry;
    });
    it('does not misdiagnose other focus errors as an upgrade', async () => {
      const error = new Error('Unexpected view failure');
      vscode.commands.executeCommand = async () => {
        throw error;
      };
      vscode.window.showInformationMessage = (() => {
        assert.fail('Unexpected reload prompt');
      }) as unknown as typeof notify;
      await assert.rejects(view.show('recent'), (actual) => actual === error);
    });
  });
  it('compacts folders while keeping distinct files and correct reveal parents', () => {
    const roots = fileTree([row('src/deep/a.ts'), row('src/deep/b.ts'), row('test/a.ts')]);
    assert.deepEqual(
      roots.map((n) => n.name),
      ['src/deep', 'test'],
    );
    assert.equal(roots[0]?.children?.[0]?.parent, roots[0]);
    assert.deepEqual(
      roots[0]?.children?.map((n) => n.name),
      ['a.ts', 'b.ts'],
    );
    assert.equal(roots[1]?.children?.[0]?.path, 'test/a.ts');
  });
  it('uses native resource icons and exposes acceptance only in Unreviewed', () => {
    const module = vscode as unknown as Record<string, unknown>;
    const old = {
      TreeItem: module.TreeItem,
      TreeItemCollapsibleState: module.TreeItemCollapsibleState,
      TreeItemCheckboxState: module.TreeItemCheckboxState,
    };
    Object.assign(module, {
      TreeItem: class {
        constructor(public label: string) {}
      },
      TreeItemCollapsibleState: { None: 0, Expanded: 2 },
      TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
    });
    try {
      const files = { state: { root: '/workspace', scope: 'recent', pendingIds: [] } };
      const view = Object.assign(Object.create(ChangesView.prototype) as ChangesView, { files });
      const node = fileTree([row('src/main.rs')])[0]!.children![0]!;
      const recent = view.getTreeItem(node);
      assert.equal(recent.resourceUri?.fsPath, '/workspace/src/main.rs');
      assert.equal((recent.iconPath as vscode.ThemeIcon).id, 'file');
      assert.equal(recent.checkboxState, undefined);
      files.state.scope = 'unreviewed';
      assert.equal((view.getTreeItem(node).checkboxState as { state: number }).state, 0);
      assert.equal(view.getTreeItem(node).command?.command, 'redline.openReviewFile');
    } finally {
      Object.assign(module, old);
    }
  });
});
