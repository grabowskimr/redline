import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger';

const execFileP = promisify(execFile);

/** Where the plugin is published. Stable across extension updates, unlike an install path. */
const MARKETPLACE = 'grabowskimr/redline';

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

/**
 * Whether the plugin is installed, and whether Claude Code could actually load it.
 *
 * The two are not the same, and the difference is invisible without asking: a manifest that
 * Claude Code rejects still installs, still reports its version, and simply never runs — which
 * looks exactly like a working install with nothing to say. `plugin list` prints the reason on
 * the line after the status, so it is carried through to the message rather than swallowed.
 */
async function pluginState(logger: Logger): Promise<{ installed: boolean; error?: string }> {
  try {
    const { stdout } = await execFileP('claude', ['plugin', 'list'], { timeout: 20_000 });
    const lines = stdout.split('\n');
    const at = lines.findIndex((l) => /\bredline@/.test(l));
    if (at < 0) return { installed: false };
    // The entry's own block, up to the next plugin.
    const block = lines.slice(at, at + 8);
    const stop = block.findIndex((l, i) => i > 0 && /^\s*❯/.test(l));
    const own = stop > 0 ? block.slice(0, stop) : block;
    if (!own.some((l) => /failed to load/i.test(l))) return { installed: true };
    const reason = own.find((l) => /^\s*Error:/.test(l));
    return { installed: true, error: (reason ?? '').replace(/^\s*Error:\s*/, '').trim() || 'Claude Code could not load it' };
  } catch (err) {
    logger.trace(`could not list Claude Code plugins: ${String(err)}`);
    return { installed: false };
  }
}

async function openSettings(): Promise<void> {
  const settings = vscode.Uri.file(path.join(os.homedir(), '.claude', 'settings.json'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(settings), { preview: false });
}

export async function setUpHook(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  // From the repository, not from this directory. An extension's install path carries its
  // version, so a marketplace registered against it stops resolving the moment the extension
  // updates — and `claude plugin update` then fails with nothing to point at. The local path is
  // offered underneath for anyone working offline or on an unreleased build.
  const commands = `claude plugin marketplace add ${MARKETPLACE}\nclaude plugin install redline@redline`;
  const offline = `claude plugin marketplace add "${context.extensionUri.fsPath}"`;

  const [state, manual] = await Promise.all([pluginState(logger), manualHookEvents()]);
  const installed = state.installed;

  // Installed but rejected: the hooks never run, and nothing else says so.
  if (state.error) {
    const choice = await vscode.window.showWarningMessage(
      `Redline: the Claude Code plugin is installed but failed to load, so none of its hooks are running. ${state.error}`,
      'Update the plugin',
    );
    if (choice === 'Update the plugin') {
      await vscode.env.clipboard.writeText('claude plugin update redline');
      void vscode.window.showInformationMessage(
        'Redline: `claude plugin update redline` copied to your clipboard. Run it, then restart Claude Code.',
      );
    }
    return;
  }

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
  const doc = await vscode.workspace.openTextDocument({
    language: 'shellscript',
    content: `${commands}\n\n# Offline, or testing a build that is not released yet:\n# ${offline}\n`,
  });
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
