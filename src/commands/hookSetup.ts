import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger';

const exec = promisify(execFile);
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

/** Stage this exact companion version at a path which survives extension updates. */
export async function setUpHook(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  const target = path.join(context.globalStorageUri.fsPath, 'companion');
  await fs.mkdir(path.join(target, '.claude-plugin'), { recursive: true });
  await fs.copyFile(
    path.join(context.extensionUri.fsPath, '.claude-plugin/marketplace.json'),
    path.join(target, '.claude-plugin/marketplace.json'),
  );
  await fs.cp(path.join(context.extensionUri.fsPath, 'plugin'), path.join(target, 'plugin'), {
    recursive: true,
  });
  let installed: Array<{
    id: string;
    version?: string;
    scope?: string;
    enabled?: boolean;
    errors?: string[];
  }> = [];
  let registered = false,
    inspected = false;
  try {
    const [plugins, marketplaces] = await Promise.all([
      exec('claude', ['plugin', 'list', '--json'], { timeout: 15_000 }),
      exec('claude', ['plugin', 'marketplace', 'list', '--json'], { timeout: 15_000 }),
    ]);
    installed = (JSON.parse(plugins.stdout) as typeof installed).filter(
      (p) => p.id === 'redline@redline',
    );
    registered = (JSON.parse(marketplaces.stdout) as Array<{ name: string }>).some(
      (m) => m.name === 'redline',
    );
    inspected = true;
  } catch (error) {
    logger.trace('Claude plugin inventory unavailable', String(error));
  }
  const commands = [
    ...installed.map(
      (p) => `claude plugin uninstall redline@redline --scope ${quote(p.scope ?? 'user')}`,
    ),
    ...(registered ? ['claude plugin marketplace remove redline'] : []),
    `claude plugin marketplace add ${quote(target)}`,
    'claude plugin install redline@redline --scope user',
  ].join('\n');
  const state = installed.length
    ? installed
        .map((p) => `${p.version ?? 'unknown version'} (${p.enabled ? 'enabled' : 'disabled'})`)
        .join(', ')
    : inspected
      ? 'Not installed'
      : 'Could not inspect Claude Code from VS Code’s PATH';
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# Set up Code Redline 2.0\n\nInstalled companion: ${state}.\n\nRun these commands in your terminal to install the bundled 2.0 recorder. They replace only the Redline marketplace/plugin registration; saved runs and accepted-file baselines stay intact.\n\n\`\`\`sh\n${commands}\n\`\`\`\n\n${inspected ? '' : 'If the Redline marketplace is already registered, remove its plugin and marketplace registration first, then rerun the commands above.\n\n'}Restart Claude Code (resume your existing session), then run a prompt. The next completed code-changing prompt appears in Last run.\n\nRemove any manually configured redline-touched hooks from Claude settings to avoid duplicate recorders. Keep other plugins and hooks.\n\nThe 2.0 companion uses only UserPromptSubmit, Stop and StopFailure. It does not receive messages or read Claude’s answers.\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
