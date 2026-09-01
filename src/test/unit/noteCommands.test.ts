import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { noteCommands } from '../../commands/noteCommands';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';
import { Deps } from '../../commands/deps';
import { applyNoteToThread } from '../../comments/threadFactory';
import { createAnchor } from '../../anchor/anchorService';
import { NewNoteInput, ReviewNote } from '../../model/note';

/**
 * Turning what you typed in the widget into a note.
 *
 * The widget is the editor's, and the editor decides what it looks like from moment to moment —
 * so anything Redline wants to be true of it has to be set at the first instant it can be, not
 * once the work is done.
 */
describe('creating a note from the widget', () => {
  const store = (): ReviewStore =>
    new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, {
      archiveLimit: () => 5,
    });

  const deps = (s: ReviewStore): Deps => {
    const host = { noteIdFor: () => undefined, createWithThread: () => undefined, ensureThread: () => undefined };
    return {
      host,
      context: { subscriptions: [] },
      config: { defaultKind: 'comment', kindPrefixes: true },
      logger: { info: () => undefined, warn: () => undefined, trace: () => undefined },
      store: s,
      git: { snapshot: () => Promise.resolve(undefined) },
      index: { onDidChange: () => ({ dispose: () => undefined }) },
      range: { repoRoot: () => Promise.resolve('/repo') },
      watcher: {},
    } as unknown as Deps;
  };

  /** A thread that remembers when it was told it takes no replies. */
  const thread = (): { canReply: boolean; toldAt: number | undefined; uri: vscode.Uri; range: vscode.Range } => {
    let toldAt: number | undefined;
    let ticks = 0;
    const t = {
      uri: vscode.Uri.file('/repo/a.ts'),
      range: new vscode.Range(0, 0, 0, 4),
      get toldAt() {
        return toldAt;
      },
      get ticks() {
        return ticks;
      },
      set canReply(v: boolean) {
        if (!v) toldAt = ticks;
      },
      get canReply() {
        return toldAt === undefined;
      },
      comments: [] as unknown[],
      dispose: () => undefined,
      bump: () => {
        ticks += 1;
      },
    };
    return t as never;
  };

  beforeEach(() => {
    (vscode as unknown as { resetStub(): void }).resetStub();
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [
      { uri: vscode.Uri.file('/repo') },
    ];
  });

  it('tells the widget it takes no replies before it waits for anything', () => {
    /*
     * The moment the editor accepts what you typed it re-renders the thread, and a thread it
     * has not been told otherwise about offers to be replied to. Everything after this in
     * `createNote` awaits something — reading the file, asking git — so a reply bar appeared
     * under the new note for as long as that took: a visible flash, and an invitation to type
     * into a box that does nothing.
     */
    const t = thread();
    const notes = noteCommands(deps(store()));
    // Deliberately not awaited: the point is that it is already true.
    void notes.createNote({ thread: t, text: 'rename this' } as never);
    assert.equal(t.canReply, false, 'told synchronously, before the first await');
  });

  it('says so rather than creating an empty note', async () => {
    const t = thread();
    const s = store();
    await noteCommands(deps(s)).createNote({ thread: t, text: '   ' } as never);
    assert.equal(s.notes.length, 0);
    assert.ok(
      (vscode as unknown as { shown: { warnings: string[] } }).shown.warnings.some((m) =>
        /write something/.test(m),
      ),
    );
  });

  it('refuses to put a second note on a thread that already has one', async () => {
    // Not reachable through the editor, which only offers this on an empty thread — but the
    // branch that used to be here appended the text as a follow-up, which is the one thing the
    // widget must not do.
    const s = store();
    const d = deps(s);
    (d.host as unknown as { noteIdFor: () => string }).noteIdFor = () => 'already-here';
    await noteCommands(d).createNote({ thread: thread(), text: 'another one' } as never);
    assert.equal(s.notes.length, 0);
  });
});

describe('what a widget shows about a note', () => {
  const note = (over: Partial<ReviewNote> = {}): ReviewNote => {
    const store = new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, {
      archiveLimit: () => 5,
    });
    const range = { startLine: 0, startChar: 0, endLine: 0, endChar: 4 };
    const input: NewNoteInput = {
      path: 'a.ts',
      range,
      anchor: createAnchor('let a = 1;', range),
      body: 'rename this',
    };
    const n = store.add(input);
    return { ...n, ...over };
  };

  it('offers a reply bar once there is something to reply to, and not before', () => {
    /*
     * It was off everywhere, on the reasoning that follow-ups belong on the card — which held
     * while an answered note lost its widget, and stopped holding when it kept it. Reading
     * Claude's answer against the code it is about is exactly when you want to write back.
     *
     * Off on a note nobody has sent, though, and that half matters just as much: the editor
     * re-renders a thread it has not been told otherwise about, so a bar here is one that
     * flashes into view under a note that is still being written.
     */
    const bare = { comments: [] as unknown[], canReply: true, state: 0, contextValue: '', range: undefined, label: '' };
    applyNoteToThread(bare as never, note());
    assert.equal(bare.canReply, false, 'nothing to continue yet — the note is the message');

    const sent = { comments: [] as unknown[], canReply: false, state: 0, contextValue: '', range: undefined, label: '' };
    applyNoteToThread(sent as never, note({ sent: { at: 'now', snippetHash: 'h' } }));
    assert.equal(sent.canReply, true, 'sent: there is a conversation to carry on');
  });

  it('never looks resolved, because a settled note has no widget at all', () => {
    const thread = { comments: [] as unknown[], canReply: true, state: 99, contextValue: '', range: undefined, label: '' };
    applyNoteToThread(thread as never, note({ done: true }));
    assert.equal(thread.state, 0, 'unresolved — the only state a widget can be in');
  });
});
