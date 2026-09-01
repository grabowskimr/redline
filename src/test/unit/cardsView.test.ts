import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CardsViewProvider } from '../../view/cardsView';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';
import { createAnchor } from '../../anchor/anchorService';
import { NewNoteInput, ReviewNote } from '../../model/note';

/**
 * The extension's half of the panel: what a card is told, and what the page is allowed to do.
 *
 * The webview half has been well covered for a while; this side had nothing. It is where the
 * security policy is written — and the bug where every inline `style` in the panel was being
 * dropped in silence was a policy bug, caught only by someone noticing a gap in the padding.
 */
describe('what the panel is told about a note', () => {
  const CODE = 'export const Card = ({ id }) => (\n  <div id={id} />\n);';

  const store = (): ReviewStore =>
    new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, {
      archiveLimit: () => 5,
    });

  const add = (s: ReviewStore, over: Partial<NewNoteInput> = {}): ReviewNote => {
    const range = { startLine: 1, startChar: 0, endLine: 1, endChar: 16 };
    const input: NewNoteInput = {
      path: 'src/Card.tsx',
      workspaceFolder: 'repo',
      range,
      anchor: createAnchor(CODE, range),
      snapshot: { code: '  <div id={id} />', startLine: 1 },
      body: 'rename this prop',
      ...over,
    };
    return s.add(input);
  };

  const view = (s: ReviewStore): CardsViewProvider =>
    new CardsViewProvider(
      { extensionUri: vscode.Uri.file('/ext'), subscriptions: [] } as never,
      s,
      {
        onDidChange: () => ({ dispose: () => undefined }),
        changedSinceSent: () => false,
        panelNotes: () => s.notes,
      } as never,
      { info: () => undefined, warn: () => undefined, trace: () => undefined } as never,
    );

  /** The cards the panel would be sent, without a webview to send them to. */
  const cards = (s: ReviewStore): Array<Record<string, unknown>> => {
    const v = view(s);
    try {
      return (v as unknown as { cards(): Array<Record<string, unknown>> }).cards();
    } finally {
      v.dispose();
    }
  };

  beforeEach(() => {
    (vscode as unknown as { state: { folders: unknown[] } }).state.folders = [
      { uri: vscode.Uri.file('/repo') },
    ];
  });

  it('sends the code as it was highlighted, not as it is now', () => {
    // `anchor.snippet` is the key the note is found by and follows the file; the snapshot is
    // the record of what was on screen. Sending the wrong one put today's lines under
    // yesterday's comment.
    const s = store();
    const n = add(s);
    s.update(n.id, { anchor: { ...s.getById(n.id)!.anchor, snippet: '  <span id={id} />' } });
    assert.equal(cards(s)[0]?.snippet, '  <div id={id} />');
  });

  it('numbers the snippet from where it was captured', () => {
    const s = store();
    const n = add(s);
    s.update(n.id, { range: { startLine: 40, startChar: 0, endLine: 40, endChar: 3 } });
    assert.equal(cards(s)[0]?.firstLine, 2, 'the line it had when it was written');
  });

  it('names the file and line the note points at now', () => {
    const s = store();
    add(s);
    assert.equal(cards(s)[0]?.fileRef, 'Card.tsx:2');
  });

  it('gives every card its kind, so the panel never has to guess a colour', () => {
    const s = store();
    add(s, { kind: 'bug' });
    const card = cards(s)[0]!;
    assert.equal(card['kind'], 'bug');
    assert.equal(card['kindLabel'], 'bug');
    assert.ok(card['kindIcon'], 'and an icon to draw');
  });

  it('marks a note whose turn it is, and one waiting on Claude', () => {
    const s = store();
    const n = add(s);
    assert.equal(cards(s)[0]?.awaiting, undefined, 'nothing is owed on a draft');

    s.markSent([n.id]);
    assert.equal(cards(s)[0]?.awaiting, true, 'sent, and nobody has answered');

    s.update(n.id, {
      addenda: ['Claude: renamed it'],
      sent: { ...s.getById(n.id)!.sent!, outcome: 'done' },
    });
    assert.equal(cards(s)[0]?.awaiting, undefined, 'answered: it is your turn now');
  });

  it('says how a note left when it did not reach a session', () => {
    // "Waiting for Claude…" over a batch sitting on the clipboard is a lie about whose turn it
    // is, on the one screen that exists to answer that.
    const s = store();
    const n = add(s);
    s.markSent([n.id], undefined, undefined, 'clipboard');
    assert.equal((cards(s)[0]?.sent as { route?: string })?.route, 'clipboard');
  });

  it('tells the panel which turn a screenshot belongs to', () => {
    const s = store();
    const n = add(s);
    s.update(n.id, {
      attachments: ['/tmp/a.png', '/tmp/b.png'],
      // Index into `addenda` plus one; 0 is the note itself.
      attachmentTurns: [0, 2],
    });
    const shots = cards(s)[0]?.attachments as Array<{ turn: number; caption: string }>;
    assert.equal(shots[0]?.turn, 0);
    assert.match(shots[0]?.caption ?? '', /attached screenshot/);
    assert.equal(shots[1]?.turn, 2);
    assert.match(shots[1]?.caption ?? '', /this follow-up/);
  });
});

describe('the page the panel is served', () => {
  const html = (): string => {
    const v = new CardsViewProvider(
      { extensionUri: vscode.Uri.file('/ext'), subscriptions: [] } as never,
      new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, {
        archiveLimit: () => 5,
      }),
      { onDidChange: () => ({ dispose: () => undefined }), changedSinceSent: () => false } as never,
      { info: () => undefined, warn: () => undefined, trace: () => undefined } as never,
    );
    try {
      return (v as unknown as { html(w: unknown): string }).html({
        cspSource: 'vscode-resource:',
        asWebviewUri: (u: vscode.Uri) => u,
      });
    } finally {
      v.dispose();
    }
  };

  it('lets nothing run that did not come with the page', () => {
    const page = html();
    assert.match(page, /default-src 'none'/);
    assert.match(page, /script-src 'nonce-[0-9a-f]{32}'/, 'a fresh nonce, not a source allowance');
    assert.doesNotMatch(page, /unsafe-eval/);
  });

  it('does not allow inline styles — and so the panel must not write any', () => {
    /*
     * The policy has no `'unsafe-inline'` for styles, which is right. The panel was writing
     * `style="…"` attributes anyway and the browser was dropping every one of them without a
     * word: the kind's colour, everywhere it appeared. This is the half of that pair that
     * lives here; the other half is a test that the panel writes none.
     */
    const page = html();
    assert.match(page, /style-src vscode-resource:/);
    assert.doesNotMatch(page, /style-src[^;]*unsafe-inline/);
  });

  it('gives each page a nonce of its own', () => {
    const first = /nonce-([0-9a-f]+)/.exec(html())?.[1];
    const second = /nonce-([0-9a-f]+)/.exec(html())?.[1];
    assert.notEqual(first, second, 'never reused between loads');
  });
});
