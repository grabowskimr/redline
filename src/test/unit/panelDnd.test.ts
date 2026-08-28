/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Drives the real `media/cards.js` against a minimal DOM shim. The drag handlers were the
 * flakiest part of this extension, and they cannot be reached from the extension-host
 * tests at all — the webview is a separate runtime. This harness registers the listeners
 * the script installs, then fires synthetic drag events at them.
 */

interface Harness {
  posted: any[];
  root: any;
  fire(type: string, event: any): void;
  card(id: string): any;
  cards: any[];
  tick(ms: number): Promise<void>;
}

function element(tag: string, attrs: Record<string, string> = {}): any {
  const classes = new Set<string>();
  const el: any = {
    tagName: tag.toUpperCase(),
    dataset: { ...attrs },
    children: [] as any[],
    innerHTML: '',
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    addEventListener: () => undefined,
    closest: (sel: string) => {
      if (sel.includes('card')) return el.isCard ? el : (el.parentCard ?? null);
      if (sel.includes('actions') || sel.includes('controls')) return el.scope ?? null;
      if (sel.includes('data-global')) return el.dataset.global ? el : null;
      if (sel.includes('data-act')) return el.dataset.act ? el : null;
      if (sel.includes('data-shot') || sel.includes('data-unshot')) return null;
      return null;
    },
  };
  return el;
}

function harness(): Harness {
  const listeners = new Map<string, Array<(e: any) => void>>();
  const on = (type: string, fn: (e: any) => void): void => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  };
  const posted: any[] = [];
  const cards: any[] = [];
  const root = element('div');
  root.addEventListener = on;
  // Mirrors `cardById`: the *live* element for a note id, so a card replaced by a
  // re-render is found instead of the detached original.
  root.querySelector = (sel: string) => {
    const id = /data-id="([^"]+)"/.exec(sel)?.[1];
    return [...cards].reverse().find((c) => c.dataset.id === id) ?? null;
  };

  const documentShim: any = {
    getElementById: () => root,
    addEventListener: on,
    elementFromPoint: () => null,
    activeElement: null,
  };
  const windowShim: any = { addEventListener: on };

  class FileReaderShim {
    onload: (() => void) | null = null;
    result = 'data:image/png;base64,QUJD';
    readAsDataURL(): void {
      setTimeout(() => this.onload?.(), 0);
    }
  }

  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'cards.js'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'window',
    'document',
    'acquireVsCodeApi',
    'FileReader',
    src,
  )(windowShim, documentShim, () => ({ postMessage: (m: any) => posted.push(m) }), FileReaderShim);

  return {
    posted,
    cards,
    root,
    card(id: string) {
      const el = element('div', { id });
      el.isCard = true;
      cards.push(el);
      return el;
    },
    fire(type: string, event: any) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    tick: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

const dt = (over: Partial<{ types: string[]; files: any[]; data: Record<string, string> }> = {}): any => ({
  types: over.types ?? ['Files'],
  files: over.files ?? [],
  getData: (t: string) => over.data?.[t] ?? '',
  dropEffect: '',
});

const dragEvent = (target: any, dataTransfer: any, shiftKey = true) => {
  let prevented = false;
  return {
    target,
    clientX: 10,
    clientY: 10,
    shiftKey,
    dataTransfer,
    preventDefault: () => {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  } as any;
};

describe('panel drag & drop', () => {
  it('boots and announces itself', () => {
    const h = harness();
    assert.deepEqual(h.posted, [{ type: 'ready' }]);
  });

  it('highlights the card under a file drag and accepts the drop', () => {
    const h = harness();
    const card = h.card('n1');
    const e = dragEvent(card, dt());
    h.fire('dragover', e);
    assert.equal(card.classList.contains('dropping'), true, 'card is highlighted');
    assert.equal(e.prevented, true, 'drop is accepted');
    assert.equal(e.dataTransfer.dropEffect, 'copy');
  });

  it('ignores a drag that carries no files or uris', () => {
    const h = harness();
    const card = h.card('n1');
    const e = dragEvent(card, dt({ types: ['text/plain'] }));
    h.fire('dragover', e);
    assert.equal(card.classList.contains('dropping'), false);
    assert.equal(e.prevented, false, 'a text drag still belongs to the workbench');
  });

  it('moves the highlight between cards', () => {
    const h = harness();
    const a = h.card('a');
    const b = h.card('b');
    h.fire('dragover', dragEvent(a, dt()));
    h.fire('dragover', dragEvent(b, dt()));
    assert.equal(a.classList.contains('dropping'), false, 'left card released');
    assert.equal(b.classList.contains('dropping'), true);
  });

  it('keeps the highlight through an idle dragover interval, then expires it', async () => {
    const h = harness();
    const card = h.card('n1');
    h.fire('dragover', dragEvent(card, dt()));
    await h.tick(400); // browsers only re-fire dragover about every 350ms when stationary
    assert.equal(card.classList.contains('dropping'), true, 'no flicker while hovering');
    await h.tick(400);
    assert.equal(card.classList.contains('dropping'), false, 'released once events stop (⇧ let go)');
  });

  it('sends dropped image bytes to the extension', async () => {
    const h = harness();
    const card = h.card('n1');
    h.fire('dragover', dragEvent(card, dt()));
    h.fire('drop', dragEvent(card, dt({ files: [{ name: 'shot.png', type: 'image/png' }] })));
    assert.equal(card.classList.contains('dropping'), false, 'highlight cleared on drop');
    await h.tick(5);
    assert.deepEqual(h.posted.slice(1), [{ type: 'attach', id: 'n1', name: 'shot.png', data: 'QUJD' }]);
  });

  it('falls back to the uri list when the payload has no File object', () => {
    const h = harness();
    const card = h.card('n1');
    const payload = dt({ types: ['text/uri-list'], data: { 'text/uri-list': 'file:///tmp/a.png' } });
    h.fire('drop', dragEvent(card, payload));
    assert.deepEqual(h.posted.slice(1), [{ type: 'attachPaths', id: 'n1', uris: 'file:///tmp/a.png' }]);
  });

  it('reports a drop that carries nothing usable', () => {
    const h = harness();
    h.fire('drop', dragEvent(h.card('n1'), dt({ types: ['Files'] })));
    assert.deepEqual(h.posted.slice(1), [{ type: 'dropRejected', id: 'n1' }]);
  });

  it('leaves the target open when the drop misses every card', async () => {
    const h = harness();
    h.fire('drop', dragEvent(element('div'), dt({ files: [{ name: 'x.png', type: 'image/png' }] })));
    await h.tick(5);
    assert.equal(h.posted[1].type, 'attach');
    assert.equal(h.posted[1].id, undefined, 'the extension resolves which note it belongs to');
  });

  it('asks for ⇧ once when the drag arrives without it, and highlights nothing', () => {
    const h = harness();
    const card = h.card('n1');
    h.fire('dragenter', dragEvent(card, dt(), false));
    h.fire('dragover', dragEvent(card, dt(), false));
    assert.equal(card.classList.contains('dropping'), false, 'no false promise of a drop');
    assert.deepEqual(
      h.posted.slice(1),
      [{ type: 'dragNeedsShift' }],
      'told once, not once per dragover event',
    );
  });

  it('re-applies the highlight to a card replaced by a mid-drag re-render', () => {
    const h = harness();
    const first = h.card('n1');
    h.fire('dragover', dragEvent(first, dt()));
    assert.equal(first.classList.contains('dropping'), true);
    const replacement = h.card('n1'); // same note, new element
    h.fire('dragover', dragEvent(replacement, dt()));
    assert.equal(replacement.classList.contains('dropping'), true, 'highlight follows the live card');
  });

  it('defers a re-render until the drag is over, then applies it', async () => {
    const h = harness();
    h.fire('dragover', dragEvent(h.card('n1'), dt()));
    h.fire('message', { data: { type: 'notes', groups: [], sent: [] } });
    assert.equal(h.root.innerHTML, '', 'the DOM is not swapped out from under a live drag');
    await h.tick(900); // TTL expires, drag considered over
    assert.match(h.root.innerHTML, /No review notes yet/, 'the held-back render happens after');
  });

  it('drops the highlight when the window loses focus mid-drag', () => {
    const h = harness();
    const card = h.card('n1');
    h.fire('dragover', dragEvent(card, dt()));
    h.fire('blur', {});
    assert.equal(card.classList.contains('dropping'), false);
  });

  it('accepts an extensionless image by name when the OS reports no MIME type', async () => {
    const h = harness();
    const card = h.card('n1');
    h.fire('drop', dragEvent(card, dt({ files: [{ name: 'Screenshot.HEIC', type: '' }] })));
    await h.tick(5);
    assert.equal(h.posted[1].type, 'attach');
    assert.equal(h.posted[1].name, 'Screenshot.HEIC');
  });
});

describe('card state', () => {
  /** The rules the card renders by; getting these wrong makes a live note look finished. */
  const settled = (n: { done?: boolean; sent?: { outcome?: string }; pendingReply?: boolean }): boolean =>
    !!(n.done || (n.sent && n.sent.outcome)) && !n.pendingReply;
  const dimmed = (n: { done?: boolean; sent?: { outcome?: string }; pendingReply?: boolean }): boolean =>
    !!n.done && !n.pendingReply;

  it('a finished note is collapsed and dimmed', () => {
    const n = { done: true, sent: { outcome: 'done' } };
    assert.equal(settled(n), true);
    assert.equal(dimmed(n), true);
  });

  it('an unsent reply makes a finished note live again, and not greyed out', () => {
    // The reported bug: replying from the comment widget left the card looking disabled.
    const n = { done: true, sent: { outcome: 'done' }, pendingReply: true };
    assert.equal(settled(n), false, 'expanded, with its actions back');
    assert.equal(dimmed(n), false, 'and not wearing the done styling');
  });

  it('a note waiting on Claude is neither settled nor dimmed', () => {
    const n = { sent: {} };
    assert.equal(settled(n), false);
    assert.equal(dimmed(n), false);
  });
});

describe('panel busy feedback', () => {
  /**
   * Finding the Claude session shells out to `ps` and the Orca CLI, so a click has a
   * visible delay. The button is spun immediately by the panel rather than waiting for the
   * extension, which means something has to clear it — including for commands that change
   * no notes at all, like opening a diff.
   */
  const clickTarget = (attrs: Record<string, string>, tagName = 'BUTTON') => {
    const scope: any = { classList: classSet() };
    const el: any = {
      tagName,
      dataset: attrs,
      innerHTML: '<span>orig</span>',
      classList: classSet(),
      scope,
      closest: (sel: string) => {
        if (sel.includes('data-global')) return attrs.global ? el : null;
        if (sel.includes('data-act')) return attrs.act ? el : null;
        if (sel.includes('actions') || sel.includes('controls')) return scope;
        if (sel.includes('card')) return el.card ?? null;
        return null;
      },
      isConnected: true,
    };
    return el;
  };

  function classSet(): any {
    const set = new Set<string>();
    return {
      add: (c: string) => set.add(c),
      remove: (c: string) => set.delete(c),
      contains: (c: string) => set.has(c),
      toggle: (c: string) => (set.has(c) ? set.delete(c) : set.add(c)),
    };
  }

  it('spins a global button on click and stops when the extension reports idle', () => {
    const h = harness();
    const button = clickTarget({ global: 'redline.reviewChanges' });
    h.fire('click', { target: button, preventDefault: () => undefined });
    assert.match(button.innerHTML, /codicon-modifier-spin/, 'spinner shown immediately');
    assert.equal(button.classList.contains('busy'), true);
    assert.equal(button.scope.classList.contains('working'), true, 'neighbours dimmed');

    // Opening a diff changes no notes, so only the explicit idle message can clear this.
    h.fire('message', { data: { type: 'idle' } });
    assert.equal(button.innerHTML, '<span>orig</span>', 'original label restored');
    assert.equal(button.classList.contains('busy'), false);
    assert.equal(button.scope.classList.contains('working'), false);
  });

  it('ignores a second click while the first is still running', () => {
    const h = harness();
    const button = clickTarget({ global: 'redline.submit' });
    h.fire('click', { target: button, preventDefault: () => undefined });
    const posted = h.posted.length;
    h.fire('click', { target: button, preventDefault: () => undefined });
    assert.equal(h.posted.length, posted, 'no duplicate send');
  });

  it('never replaces a note body with a spinner', () => {
    // `.body` carries data-act="reveal", so spinning anything that is not a button would
    // wipe the note's own text.
    const h = harness();
    const body = clickTarget({ act: 'reveal' }, 'DIV');
    body.card = { dataset: { id: 'n1' }, classList: classSet() };
    body.closest = (sel: string) => {
      if (sel.includes('data-act')) return body;
      if (sel.includes('card')) return body.card;
      if (sel.includes('actions') || sel.includes('controls')) return body.scope;
      return null;
    };
    h.fire('click', { target: body, preventDefault: () => undefined });
    assert.equal(body.innerHTML, '<span>orig</span>', 'the note text is untouched');
    assert.equal(body.classList.contains('busy'), false);
  });

  it('releases the spinner if the extension never answers', async () => {
    const h = harness();
    const button = clickTarget({ global: 'redline.submit' });
    h.fire('click', { target: button, preventDefault: () => undefined });
    assert.equal(button.classList.contains('busy'), true);
    // The timeout is 20s; assert the timer exists rather than waiting for it.
    const timers = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout') ?? [];
    assert.ok(timers.length > 0, 'a safety timeout is pending');
    h.fire('message', { data: { type: 'idle' } });
  });
});

describe('rendering a card', () => {
  /**
   * Drives the real `card()` through the DOM shim. Nothing else did: the drag and busy tests
   * only fire events, so a card that threw on render — a `const` read before its declaration,
   * say — went unnoticed until the panel was opened by hand.
   */
  const render = (note: Record<string, unknown>): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        groups: [{ base: 'a.ts', dir: 'src', notes: [{ kind: 'comment', kindIcon: 'comment', where: 'L1', ...note }] }],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  const shot = [{ src: 'vscode://x/a.png', path: '/tmp/a.png', name: 'a.png' }];

  it('renders at all', () => {
    const html = render({ id: 'n1', seq: 1, body: 'rename this' });
    assert.match(html, /class="card/);
    assert.match(html, /rename this/);
  });

  it('offers to remove a screenshot on a note that has not been sent', () => {
    assert.match(render({ id: 'n1', seq: 1, body: 'x', attachments: shot }), /data-unshot/);
  });

  it('offers to remove one added to a reply on a note already sent', () => {
    // The reported bug: keyed on `sent` alone, an image attached to a reply was stuck there.
    const html = render({
      id: 'n1', seq: 1, body: 'x', attachments: shot,
      sent: { changed: false, outcome: 'done' }, pendingReply: true,
    });
    assert.match(html, /data-unshot/, 'removable while the reply is still unsent');
  });

  it('does not offer removal once the note is settled', () => {
    const html = render({
      id: 'n1', seq: 1, body: 'x', attachments: shot, done: true,
      sent: { changed: false, outcome: 'done' },
    });
    assert.doesNotMatch(html, /data-unshot/);
  });

  it('reads as done and collapses once marked done', () => {
    // pendingReply is cleared by the command when done is set, so the card settles.
    const html = render({
      id: 'n1', seq: 1, body: 'x', done: true,
      sent: { changed: true, outcome: 'answered' }, attachments: [],
    });
    assert.match(html, /codicon-pass-filled[^>]*><\/span> done/, "your decision, not the agent's verdict");
    assert.match(html, /class="card done settled/, 'dimmed and collapsed');
    assert.match(html, /data-act="remove"/, 'and removable in one click');
  });

  it('offers reopen, not mark-done, on a note already done', () => {
    // Offering ✓ there means the click undoes it — which reads as the button doing nothing.
    const html = render({
      id: 'n1', seq: 1, body: 'x', done: true,
      sent: { changed: false, outcome: 'done' }, pendingReply: true,
    });
    assert.match(html, /data-act="reopen"/);
    assert.doesNotMatch(html, /data-act="done"/);
  });

  it('shows the waiting state, and a send action for an unsent follow-up', () => {
    assert.match(render({ id: 'n1', seq: 1, body: 'x', awaiting: true }), /waiting for Claude/);
    const pending = render({ id: 'n1', seq: 1, body: 'x', sent: { changed: false, outcome: 'done' }, pendingReply: true });
    assert.match(pending, /follow-up not sent/);
    assert.match(pending, /data-act="send"/);
  });
});

describe('rendering what Claude wrote', () => {
  const render = (addenda: string[]): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        groups: [
          {
            base: 'a.ts',
            dir: 'src',
            notes: [{ id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', where: 'L1', body: 'x', addenda }],
          },
        ],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  it('turns a markdown link into one clickable reference, not a label plus a long path', () => {
    // The raw form showed both, and a repository path is long enough to push the card sideways.
    const html = render(['Claude: moved it into [QuestionNavigation.styles.tsx:21](domains/hr/libs/grow/x.tsx)']);
    assert.match(html, /data-open="domains\/hr\/libs\/grow\/x\.tsx"/);
    assert.match(html, />QuestionNavigation\.styles\.tsx:21</);
    assert.doesNotMatch(html, /\]\(domains/, 'no markdown syntax left on screen');
  });

  it('renders backticked code as code', () => {
    assert.match(render(['Claude: dropped the `styled-components` import']), /<code>styled-components<\/code>/);
  });

  it('labels the speaker instead of leaving "Claude:" in the sentence', () => {
    const html = render(['Claude: did the thing']);
    assert.match(html, /class="who">Claude</);
    assert.doesNotMatch(html, /Claude: did the thing/);
  });

  it('leaves your own turns unlabelled', () => {
    const html = render(['not quite — put it above']);
    assert.doesNotMatch(html, /class="who"/);
    assert.match(html, /not quite/);
  });

  it('escapes before it renders, so markup in the text stays text', () => {
    const html = render(['Claude: careful with <script>alert(1)</script> and [x](y)']);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /data-open="y"/, 'the link still renders');
  });
});

describe('panel iconography', () => {
  const render = (note: Record<string, unknown>): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        groups: [{ base: 'a.ts', dir: 'src', notes: [{ kind: 'comment', kindIcon: 'comment', where: 'L1', ...note }] }],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  it('uses codicons, not emoji, for every action and status', () => {
    // Kinds have always used the editor's own icon set; the actions used emoji, which sit on a
    // different baseline and render differently per platform.
    const html = render({
      id: 'n1', seq: 1, body: 'x',
      attachments: [{ src: 'x', path: '/tmp/a.png', name: 'a.png' }],
    });
    for (const name of ['codicon-comment', 'codicon-file-media', 'codicon-check', 'codicon-send', 'codicon-kebab-vertical']) {
      assert.match(html, new RegExp(name), `${name} is used`);
    }
    // Listed individually: a character class over these needs the `u` flag to be meaningful,
    // and the point is the specific glyphs that used to be here.
    for (const glyph of ['➤', '📎', '↳', '✕', '⋯', '↺']) {
      assert.ok(!html.includes(glyph), `${glyph} is no longer in the card`);
    }
  });

  it('marks a done card rather than fading it', () => {
    // The card carries Claude's account of what it changed, so it has to stay legible.
    const html = render({ id: 'n1', seq: 1, body: 'x', done: true, sent: { changed: false, outcome: 'done' } });
    assert.match(html, /class="card done settled/);
    assert.match(html, /codicon-pass-filled/, 'and says so with an icon');
  });
});

describe('sending a second round', () => {
  /** Renders the sent section, which is where a follow-up is written and sent from. */
  const renderSent = (sent: Array<Record<string, unknown>>): string => {
    const h = harness();
    h.fire('message', { data: { type: 'notes', groups: [], sent, kinds: [] } });
    return h.root.innerHTML;
  };

  const answered = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'n1',
    seq: 1,
    kind: 'comment',
    kindIcon: 'comment',
    where: 'L1',
    body: 'remove this comment',
    sent: { changed: false, outcome: 'done' },
    ...over,
  });

  it('offers to send every follow-up at once', () => {
    // The reported gap: after a round is answered you reply to several notes, and the only
    // way to send them was one card at a time — the batch send had disappeared with the last
    // unsent note.
    const html = renderSent([answered({ pendingReply: true }), answered({ id: 'n2', seq: 2, pendingReply: true })]);
    assert.match(html, /data-global="redline\.submit"/, 'a send action in the sent section');
    assert.match(html, /send 2 follow-ups/);
  });

  it('counts one follow-up in the singular', () => {
    assert.match(renderSent([answered({ pendingReply: true }), answered({ id: 'n2', seq: 2 })]), /send 1 follow-up</);
  });

  it('says nothing when every answer has been read and left alone', () => {
    const html = renderSent([answered(), answered({ id: 'n2', seq: 2 })]);
    assert.doesNotMatch(html, /data-global="redline\.submit"/);
    assert.match(html, /clear sent/, 'the section is still there');
  });
});
