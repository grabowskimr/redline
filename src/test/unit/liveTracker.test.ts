import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { LiveTracker } from '../../anchor/liveTracker';
import { NoteIndex } from '../../view/noteIndex';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';
import { createAnchor } from '../../anchor/anchorService';
import { NewNoteInput, ReviewNote, SerialRange } from '../../model/note';

/**
 * The machinery behind "notes follow their code".
 *
 * It is the promise at the top of the README and the thing that makes a review survive the
 * agent rewriting a file underneath it — and it had no test that so much as loaded the file.
 * `anchorService`, the pure matching underneath, is well covered; this is the layer that
 * decides *when* to match, what to do with the answer, and what to leave alone.
 */
describe('keeping notes on their code while a file changes', () => {
  const FILE = '/repo/src/price.ts';
  const BEFORE = ['function total(items) {', '  const base = sum(items);', '  return base;', '}'].join('\n');

  const store = (): ReviewStore =>
    new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, {
      archiveLimit: () => 5,
    });

  /** A whole-line selection, the way the editor hands one over. */
  const range = (startLine: number, endLine: number, text = BEFORE): SerialRange => ({
    startLine,
    startChar: 0,
    endLine,
    endChar: (text.split('\n')[endLine] ?? '').length,
  });

  const note = (s: ReviewStore, at: SerialRange, text = BEFORE, body = 'why the early return?'): ReviewNote => {
    const input: NewNoteInput = {
      path: 'src/price.ts',
      // The folder's *name*, which is what a note stores and what the tracker matches on.
      workspaceFolder: 'repo',
      range: at,
      anchor: createAnchor(text, at),
      body,
    };
    return s.add(input);
  };

  /** A document the tracker can read, which is all it asks of one. */
  const doc = (text: string): vscode.TextDocument =>
    ({
      uri: vscode.Uri.file(FILE),
      getText: () => text,
      lineCount: text.split('\n').length,
    }) as unknown as vscode.TextDocument;

  const tracker = (s: ReviewStore): LiveTracker =>
    new LiveTracker(
      s,
      { threadFor: () => undefined } as never,
      {
        setChangedSinceSent: () => undefined,
        clearChangedSinceSent: () => undefined,
        setLinesChanged: () => undefined,
      } as never,
      { info: () => undefined, warn: () => undefined, trace: () => undefined } as never,
    );

  beforeEach(() => {
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [
      { uri: vscode.Uri.file('/repo') },
    ];
  });

  it('follows the code when the agent inserts lines above it', () => {
    // The everyday case: the agent adds an import, and every note below it is now on the wrong
    // line number. The note is found by what it says, not by where it was.
    const s = store();
    const n = note(s, range(2, 2));
    const t = tracker(s);
    try {
      t.resolveText(vscode.Uri.file(FILE), ['import { sum } from "./sum";', '', BEFORE].join('\n'));
      const after = s.getById(n.id)!;
      assert.equal(after.range.startLine, 4, 'moved down by the two lines added above it');
      assert.ok(!after.anchor.orphaned, 'and not orphaned');
    } finally {
      t.dispose();
    }
  });

  it('marks a note orphaned when its code is gone, and never deletes it', () => {
    // A note is the record of something a person asked for. Losing the code it pointed at is a
    // reason to flag it, never a reason to throw the question away.
    const s = store();
    const n = note(s, range(2, 2));
    const t = tracker(s);
    try {
      t.resolveText(vscode.Uri.file(FILE), 'function total() {\n  return 0;\n}');
      const after = s.getById(n.id)!;
      assert.equal(after.anchor.orphaned, true);
      assert.equal(s.notes.length, 1, 'still there');
      assert.equal(after.body, 'why the early return?', 'and still says what was asked');
    } finally {
      t.dispose();
    }
  });

  it('leaves the snapshot of what you highlighted alone as the code moves', () => {
    /*
     * The anchor's own snippet is a search key and has to follow the file. What the card shows
     * is a separate record of what you were looking at — and for a while they were the same
     * field, so the lines under a comment quietly became whatever had just been written there.
     */
    const s = store();
    const n = note(s, range(2, 2));
    s.update(n.id, { snapshot: { code: '  return base;', startLine: 2 } });
    const t = tracker(s);
    try {
      t.resolveText(vscode.Uri.file(FILE), BEFORE.replace('  return base;', '  return applyTax(base);'));
      const after = s.getById(n.id)!;
      assert.equal(after.snapshot?.code, '  return base;', 'the record does not move');
    } finally {
      t.dispose();
    }
  });

  it('does nothing at all for a file with no notes in it', () => {
    // It runs on every document change in the workspace, so the common case has to be free.
    const s = store();
    let updates = 0;
    s.onDidChange(() => {
      updates += 1;
    });
    const t = tracker(s);
    try {
      t.resolveText(vscode.Uri.file('/repo/src/other.ts'), 'anything at all');
      assert.equal(updates, 0);
    } finally {
      t.dispose();
    }
  });

  it('leaves a note alone when the file has not changed under it', () => {
    // Re-resolving to the same place must not write to the store: every write repaints the
    // panel, and this runs on open, on save and on every external change.
    const s = store();
    note(s, range(2, 2));
    const t = tracker(s);
    let updates = 0;
    s.onDidChange(() => {
      updates += 1;
    });
    try {
      t.resolveText(vscode.Uri.file(FILE), BEFORE);
      assert.equal(updates, 0, 'nothing moved, so nothing was written');
    } finally {
      t.dispose();
    }
  });

  it('brings an orphaned note back when its code returns', () => {
    // Claude deletes a block, you ask for it back, it comes back. The note should come with it
    // rather than staying flagged for ever.
    const s = store();
    const n = note(s, range(2, 2));
    const t = tracker(s);
    try {
      t.resolveText(vscode.Uri.file(FILE), 'function total() {\n  return 0;\n}');
      assert.equal(s.getById(n.id)?.anchor.orphaned, true);
      t.resolveText(vscode.Uri.file(FILE), BEFORE);
      assert.equal(s.getById(n.id)?.anchor.orphaned, false, 'found again');
    } finally {
      t.dispose();
    }
  });

  it('resolves a document by reading it, so an editor opening is enough', () => {
    const s = store();
    const n = note(s, range(2, 2));
    const t = tracker(s);
    try {
      t.resolveDocument(doc(['', '', BEFORE].join('\n')));
      assert.equal(s.getById(n.id)?.range.startLine, 4);
    } finally {
      t.dispose();
    }
  });
});

describe('the signal that decides whether a widget stays', () => {
  const newStore = (): ReviewStore =>
    new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, { archiveLimit: () => 5 });

  /*
   * `NoteIndex.linesChanged` is the whole of the widget-lifetime rule: a note keeps its inline
   * widget until the code under it moves. Nothing tested the producer — every `showsInEditor`
   * test hands the answer in by hand, and the tracker's own tests stub `setLinesChanged` to a
   * no-op. Two things could be quietly removed with all of them still green: passing the
   * *snippet* result rather than "anything in this file changed", and firing the event at all.
   */
  it('tells the difference between this note\'s lines and the rest of the file', () => {
    const index = new NoteIndex(newStore());
    index.setLinesChanged('n1', true);
    index.setChangedSinceSent('n2', true);

    assert.equal(index.linesChanged('n1'), true);
    assert.equal(index.changedSinceSent('n1'), false, 'a note whose lines moved is not the same question');
    assert.equal(index.linesChanged('n2'), false, 'an edit elsewhere in the file leaves the lines alone');
    assert.equal(index.changedSinceSent('n2'), true);
    index.dispose();
  });

  it('announces the change, because nothing else will', () => {
    /*
     * An agent that edits somewhere else in a file first leaves `changedSinceSent` already
     * true, so that setter returns without firing — and rewriting a note's lines in place
     * produces no store event either. Without this event the widget sits on lines it is no
     * longer about until some unrelated repaint comes past.
     */
    const index = new NoteIndex(newStore());
    let fired = 0;
    const sub = index.onDidChange(() => (fired += 1));

    index.setLinesChanged('n1', true);
    assert.equal(fired, 1, 'the surface is told');

    index.setLinesChanged('n1', true);
    assert.equal(fired, 1, 'and not told again for the same answer');

    index.setLinesChanged('n1', false);
    assert.equal(fired, 2, 'told again when the lines come back');

    sub.dispose();
    index.dispose();
  });

  it('clears both signals when a note is sent again', () => {
    // A re-send records a fresh snippet hash matching today's code, so the note is once more
    // about the lines it sits on. Clearing only `changedSinceSent` left the widget gone for
    // good: no widget, no gutter bar, and Reveal silently producing nothing.
    const index = new NoteIndex(newStore());
    index.setChangedSinceSent('n1', true);
    index.setLinesChanged('n1', true);

    index.clearSentSignals('n1');

    assert.equal(index.changedSinceSent('n1'), false);
    assert.equal(index.linesChanged('n1'), false);
    index.dispose();
  });
});
