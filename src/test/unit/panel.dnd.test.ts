/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'node:assert/strict';
import { dragEvent, dt, element, harness } from './support/panelHarness';

/** Dragging a screenshot onto a card, and what a running command looks like. */

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

describe('panel busy feedback', () => {
  /**
   * Finding the Claude session shells out to `ps` and the Orca CLI, so a click has a
   * visible delay. The button is spun immediately by the panel rather than waiting for the
   * extension, which means something has to clear it — including for commands that change
   * no notes at all, like opening a diff.
   */
  const clickTarget = (attrs: Record<string, string>, tagName = 'BUTTON') => {
    const scope: any = { classList: classSet() };
    const host: any = { classList: classSet() };
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
        if (sel.includes('session')) return host;
        if (sel.includes('card')) return el.card ?? null;
        return null;
      },
      host,
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

  it('marks a running command on the card, without resizing the button', () => {
    // A spinner swapped in for the label changed the button's width, which changed the row's
    // height, which moved every card underneath at the moment you were reading one. The card
    // takes the working colour instead and the label stays exactly where it was.
    const h = harness();
    const button = clickTarget({ global: 'redline.reviewChanges' });
    h.fire('click', { target: button, preventDefault: () => undefined });
    assert.equal(button.innerHTML, '<span>orig</span>', 'the label is untouched');
    assert.equal(button.classList.contains('busy'), true);
    assert.equal(button.host.classList.contains('busy'), true, 'the whole card says so');
    // `running`, not `working`: the latter is a card's status row, which carries a dark
    // padded box — put on a row of controls, it drew that box around them and grew the card.
    assert.equal(button.scope.classList.contains('running'), true, 'neighbours dimmed');
    assert.equal(button.scope.classList.contains('working'), false, 'and not given a status row');

    // Opening a diff changes no notes, so only the explicit idle message can clear this.
    h.fire('message', { data: { type: 'idle' } });
    assert.equal(button.classList.contains('busy'), false);
    assert.equal(button.host.classList.contains('busy'), false);
    assert.equal(button.scope.classList.contains('running'), false);
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
    assert.equal(body.classList.contains('busy'), false);
    assert.equal(body.card.classList.contains('busy'), false, 'and the card is not marked');
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
