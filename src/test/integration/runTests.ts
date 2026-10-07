import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-editor-test-'));
  const workspace = path.join(isolated, 'workspace'),
    home = path.join(isolated, 'home'),
    bin = path.join(isolated, 'bin');
  try {
    await fs.mkdir(home);
    await fs.mkdir(bin);
    await fs.mkdir(path.join(isolated, 'user-data', 'User'), { recursive: true });
    await fs.writeFile(
      path.join(isolated, 'user-data', 'User', 'settings.json'),
      JSON.stringify({
        'workbench.startupEditor': 'none',
        'chat.disableAIFeatures': true,
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
      }),
    );
    await fs.cp(path.resolve(extensionDevelopmentPath, 'test-fixtures/workspace'), workspace, {
      recursive: true,
      filter: (source) => path.basename(source) !== '.git',
    });
    // Isolate companion setup and prevent accidental access to live agent inventory.
    for (const name of ['claude', 'orca', 'ps']) {
      await fs.writeFile(
        path.join(bin, name),
        name === 'ps' ? '#!/bin/sh\nexit 0\n' : "#!/bin/sh\nprintf '%s\\n' '[]'\n",
        { mode: 0o755 },
      );
    }
    await runTests({
      ...(process.env.REDLINE_TEST_VSCODE_EXECUTABLE_PATH
        ? { vscodeExecutablePath: process.env.REDLINE_TEST_VSCODE_EXECUTABLE_PATH }
        : {}),
      ...(process.env.REDLINE_TEST_VSCODE_VERSION
        ? { version: process.env.REDLINE_TEST_VSCODE_VERSION }
        : {}),
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        ...(process.env.REDLINE_TEST_TRACE
          ? { REDLINE_TEST_TRACE: process.env.REDLINE_TEST_TRACE }
          : {}),
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        ORCA_CLI_COMMAND: path.join(bin, 'orca'),
        REDLINE_TEST_HOME: home,
      },
      // An isolated HOME has no login keychain. Keep test secrets in memory so macOS
      // cannot block the editor's main thread on a Keychain authorization dialog.
      launchArgs: [
        workspace,
        '--user-data-dir',
        path.join(isolated, 'user-data'),
        '--force-disable-user-env',
        '--disable-extensions',
        '--disable-workspace-trust',
        '--use-inmemory-secretstorage',
      ],
    });
  } finally {
    await fs.rm(isolated, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Failed to run tests', err);
  process.exit(1);
});
