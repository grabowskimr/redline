/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { harness, mediaPath } from './support/panelHarness';

/** The card at the top of the panel: the session, and the scopes it can be reviewed at. */

describe('the session card holds its shape', () => {
  const css = fs.readFileSync(mediaPath('cards.css'), 'utf8');

  it('gives the switcher no box to grow, and no button to inherit one', () => {
    // A real `<button>` picks up the host's own chrome — a filled, padded box on press and
    // while a command runs — through states no rule of ours had covered, and the row grew
    // with it. It is a span acting as a button now, and nothing paints behind it.
    const js = fs.readFileSync(mediaPath('cards.js'), 'utf8');
    assert.match(js, /class="swap" role="button" tabindex="0" data-global="redline\.pickSession"/);
    assert.doesNotMatch(js, /<button[^>]*data-global="redline\.pickSession"/, 'not a <button>');

    const rules = [...css.matchAll(/\.session \.controls \.swap([^{]*)\{([^}]*)\}/g)];
    assert.ok(rules.length >= 3, 'the icon is styled at all');
    const base = rules.find((r) => (r[1] ?? '').trim() === '')?.[2] ?? '';
    assert.match(base, /width:\s*\d+px/, 'a fixed size, so no state can change it');
    for (const [, selector, body] of rules) {
      const bg = /background:\s*([^;]+)/.exec(body ?? '')?.[1]?.trim();
      if (bg) assert.equal(bg, 'none', `no box in ${selector?.trim() || 'the base rule'}`);
    }
  });

  it('never lets a card status row be drawn around the session controls', () => {
    // `.working` is a card's status row — a dark box with 8px of padding. It was also the mark
    // put on a row of controls while its command ran, so the switcher grew a background and
    // the card grew with it. The two meanings are `working` and `running` now, and the box
    // belongs to a card.
    const js = fs.readFileSync(mediaPath('cards.js'), 'utf8');
    assert.match(js, /classList\.add\('running'\)/, 'the row is marked as running');
    assert.doesNotMatch(js, /classList\.add\('working'\)/, 'and never given a status row');
    for (const [, body] of css.matchAll(/(?:^|\n)\.working \{([^}]*)\}/g)) {
      assert.doesNotMatch(body ?? '', /padding|background/, 'an unscoped .working paints nothing');
    }
    assert.match(css, /\.card \.working \{/, 'the box is scoped to a card');
  });

  it('fixes the height of both rows, so the card cannot resize', () => {
    // The card sits above everything else in the panel, so anything that changed its height
    // moved the whole list under the pointer.
    for (const row of ['who-row', 'scope-row']) {
      // The last rule for the row, not the first: the shared block above it sets the layout.
      const bodies = [...css.matchAll(new RegExp(`\\.session \\.${row} \\{([^}]*)\\}`, 'g'))].map((m) => m[1] ?? '');
      assert.ok(
        bodies.some((b) => /height:\s*\d+px/.test(b)),
        `${row} has a fixed height`,
      );
    }
  });

  it('always draws both review scopes, so the row cannot change shape', () => {
    // One button when nothing was recent and two otherwise: the card grew and shrank as a run
    // went, moving every card under it.
    const h = harness();
    h.fire('message', { data: { type: 'notes', cards: [], sent: [], kinds: [] } });
    h.fire('message', {
      data: { type: 'session', session: { label: 'claude', state: 'idle', changedFiles: 0, totalFiles: 0 } },
    });
    const quiet = h.root.innerHTML;
    assert.match(quiet, /Last run/);
    assert.match(quiet, /Everything/);
    assert.match(quiet, /nothing changed yet/);
    assert.equal((quiet.match(/class="off"/g) ?? []).length, 2, 'both offered, neither live');

    h.fire('message', {
      data: { type: 'session', session: { label: 'claude', state: 'working', changedFiles: 2, totalFiles: 5 } },
    });
    const busy = h.root.innerHTML;
    assert.equal((busy.match(/class="scope"/g) ?? []).length, 1, 'the same row');
    assert.doesNotMatch(busy, /class="off"/, 'now both live');
  });
});
