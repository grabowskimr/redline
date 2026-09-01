import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { projectSlug } from '../../../claude/transcripts';

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

/**
 * The batch that was just handed over, wherever it went.
 *
 * Not simply the clipboard. With the Claude Code plugin installed — which is how the tool is
 * meant to be run — a send with no session VS Code can type into *stages* the batch for the
 * hook and leaves the delivery word on the clipboard instead of the prompt. Asserting on the
 * clipboard therefore passed or failed on whether the machine running the tests had the plugin
 * set up, which is not something these tests are about.
 */
async function batchText(): Promise<string> {
  const clip = await vscode.env.clipboard.readText();
  if (clip.startsWith('I reviewed the generated code')) return clip;
  for (const outbox of await outboxPaths()) {
    const staged = await readFile(outbox, 'utf8').catch(() => undefined);
    if (staged !== undefined) return staged;
  }
  return clip;
}

/**
 * Every place a staged batch could land, nearest first.
 *
 * Staging goes to the *repository* root, which is not the workspace folder — the fixture is a
 * directory inside this repo — so the walk up is what the extension's own `repoRoot()` does.
 */
async function outboxPaths(): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  let dir = await realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath);
  const out: string[] = [];
  for (;;) {
    out.push(path.join(os.homedir(), '.claude', 'redline', projectSlug(dir), 'outbox.md'));
    const up = path.dirname(dir);
    if (up === dir) return out;
    dir = up;
  }
}

/**
 * Waits for the editor area to actually go quiet, not just for
 * `workbench.action.closeAllEditors` to return.
 *
 * `tabGroups` going empty is necessary but not sufficient: it happens as soon as the tabs
 * are gone from the UI, which measurably happens before the workbench is done with them —
 * closing dozens of diff editors against a repo with real, ongoing changes (what
 * `reviewChanges`/`reviewAllChanges` do here) leaves teardown work in flight that
 * `closeAllEditors`'s own promise does not wait for. A test that returns right after
 * `closeAllEditors` hands that leftover work to whatever runs next, which pays for it as
 * its own time budget — and reads as an unrelated flake in a completely different test.
 * That is what blew "reviews changes and walks them without throwing"'s 20s timeout here:
 * not open tabs, but a workbench still busy after they were closed.
 *
 * There is no stable API that reports "still tearing down", so this polls for the nearest
 * observable proxy: after the tab list is empty, it times a real, cheap open-then-close of
 * an ordinary editor and requires two of those round trips in a row to come back fast. That
 * is the same capability the next editor-opening test needs, so proving it is fast is
 * proving the workbench is actually free to give it — a bounded, real-work check, not a
 * delay that hopes enough time has passed.
 */
async function waitForWorkbenchToSettle(probeUri: vscode.Uri, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (vscode.window.tabGroups.all.some((g) => g.tabs.length > 0)) {
    if (Date.now() >= deadline) return;
    await sleep(50);
  }
  const FAST_MS = 400;
  let consecutiveFast = 0;
  while (consecutiveFast < 2 && Date.now() < deadline) {
    const t0 = Date.now();
    const doc = await vscode.workspace.openTextDocument(probeUri);
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    consecutiveFast = Date.now() - t0 < FAST_MS ? consecutiveFast + 1 : 0;
  }
}

describe('Redline (integration)', function () {
  let sampleUri: vscode.Uri;
  /** What was staged in the real home directory before the suite ran, to be put back after. */
  let staged: ReadonlyArray<readonly [string, string | undefined]> = [];
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
    /*
     * Sending here stages a real batch into the real `~/.claude`, because that is what sending
     * does on a machine with the plugin installed — and it overwrites whatever the person
     * running the tests had waiting there. It cost one, before anyone noticed the suite was
     * doing it. Put back in `after`, whether these pass or not.
     */
    staged = await Promise.all(
      (await outboxPaths()).map(async (p) => [p, await readFile(p, 'utf8').catch(() => undefined)] as const),
    );
  });

  after(async () => {
    for (const [p, was] of staged) {
      if (was === undefined) await rm(p, { force: true });
      else await writeFile(p, was, 'utf8');
    }
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

  it('offers one box per thread state: write the note, or reply to it', async () => {
    /*
     * A widget can be in one of two states and each takes exactly one kind of input. An empty
     * thread takes the note. A thread holding a note takes a follow-up — which the widget was
     * not allowed to do while an answered note lost its widget, because then it was a second
     * box asking for the same thing as the card, about to disappear. The widget stays now.
     *
     * What must not come back is *both* at once, which is what this counts.
     */
    const pkg = vscode.extensions.getExtension(EXT_ID)?.packageJSON as {
      contributes: { menus: Record<string, Array<{ command: string; when: string }>> };
    };
    const entries = pkg.contributes.menus['comments/commentThread/context'] ?? [];
    const empty = entries.filter((e) => /(?<!!)commentThreadIsEmpty/.test(e.when));
    const holding = entries.filter((e) => /!commentThreadIsEmpty/.test(e.when));
    assert.deepEqual(
      empty.map((e) => e.command),
      ['redline.createNote'],
      'a new thread takes the note, and nothing else',
    );
    assert.deepEqual(
      holding.map((e) => e.command),
      ['redline.replyToThread'],
      'a thread holding a note takes a follow-up, and nothing else',
    );
    assert.equal(empty.length + holding.length, entries.length, 'every entry names its state');

    const title = pkg.contributes.menus['comments/commentThread/title'] ?? [];
    for (const gone of ['redline.followUpHere', 'redline.addFollowUp', 'redline.replyToNote', 'redline.cancelReply']) {
      assert.equal(
        [...entries, ...title, ...(pkg.contributes.menus['comments/comment/context'] ?? [])].some(
          (e) => e.command === gone,
        ),
        false,
        `${gone} is gone from the widget`,
      );
    }
  });

  it('can open the note widget on a line, the way the gutter + does', async () => {
    /*
     * The keyboard route to a note. It asks the editor to open the widget rather than building
     * a thread itself — the editor knows where the commentable ranges are, how to focus the
     * box, and what to do when you press Escape. This is the test that the command it leans on
     * actually exists: if a future VS Code drops it, the fallback prompt takes over silently
     * and nobody would notice until they used it.
     */
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('workbench.action.addComment'),
      'the editor still offers a way to open a comment widget',
    );

    const doc = await vscode.workspace.openTextDocument(sampleUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('redline.addNoteHere');
    });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('leaves the editor alone when a change is turned down', async () => {
    // It used to reveal and focus the widget's reply box, moving the cursor into a file you
    // were not editing. The card carries the reason now, and the panel puts the cursor there.
    const note = await api.createNoteAt(sampleUri, new vscode.Range(0, 0, 0, 4), 'turn this down');
    assert.ok(note, 'a note to turn down');
    const doc = await vscode.workspace.openTextDocument(sampleUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    try {
      const before = editor.selection;
      await vscode.commands.executeCommand('redline.needsWork', note.id);
      assert.ok(
        api.store.notes.some((x) => x.id === note.id),
        'the note is still there to carry the reason',
      );
      assert.ok(editor.selection.isEqual(before), 'the cursor has not been moved');
    } finally {
      api.store.delete([note.id]);
    }
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
    try {
      for (const c of pkg.contributes.commands) {
        if (hidden.has(c.command) || interactive.has(c.command)) continue;
        /*
         * Raced, and the picker dismissed after each one.
         *
         * Several of these end in a quick pick, whose promise does not settle until something
         * dismisses it. Opening the next one cancelled the last, which is why this looked like
         * every command returning — until the *final* command in the list opened one, and there
         * was nothing behind it: the loop waited for a person, the test timed out at twenty
         * seconds, and the picker it left open swallowed the input of every test after it. Three
         * failures, one of them here.
         *
         * Which command is last depends on the order in `package.json`, and whether a picker
         * opens at all depends on the machine — this one only shows its list if the plugin has
         * recorded a run for this folder. Neither is something a test should turn on.
         */
        await Promise.race([vscode.commands.executeCommand(c.command), sleep(1500)]);
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      }
    } finally {
      // reviewChanges/reviewAllChanges are in this loop and are not exercised anywhere
      // else — they open a multi-file diff editor against every uncommitted change in
      // whatever repo the test runner sits in, which on a working checkout is dozens of
      // tabs, some pointing at git refs a since-staged rename has made unresolvable. Left
      // open, that pile sat through every later test and made "reviews changes and walks
      // them without throwing" open a second such diff on top of it — the extra editor-
      // resolution load was enough to blow that test's 20s budget on a loaded machine,
      // intermittently. In `finally` so a failed assertion above still leaves a clean
      // editor area for what runs next.
      //
      // Closing is not enough by itself: `closeAllEditors` resolves before the ~90
      // editor/diff models it just closed finish being disposed, so without waiting here
      // the *next* test inherits that teardown mid-flight — which is what actually blew
      // the 20s budget on "reviews changes and walks them", not the open tabs themselves.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitForWorkbenchToSettle(sampleUri);
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
    const text = await batchText();
    assert.ok(text.startsWith('I reviewed the generated code'), 'the batch was handed over');
    assert.ok(text.includes('— src/sample.ts · Line 5'), 'file and 1-based line');
    assert.ok(text.includes('User comment: "Rename to subtract"'), 'body');
    assert.ok(text.includes('export function sub(a: number, b: number): number {'), 'code snippet');
    // Either form of the same contract: the plugin asks for a JSON file, a bare install asks
    // for a line per note in the reply. Which one you get depends on whether the machine has
    // the plugin, which is not what this test is about.
    assert.ok(
      text.includes('## Reporting back') || text.includes('## When you are done'),
      'report-back protocol',
    );

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
    const prompt = await batchText();
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
    const { projectSlug } = await import('../../../claude/transcripts.js');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(folder, 'a workspace to attribute the run to');
    // This window's own directory. The watcher covers every project on the machine and only
    // answers for the ones this window is looking at, so a made-up slug is correctly ignored.
    const dir = path.join(os.homedir(), '.claude', 'redline', projectSlug(folder));
    const log = path.join(dir, 'touched.jsonl');
    const existed = await fs
      .stat(log)
      .then(() => true)
      .catch(() => false);
    const before = api.hookSignals().touched;
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.appendFile(
        log,
        JSON.stringify({ at: new Date().toISOString(), session: 't', file: '/tmp/x.ts', via: 'edit' }) + '\n',
        'utf8',
      );
      const deadline = Date.now() + 15_000;
      while (api.hookSignals().touched === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(api.hookSignals().touched > before, 'the extension saw the hook write the log');
    } finally {
      // Only what this test created: the directory belongs to the machine, not to the test.
      if (!existed) await fs.rm(log, { force: true });
    }
  });

  it('ignores a run in a repository this window is not looking at', async () => {
    // The hook writes one directory per working directory under a tree that is watched whole.
    // Without this filter a run in any other repo woke every open window several times a
    // second — a git recompute and a session discovery each time, for work off screen.
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const dir = path.join(os.homedir(), '.claude', 'redline', `-somewhere-else-${Date.now()}`);
    const before = api.hookSignals().touched;
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(
        path.join(dir, 'touched.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), session: 't', file: '/tmp/y.ts', via: 'edit' }) + '\n',
        'utf8',
      );
      // Long enough for the watcher's debounce and then some.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(api.hookSignals().touched, before, 'not our run, not our problem');
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
