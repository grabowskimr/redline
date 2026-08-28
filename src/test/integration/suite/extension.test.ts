import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXT_ID = 'marcin.redline';

interface Api {
  store: {
    notes: readonly {
      id: string;
      seq: number;
      done: boolean;
      sent?: { outcome?: string; reply?: string };
    }[];
    hasArchive: boolean;
    clear(): void;
    clearSent(): number;
    update(id: string, patch: Record<string, unknown>): void;
    delete(ids: string[]): void;
  };
  replyOpenOn: (noteId: string) => boolean;
  createNoteAt: (u: vscode.Uri, r: vscode.Range, b: string) => Promise<{ id: string; seq: number } | undefined>;
  panelReady: (timeoutMs?: number) => Promise<boolean>;
  attachFile: (noteId: string, name: string, bytes: Uint8Array) => Promise<string | undefined>;
  attachPaths: (noteId: string, paths: string[]) => Promise<string[]>;
  hookSignals: () => { touched: number; ended: number };
  activationMs: () => number;
}

/** The smallest valid PNG (1×1, transparent). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Redline (integration)', function () {
  let sampleUri: vscode.Uri;
  let api: Api;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension present');
    api = (await ext.activate()) as Api;
    assert.ok(api?.store, 'api exported');
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'workspace folder open');
    sampleUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'sample.ts'));
    await vscode.workspace
      .getConfiguration('redline')
      .update('confirmOnSubmit', false, vscode.ConfigurationTarget.Workspace);
    api.store.clear();
  });

  it('activates quickly and off the startup path', async () => {
    // The activation event is onStartupFinished, so this never delays opening VS Code — but
    // it still runs on every window, and anything slow here is felt as a sluggish editor.
    const ms = api.activationMs();
    console.log(`      activation: ${ms}ms`);
    assert.ok(ms < 1500, `activation took ${ms}ms`);
    const pkg = vscode.extensions.getExtension(EXT_ID)?.packageJSON as { activationEvents: string[] };
    assert.deepEqual(pkg.activationEvents, ['onStartupFinished'], 'not on the startup critical path');
  });

  it('registers every contributed command', async () => {
    const all = await vscode.commands.getCommands(true);
    const pkg = vscode.extensions.getExtension(EXT_ID)?.packageJSON as {
      contributes: { commands: Array<{ command: string }> };
    };
    for (const c of pkg.contributes.commands) {
      assert.ok(all.includes(c.command), `${c.command} registered`);
    }
  });

  it('binds a submit action to the reply box in both thread states', async () => {
    // Without this, an existing note's reply box has no command behind it: typing and
    // pressing ⌘⏎ does nothing at all, which cannot be diagnosed from the outside.
    const pkg = vscode.extensions.getExtension(EXT_ID)?.packageJSON as {
      contributes: { menus: { 'comments/commentThread/context': Array<{ command: string; when: string }> } };
    };
    const entries = pkg.contributes.menus['comments/commentThread/context'];
    const empty = entries.find((e) => /(?<!!)commentThreadIsEmpty/.test(e.when));
    const existing = entries.find((e) => e.when.includes('!commentThreadIsEmpty'));
    assert.ok(empty, 'a new thread can be submitted');
    assert.ok(existing, 'an existing note can be replied to');
    assert.notEqual(empty.command, existing.command, 'the two states run different commands');

    // Escape only fires while the box has focus, so clicking it by accident and then clicking
    // away must still leave a visible way out.
    const cancel = entries.find((e) => e.command === 'redline.cancelReply');
    assert.ok(cancel, 'the reply box offers a cancel action');
  });

  it('keeps the follow-up box closed until the toolbar asks for it', async () => {
    // The box used to sit under every note whether or not anything was being written in it,
    // below a card that already carries the note, the answer and a row of actions.
    const note = await api.createNoteAt(sampleUri, new vscode.Range(0, 0, 0, 4), 'toolbar follow-up');
    assert.ok(note, 'a note to attach a widget to');
    // The widget is on screen when its toolbar is clicked, which is what both commands
    // resolve the thread from.
    await vscode.window.showTextDocument(sampleUri, { preview: false });
    try {
      assert.equal(api.replyOpenOn(note.id), false, 'no reply box until asked');

      await vscode.commands.executeCommand('redline.followUpHere', note.id);
      assert.equal(api.replyOpenOn(note.id), true, 'the toolbar opens it');

      // And it survives the store changing underneath, which happens while you type in it.
      api.store.update(note.id, { body: 'toolbar follow-up, edited' });
      assert.equal(api.replyOpenOn(note.id), true, 'still open after a refresh');

      await vscode.commands.executeCommand('redline.cancelReply');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(api.replyOpenOn(note.id), false, 'cancel closes it again');
    } finally {
      api.store.delete([note.id]);
    }
  });

  it('offers the follow-up button on the widget toolbar, not only in the reply box', () => {
    const pkg = vscode.extensions.getExtension(EXT_ID)?.packageJSON as {
      contributes: { menus: Record<string, Array<{ command: string; when: string; group?: string }>> };
    };
    const title = pkg.contributes.menus['comments/commentThread/title'] ?? [];
    const entry = title.find((e) => e.command === 'redline.followUpHere');
    assert.ok(entry, 'the widget toolbar offers it');
    assert.match(entry.when, /!commentThreadIsEmpty/, 'a thread with no note has nothing to follow up');

    // Beside send, and before it: writing the follow-up is what you do first. The toolbar is a
    // row of icons with nothing to explain them, so their order is the only grouping there is.
    const rank = (command: string): number =>
      Number(/navigation@([\d.]+)/.exec(title.find((e) => e.command === command)?.group ?? '')?.[1] ?? NaN);
    assert.ok(rank('redline.followUpHere') < rank('redline.sendSelected'), 'follow-up comes before send');
    assert.equal(rank('redline.sendSelected') - rank('redline.followUpHere'), 1, 'with nothing between them');
  });

  it('runs every palette-safe command with no arguments without throwing', async () => {
    const pkg = vscode.extensions.getExtension(EXT_ID)?.packageJSON as {
      contributes: { commands: Array<{ command: string }>; menus: { commandPalette: Array<{ command: string }> } };
    };
    const hidden = new Set(pkg.contributes.menus.commandPalette.map((m) => m.command));
    // Commands that open modal or blocking UI are exercised by hand.
    const interactive = new Set([
      'redline.quickAddNote',
      'redline.clearAll',
      'redline.submit',
      'redline.pickSession',
      'redline.applyReport',
      // Waits on a dialog button, and writes into the real ~/.claude — not something a
      // test run should do to the machine it runs on.
      'redline.setUpHook',
    ]);
    for (const c of pkg.contributes.commands) {
      if (hidden.has(c.command) || interactive.has(c.command)) continue;
      await vscode.commands.executeCommand(c.command);
    }
  });

  it('boots the panel webview (the script loads and reports ready)', async () => {
    await vscode.commands.executeCommand('redline.focusPanel');
    assert.equal(await api.panelReady(15_000), true, 'panel webview reported ready');
  });

  it('creates a note, sends it, keeps it as sent, and applies a report', async () => {
    api.store.clear();
    const doc = await vscode.workspace.openTextDocument(sampleUri);
    await vscode.window.showTextDocument(doc);

    const note = await api.createNoteAt(sampleUri, new vscode.Range(4, 0, 5, 0), 'Rename to subtract');
    assert.ok(note, 'note created');
    assert.equal(api.store.notes.length, 1);

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('redline.submit');
    await sleep(400);
    const text = await vscode.env.clipboard.readText();
    assert.ok(text.startsWith('I reviewed the generated code'), 'clipboard holds the prompt');
    assert.ok(text.includes('— src/sample.ts · Line 5'), 'file and 1-based line');
    assert.ok(text.includes('User comment: "Rename to subtract"'), 'body');
    assert.ok(text.includes('export function sub(a: number, b: number): number {'), 'code snippet');
    assert.ok(text.includes('## When you are done'), 'report-back protocol');

    const sent = api.store.notes[0];
    assert.ok(sent?.sent, 'note kept as sent');

    await vscode.env.clipboard.writeText(`#${sent?.seq} skipped — not needed`);
    await vscode.commands.executeCommand('redline.applyReport');
    await sleep(300);
    assert.equal(api.store.notes[0]?.sent?.outcome, 'skipped');
    assert.equal(api.store.notes[0]?.sent?.reply, 'not needed');
    assert.equal(api.store.clearSent(), 1);
    assert.equal(api.store.notes.length, 0);
  });

  it('attaches an image to a note and stores it outside the repo (picker / paste path)', async () => {
    api.store.clear();
    const note = await api.createNoteAt(sampleUri, new vscode.Range(1, 0, 1, 0), 'needs a screenshot');
    assert.ok(note, 'note created');
    const stored = await api.attachFile(note.id, 'shot.png', PNG);
    assert.ok(stored, 'attachment path returned');
    assert.ok(stored.endsWith('.png'), 'kept the extension');
    assert.ok(!stored.includes('/test-fixtures/'), 'stored outside the workspace');
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(stored));
    assert.equal(bytes.length, PNG.length, 'bytes written verbatim');
    const attachments = (api.store.notes[0] as { attachments?: string[] }).attachments ?? [];
    assert.deepEqual(attachments, [stored], 'note references the file');

    // The prompt must hand the agent a path it can read.
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('redline.submit');
    await sleep(400);
    const prompt = await vscode.env.clipboard.readText();
    assert.ok(prompt.includes(`Screenshot: ${stored}`), 'prompt references the screenshot');
    api.store.clearSent();
  });

  it('attaches images given as file paths and skips non-images', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    api.store.clear();
    const note = await api.createNoteAt(sampleUri, new vscode.Range(1, 0, 1, 0), 'paths');
    assert.ok(note);

    const dir = path.join(os.tmpdir(), `lr-drop-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const image = path.join(dir, 'shot.png');
    const other = path.join(dir, 'notes.txt');
    await fs.writeFile(image, PNG);
    await fs.writeFile(other, 'nope');

    const stored = await api.attachPaths(note.id, [image, other, path.join(dir, 'missing.png')]);
    assert.equal(stored.length, 1, 'only the readable image was attached');
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(stored[0] ?? ''));
    assert.equal(bytes.length, PNG.length);
    const attached = (api.store.notes[0] as { attachments?: string[] }).attachments ?? [];
    assert.deepEqual(attached, stored);
    api.store.clear();
  });

  it('rejects an oversized file and a directory without attaching anything', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    api.store.clear();
    const note = await api.createNoteAt(sampleUri, new vscode.Range(1, 0, 1, 0), 'limits');
    assert.ok(note);
    const dir = path.join(os.tmpdir(), `lr-limits-${Date.now()}`);
    await fs.mkdir(path.join(dir, 'folder.png'), { recursive: true });
    const big = path.join(dir, 'big.png');
    await fs.writeFile(big, Buffer.alloc(21 * 1024 * 1024));
    const stored = await api.attachPaths(note.id, [big, path.join(dir, 'folder.png')]);
    assert.deepEqual(stored, [], 'nothing attached');
    assert.equal(((api.store.notes[0] as { attachments?: string[] }).attachments ?? []).length, 0);
    api.store.clear();
  });

  it('reacts to a hook signal instead of waiting for a timer', async () => {
    // The push channel replaced polling for "has the agent changed anything yet". If this
    // regresses, the panel silently falls back to a 30-second backstop.
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const dir = path.join(os.homedir(), '.claude', 'redline', `-redline-test-${Date.now()}`);
    const before = api.hookSignals().touched;
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(
        path.join(dir, 'touched.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), session: 't', file: '/tmp/x.ts', via: 'edit' }) + '\n',
        'utf8',
      );
      const deadline = Date.now() + 15_000;
      while (api.hookSignals().touched === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(api.hookSignals().touched > before, 'the extension saw the hook write the log');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reviews changes and walks them without throwing', async () => {
    await vscode.commands.executeCommand('redline.reviewChanges');
    await vscode.commands.executeCommand('redline.nextChange');
    await vscode.commands.executeCommand('redline.prevChange');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('delivers bracketed-paste bytes to a terminal intact', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const out = path.join(os.tmpdir(), `lr-paste-${Date.now()}.txt`);
    const term = vscode.window.createTerminal({ name: 'lr-paste', shellPath: '/bin/sh' });
    await sleep(1500);
    term.sendText(`cat -v > ${out}`, true);
    await sleep(500);
    const ESC = String.fromCharCode(27);
    term.sendText(`${ESC}[200~line one\rline two${ESC}[201~`, true);
    await sleep(500);
    term.sendText(String.fromCharCode(4), false);
    await sleep(900);
    const text = await fs.readFile(out, 'utf8').catch(() => '');
    term.dispose();
    // A cooked tty maps CR→LF for `cat`; a raw-mode TUI receives the CR itself.
    assert.ok(/\^\[\[200~line one(\^M|\n)line two\^\[\[201~/.test(text), `got: ${JSON.stringify(text)}`);
  });
});
