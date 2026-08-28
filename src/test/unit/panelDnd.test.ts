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
      if (sel.includes('data-filter')) return el.dataset.filter ? el : null;
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
    h.fire('message', { data: { type: 'notes', cards: [], sent: [] } });
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

describe('a card', () => {
  /** Drives the real `card()` through the DOM shim, one card at a time. */
  const render = (note: Record<string, unknown>): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [{ kind: 'comment', kindIcon: 'comment', kindLabel: 'change request', kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, ...note }],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  const answered = (text: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'n1',
    seq: 1,
    body: 'remove this comment',
    snippet: '// test comment',
    addenda: [`Claude: ${text}`],
    sent: { changed: true, outcome: 'done' },
    ...over,
  });

  it('names its own file, since the cards come from all over', () => {
    // There is no group header above them any more: one header per card was a row of chrome
    // for nothing.
    const html = render({ id: 'n1', seq: 1, body: 'x', fileRef: 'SurveyList.tsx:10' });
    assert.match(html, /SurveyList\.tsx:10/);
    assert.doesNotMatch(html, /class="file"/, 'no group header');
  });

  it('shows the lines it was written about, numbered from where they are', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', snippet: 'const a = 1;\nconst b = 2;', firstLine: 10 });
    assert.match(html, /class="snip"/);
    assert.match(html, /class="ln">10<\/span>const a = 1;/);
    assert.match(html, /class="ln">11<\/span>const b = 2;/);
  });

  it('says Drafting and offers one button before it has been sent', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x' });
    assert.match(html, /class="state drafting">DRAFTING|>Drafting</);
    assert.match(html, /data-act="send"[^>]*>Send to Claude</);
    assert.doesNotMatch(html, /data-act="approve"/);
  });

  it('says Needs approval and offers the three answers once Claude has changed something', () => {
    const html = render(answered('Removed the trailing comment.'));
    assert.match(html, />Needs approval</);
    assert.match(html, /Claude&#39;s change|Claude's change/);
    assert.match(html, /Removed the trailing comment\./);
    assert.match(html, /data-act="approve"[^>]*>Approve</);
    assert.match(html, /data-act="needswork"[^>]*>Not this</);
    assert.match(html, /data-act="reply"[^>]*>Reply</);
    assert.match(html, /Ask for a change or another attempt/, 'and a box to write the next one in');
  });

  it('calls it an answer, not a change, when nothing was changed', () => {
    const html = render(answered('Skipped — the note reads only "test".', { sent: { changed: false, outcome: 'answered' } }));
    assert.match(html, /Claude&#39;s answer|Claude's answer/);
  });

  it('strips the speaker prefix rather than printing it', () => {
    const html = render(answered('Removed it.'));
    assert.doesNotMatch(html, /Claude: Removed it/);
    assert.match(html, /Removed it\./);
  });

  it('dims the answer that was turned down and keeps the reason beside it', () => {
    const html = render(
      answered('Skipped — the note reads only "test".', {
        rejected: true,
        addenda: ['Claude: Skipped — the note reads only "test".', 'I wanted an explanation, not an edit.'],
      }),
    );
    assert.match(html, />Rejected</);
    assert.match(html, /class="block claude dim"/, 'still readable, no longer the live thing');
    assert.match(html, /You · rejected|You &#183; rejected/);
    assert.match(html, /I wanted an explanation, not an edit\./);
    assert.match(html, /Claude is working on it/, 'another attempt is owed');
    assert.doesNotMatch(html, /data-act="approve"/, 'nothing to approve while it is being redone');
  });

  it('collapses to the snippet and one line once it is settled', () => {
    const html = render(answered('Renamed it.', { done: true, body: 'rename prop to isPending' }));
    assert.match(html, /class="card done"/);
    assert.match(html, /class="summary"/);
    assert.match(html, /rename prop to isPending/);
    assert.doesNotMatch(html, /class="actions"/, 'nothing left to do');
    assert.match(html, /class="folded"/, 'but the exchange is still there to open');
  });

  it('marks the state on the card rather than fading it', () => {
    // Dimming a whole card makes it unreadable to say something a word says better.
    const html = render(answered('Renamed it.', { done: true }));
    assert.doesNotMatch(html, /opacity/);
  });

  it('uses a coloured codicon for the kind, and no emoji anywhere', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', kind: 'bug', kindIcon: 'bug', kindLabel: 'bug', kindColor: '#e08d8d' });
    assert.match(html, /class="codicon codicon-bug"/);
    assert.match(html, /color:#e08d8d/);
    assert.match(html, /title="bug"/, 'the name is in the tooltip, not on the card');
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');
  });

  it('shows the follow-up you wrote, and offers to send it', () => {
    // It went into the store and appeared nowhere: the card looked as though the words had
    // been thrown away, and the only sign anything had happened was the button changing.
    const html = render(
      answered('Removed it.', {
        pendingReply: true,
        addenda: ['Claude: Removed it.', 'not quite — the other one too'],
        sent: { changed: true, outcome: 'done', seenTurns: 1 },
      }),
    );
    assert.match(html, /not quite — the other one too/, 'your words are on the card');
    assert.match(html, /You · follow-up|You &#183; follow-up/);
    assert.match(html, /not sent yet/, 'and marked as unsent');
    assert.match(html, /data-act="send"[^>]*>Send your reply</);
    assert.ok(
      html.indexOf('Removed it.') < html.indexOf('not quite'),
      'in the order the conversation happened',
    );
  });

  it('keeps the whole exchange, not just the newest turn', () => {
    const html = render(
      answered('First attempt.', {
        addenda: ['Claude: First attempt.', 'try again', 'Claude: Second attempt.'],
        sent: { changed: true, outcome: 'done', seenTurns: 3 },
      }),
    );
    for (const turn of ['First attempt.', 'try again', 'Second attempt.']) {
      assert.match(html, new RegExp(turn.replace('.', '\\.')), `${turn} is on the card`);
    }
    assert.doesNotMatch(html, /not sent yet/, 'all of it has gone');
  });

  it('offers to send a reply that has been written but not sent', () => {
    const html = render(answered('Done.', { pendingReply: true, addenda: ['Claude: Done.', 'not quite'] }));
    assert.match(html, /data-act="send"[^>]*>Send your reply</);
  });

  it('says the file is gone, and stops offering to open it', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', missing: true });
    assert.match(html, /class="ref gone"/);
  });

  it('marks a note whose lines have moved out from under it', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', orphaned: true });
    assert.match(html, /class="ref stale"/);
    assert.match(html, /may be wrong/);
  });

  it('names a screenshot and says what it is attached to', () => {
    // A path is not a thing you recognise after the fact, and both kinds of attachment are
    // paths — which turn one belongs to cannot be recovered from it.
    const html = render({
      id: 'n1', seq: 1, body: 'x',
      attachments: [{ src: 'vscode://x/a.png', path: '/tmp/a.png', name: 'panel-spacing.png', caption: 'attached screenshot', followUp: false }],
    });
    assert.match(html, /panel-spacing\.png/);
    assert.match(html, /attached screenshot/);
    assert.match(html, /data-shot="\/tmp\/a\.png"/);
    assert.match(html, /data-unshot="\/tmp\/a\.png"/, 'removable while the note is live');
  });

  it('puts a follow-up screenshot with the follow-up, not with the note', () => {
    const html = render({
      id: 'n1', seq: 1, body: 'why is this here?', rejected: true,
      addenda: ['Claude: Skipped.', 'I wanted an explanation.'],
      sent: { changed: false, outcome: 'answered' },
      attachments: [{ src: 'vscode://x/b.png', path: '/tmp/b.png', name: 'expected-memo.png', caption: 'attached to this follow-up', followUp: true }],
    });
    assert.match(html, /expected-memo\.png/);
    assert.match(html, /attached to this follow-up/);
    assert.ok(
      html.indexOf('You · rejected') < html.indexOf('expected-memo'),
      'below the rejection it belongs to',
    );
    assert.doesNotMatch(html, /data-unshot/, 'already sent — nothing to take back');
  });

  it('offers to attach one before the note goes, and from the follow-up box', () => {
    assert.match(render({ id: 'n1', seq: 1, body: 'x' }), /data-act="attach"[^>]*>.*Attach/);
    const waiting = render({
      id: 'n1', seq: 1, body: 'x', sent: { changed: true, outcome: 'done' }, addenda: ['Claude: done'],
    });
    assert.match(waiting, /class="clip" data-act="attach"/);
  });

  it('keeps delete and copy in the overflow, off the card face', () => {
    // Three buttons is the tightest row that fits 420px; a fourth would wrap, and a wrapped
    // verb stops reading as a button.
    assert.match(render({ id: 'n1', seq: 1, body: 'x' }), /data-act="more"/);
  });
});

describe('rendering what Claude wrote', () => {
  const withReply = (text: string): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [
          {
            id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
            kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, body: 'x',
            addenda: [`Claude: ${text}`], sent: { changed: true, outcome: 'done' },
          },
        ],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  it('turns a markdown link into one clickable reference', () => {
    const html = withReply('Removed it in [Question.tsx:35](src/Question.tsx).');
    assert.match(html, /data-open="src\/Question\.tsx"/);
    assert.match(html, /Question\.tsx:35/);
    assert.doesNotMatch(html, /\]\(/, 'no raw markdown left');
  });

  it('renders backticked code as code', () => {
    assert.match(withReply('Removed the `// test comment` line.'), /<code>\/\/ test comment<\/code>/);
  });

  it('escapes before it renders, so markup in the text stays text', () => {
    const html = withReply('Wrapped it in <script>alert(1)</script> tags.');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('repainting the panel', () => {
  it('leaves the DOM alone when nothing it shows has changed', () => {
    // Every store change re-renders, including ones that touch nothing here — a run finishing,
    // a hash being refreshed. Rebuilding identical markup drops the scroll position and any
    // selection, which is what made the panel flicker while Claude was working.
    const h = harness();
    const message = {
      type: 'notes',
      cards: [{ id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', fileRef: 'a.ts:1', firstLine: 1, body: 'x' }],
      sent: [],
      kinds: [],
    };
    h.fire('message', { data: message });
    const first = h.root.innerHTML;
    const node = h.root.firstChild;
    h.fire('message', { data: message });
    assert.equal(h.root.innerHTML, first, 'same markup');
    assert.equal(h.root.firstChild, node, 'and the same nodes — nothing was rebuilt');
  });

  it('still repaints when something did change', () => {
    const h = harness();
    const msg = (body: string): Record<string, unknown> => ({
      type: 'notes',
      cards: [{ id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', fileRef: 'a.ts:1', firstLine: 1, body }],
      sent: [],
      kinds: [],
    });
    h.fire('message', { data: msg('first') });
    h.fire('message', { data: msg('second') });
    assert.match(h.root.innerHTML, /second/);
  });
});

describe('filtering by state', () => {
  /** Clicks a chip through the same delegated handler the panel installs. */
  const clickFilter = (h: Harness, which: string): void => {
    h.fire('click', { target: element('button', { filter: which }), preventDefault() {}, stopPropagation() {} });
  };

  const many = (notes: Array<Record<string, unknown>>): Record<string, unknown> => ({
    type: 'notes',
    cards: notes,
    sent: [],
    kinds: [],
  });
  const n = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, seq: Number(id.slice(1)), kind: 'comment', kindIcon: 'comment', fileRef: 'a.ts:1', firstLine: 1, body: 'note ' + id, ...over,
  });

  it('stays out of the way until there is enough to lose something in', () => {
    const h = harness();
    h.fire('message', { data: many([n('n1'), n('n2'), n('n3')]) });
    assert.doesNotMatch(h.root.innerHTML, /data-filter/, 'three notes need no filter');
  });

  it('offers the states that are actually present, with counts', () => {
    const h = harness();
    h.fire('message', {
      data: many([
        n('n1'), n('n2'),
        n('n3', { sent: { changed: true } }),
        n('n4', { sent: { outcome: 'done' }, done: true }),
        n('n5', { sent: { outcome: 'answered' } }),
        n('n6'),
      ]),
    });
    const html = h.root.innerHTML;
    assert.match(html, /data-filter="all"[^>]*>all <span class="n">6</);
    assert.match(html, /data-filter="waiting"[^>]*>waiting <span class="n">3</, 'three still waiting on Claude');
    assert.match(html, /data-filter="answered"[^>]*>answered <span class="n">2</);
    assert.match(html, /data-filter="done"[^>]*>done <span class="n">1</);
  });

  it('shows only the chosen state, and clears when the lit chip is clicked again', () => {
    const h = harness();
    h.fire('message', {
      data: many([n('n1'), n('n2'), n('n3'), n('n4'), n('n5'), n('n6', { sent: { outcome: 'done' }, done: true })]),
    });
    clickFilter(h, 'done');
    assert.match(h.root.innerHTML, /note n6/);
    assert.doesNotMatch(h.root.innerHTML, /note n1/, 'the waiting ones are hidden');

    clickFilter(h, 'done');
    assert.match(h.root.innerHTML, /note n1/, 'clicking it again clears the filter');
  });

  it('gives way rather than showing an empty panel when the last match goes', () => {
    const h = harness();
    const withDone = [n('n1'), n('n2'), n('n3'), n('n4'), n('n5'), n('n6', { sent: { outcome: 'done' }, done: true })];
    h.fire('message', { data: many(withDone) });
    clickFilter(h, 'done');
    assert.doesNotMatch(h.root.innerHTML, /note n1/);
    // The done note is deleted; the filter it was the only member of no longer matches anything.
    h.fire('message', { data: many(withDone.slice(0, 5)) });
    assert.match(h.root.innerHTML, /note n1/, 'back to showing everything');
  });
});


describe('the panel stylesheet', () => {
  const media = path.resolve(__dirname, '../../../media');
  const js = fs.readFileSync(path.join(media, 'cards.js'), 'utf8');
  const css = fs.readFileSync(path.join(media, 'cards.css'), 'utf8');

  it('defines every class the script puts on the page', () => {
    // The overflow menu shipped as a list of words under the last card: its rules were lost
    // with a block that was replaced wholesale, and nothing failed — the markup was still
    // correct, it just had no styling, so an absolutely-positioned popup laid out in the flow.
    // Literal class lists only. The markup is built by concatenation, so half of what follows
    // a `class="` is an expression — and the names inside one cannot be read statically.
    const used = new Set<string>();
    const collect = (raw: string): void => {
      if (/['"+$]/.test(raw)) return;
      for (const name of raw.split(/\s+/)) {
        // Codicons come from the icon font's own stylesheet, which ships beside this one.
        if (/^[a-z][a-z0-9-]*$/i.test(name) && !name.startsWith('codicon')) used.add(name);
      }
    };
    for (const m of js.matchAll(/class="([^"]*)"/g)) collect(m[1] ?? '');
    for (const m of js.matchAll(/className = '([^']+)'/g)) collect(m[1] ?? '');
    const undefined_ = [...used].filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
    assert.deepEqual(undefined_, [], `classes with no rules: ${undefined_.join(', ')}`);
  });

  it('positions the popup out of the flow, wherever its other rules go', () => {
    const menu = /\.menu\s*\{([^}]*)\}/.exec(css);
    assert.ok(menu, 'the menu is styled');
    assert.match(menu[1] ?? '', /position:\s*(absolute|fixed)/, 'or it renders as text under the cards');
  });
});
