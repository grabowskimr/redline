/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'node:assert/strict';
import { element, harness, Harness } from './support/panelHarness';

/** The list as a whole: which cards show, in what order, and what a repaint costs. */

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

describe('the order cards come in', () => {
  it('sinks settled cards below the ones that still need you', () => {
    // A round of twenty leaves the two live ones buried among the finished, and scrolling to
    // find them is the whole problem the panel exists to solve.
    const h = harness();
    const one = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id, seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
      kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, body: id, ...over,
    });
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [
          one('settled-first', { done: true, sent: { changed: true, outcome: 'done' } }),
          one('still-live'),
          one('settled-second', { done: true, sent: { changed: true, outcome: 'done' } }),
        ],
        sent: [],
        kinds: [],
      },
    });
    const html = h.root.innerHTML;
    assert.ok(html.indexOf('still-live') < html.indexOf('settled-first'), 'live first');
    assert.ok(html.indexOf('settled-first') < html.indexOf('settled-second'), 'settled keep their order');
  });
});


describe('the empty panel', () => {
  it('offers the two things worth doing, rather than only describing them', () => {
    // A first-time reader arrives here before anything else in the product. It listed how to
    // leave a note and how to attach a screenshot, and said nothing about the diff that gives
    // you something to leave notes on, or about the plugin the rest of the README assumes.
    const h = harness();
    h.fire('message', { data: { type: 'notes', cards: [], sent: [], kinds: [] } });
    assert.match(h.root.innerHTML, /data-global="redline\.reviewChanges"/, 'open the diff');
    assert.match(h.root.innerHTML, /data-global="redline\.setUpHook"/, 'install the plugin');
    assert.match(h.root.innerHTML, /⌘⌥M/, 'and still says how to leave a note');
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

describe('repainting the panel', () => {
  const withCards = (): Harness => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [
          { id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
            kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, body: 'first' },
          { id: 'n2', seq: 2, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
            kindColor: '#e0894a', fileRef: 'b.ts:4', firstLine: 4, body: 'second' },
        ],
        sent: [],
        kinds: [],
      },
    });
    // The activity line only exists under a known session — it is part of the header.
    h.fire('message', {
      data: { type: 'session', session: { label: 'claude', state: 'working', changedFiles: 2, totalFiles: 5 } },
    });
    return h;
  };

  it('leaves the cards alone when only the session header changes', () => {
    // The header names the file Claude is writing right now. Sharing one string with the card
    // list meant every file it touched re-parsed every card — thirty full rebuilds in a run,
    // for a line of text at the top, each one dropping the scroll position with it.
    const h = withCards();
    const before = h.writes.body;
    h.fire('message', { data: { type: 'activity', activity: { running: true, file: 'src/a.ts', files: 1 } } });
    h.fire('message', { data: { type: 'activity', activity: { running: true, file: 'src/b.ts', files: 2 } } });
    h.fire('message', { data: { type: 'activity', activity: { running: true, file: 'src/c.ts', files: 3 } } });
    assert.equal(h.writes.body, before, 'the cards were not rewritten');
    assert.match(h.root.innerHTML, /src\/c\.ts/, 'and the header kept up');
  });

  it('rewrites the cards when a card actually changes', () => {
    const h = withCards();
    const before = h.writes.body;
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [
          { id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
            kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, body: 'first, edited' },
        ],
        sent: [],
        kinds: [],
      },
    });
    assert.equal(h.writes.body, before + 1);
    assert.match(h.root.innerHTML, /first, edited/);
  });

  it('rewrites neither when nothing differs', () => {
    const h = withCards();
    const strip = h.writes.strip;
    const body = h.writes.body;
    h.fire('message', { data: { type: 'idle' } });
    assert.equal(h.writes.body, body, 'no card rebuild');
    assert.equal(h.writes.strip, strip, 'and no header rebuild either');
  });
});
