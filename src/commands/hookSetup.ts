import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger';

const execFileP = promisify(execFile);

/**
 * Setting up the Claude Code side of Redline.
 *
 * The plugin is the supported route: it carries the four hooks, installs with two commands,
 * and needs no editing of `settings.json`. The older arrangement — two scripts copied into
 * `~/.claude` and four blocks merged by hand — still works and is still detected here, but it
 * is no longer what this offers.
 */

/** Hook entries in `settings.json` that point at Redline's own script. */
async function manualHookEvents(): Promise<string[]> {
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(os.homedir(), '.claude', 'settings.json')),
    );
    const settings = JSON.parse(Buffer.from(raw).toString('utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const found: string[] = [];
    for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
      const mine = entries.some((e) => e.hooks?.some((h) => (h.command ?? '').includes('redline-touched')));
      if (mine) found.push(event);
    }
    return found;
  } catch {
    return []; // no settings file, or not readable
  }
}

async function pluginInstalled(logger: Logger): Promise<boolean> {
  try {
    const { stdout } = await execFileP('claude', ['plugin', 'list'], { timeout: 20_000 });
    return /\bredline@/.test(stdout);
  } catch (err) {
    logger.trace(`could not list Claude Code plugins: ${String(err)}`);
    return false;
  }
}

async function openSettings(): Promise<void> {
  const settings = vscode.Uri.file(path.join(os.homedir(), '.claude', 'settings.json'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(settings), { preview: false });
}

export async function setUpHook(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  const commands =
    `claude plugin marketplace add "${context.extensionUri.fsPath}"\n` + 'claude plugin install redline@redline';

  const [installed, manual] = await Promise.all([pluginInstalled(logger), manualHookEvents()]);

  // Both at once means every hook fires twice. The run-start snapshot is the one that breaks:
  // two copies race, one clearing the directory while the other writes into it.
  if (installed && manual.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Redline: the plugin is installed and ~/.claude/settings.json also has Redline hooks (${manual.join(', ')}). ` +
        'Every hook is running twice — remove the manual entries.',
      'Open settings.json',
    );
    if (choice === 'Open settings.json') await openSettings();
    return;
  }

  if (installed) {
    void vscode.window.showInformationMessage(
      'Redline: the Claude Code plugin is installed. Restart Claude Code if you have only just added it.',
    );
    return;
  }

  await vscode.env.clipboard.writeText(commands);
  const doc = await vscode.workspace.openTextDocument({ language: 'shellscript', content: `${commands}\n` });
  await vscode.window.showTextDocument(doc, { preview: false });

  const tail =
    manual.length > 0
      ? ` Then remove the Redline hooks already in ~/.claude/settings.json (${manual.join(', ')}), or they will run twice.`
      : '';
  const choice = await vscode.window.showInformationMessage(
    `Redline: two commands copied to your clipboard — run them, then restart Claude Code.${tail}`,
    ...(manual.length > 0 ? ['Open settings.json'] : []),
  );
  if (choice === 'Open settings.json') await openSettings();
}
