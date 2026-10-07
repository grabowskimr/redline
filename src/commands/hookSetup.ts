import * as vscode from 'vscode';

/** The public GitHub repository Claude Code installs the companion from. */
const MARKETPLACE = 'grabowskimr/redline';

/**
 * A prompt the user pastes into Claude Code, which then installs the companion itself. It is the
 * same on every machine: no local paths, and an older Redline registration is replaced in place.
 */
export const SETUP_PROMPT = `Install the Code Redline recorder plugin for Claude Code by running these shell commands:

1. If \`claude plugin list\` shows \`redline@redline\`, uninstall it with \`claude plugin uninstall redline@redline\`, adding \`--scope\` with the scope it is listed under.
2. If \`claude plugin marketplace list\` shows a marketplace named \`redline\`, remove it with \`claude plugin marketplace remove redline\`.
3. Run \`claude plugin marketplace add ${MARKETPLACE}\`.
4. Run \`claude plugin install redline@redline --scope user\`.
5. Run \`claude plugin list\` and confirm \`redline@redline\` is enabled.

Change nothing else. When it is done, tell me to restart Claude Code (\`claude --continue\` resumes this conversation) so the recorder's hooks load.`;

/** Copy the setup prompt and say where it goes; the prompt itself stays one click away. */
export async function setUpHook(): Promise<void> {
  await vscode.env.clipboard.writeText(SETUP_PROMPT);
  const choice = await vscode.window.showInformationMessage(
    'Setup prompt copied. Paste it into Claude Code and send it.',
    'Show Prompt',
  );
  if (choice === 'Show Prompt') {
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: `# Set up Code Redline\n\nPaste this into Claude Code:\n\n---\n\n${SETUP_PROMPT}\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
