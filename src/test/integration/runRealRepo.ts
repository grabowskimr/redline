import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Opt-in run against a real repository:
 *
 *   REDLINE_TEST_WORKSPACE=/path/to/worktree npm run test:real
 *
 * Separate from the default suite because it needs a large, genuinely dirty git repository,
 * and because it runs *without* `--disable-extensions` — that flag also disables the built-in
 * git extension, which is the very thing the untracked-file path depends on.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/realIndex');
  const workspace = process.env.REDLINE_TEST_WORKSPACE;
  if (!workspace) {
    console.error('Set REDLINE_TEST_WORKSPACE to the repository to test against.');
    process.exit(1);
  }
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error('Failed to run tests', err);
  process.exit(1);
});
