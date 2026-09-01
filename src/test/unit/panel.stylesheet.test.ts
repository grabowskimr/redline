/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KIND_META } from '../../model/note';

/** What the panel is painted with, and the rules that must exist for it to be visible. */

describe('the panel stylesheet', () => {
  const media = path.resolve(__dirname, '../../../media');
  const js = fs.readFileSync(path.join(media, 'cards.js'), 'utf8');
  const css = fs.readFileSync(path.join(media, 'cards.css'), 'utf8');

  it('gives every kind a colour the policy will not throw away', () => {
    // The colours live in `KIND_META`, the rules live here, and nothing but this connects
    // them. They were inline `style` attributes until the panel's CSP — which has no
    // `'unsafe-inline'` for styles — was found to be dropping every one of them in silence.
    for (const kind of Object.keys(KIND_META)) {
      assert.match(css, new RegExp(`\\.k-${kind} \\{\\s*--k:`), `${kind} names a colour`);
    }
  });

  it('lets nothing but the kind decide the colour of the kind icon', () => {
    // The reset that strips the host's button chrome off it carried a `color: inherit`, and
    // `.meta .kind` beats `.k-bug` — two classes to one — so the icon carrying the kind was
    // quietly handed back the colour of the text around it, and every kind looked the same.
    for (const [, selector, body] of css.matchAll(/([^{}]*\.kind[^{}]*)\{([^}]*)\}/g)) {
      const colour = /(?:^|[;\s])color:\s*([^;]+)/.exec(body ?? '')?.[1];
      if (colour === undefined) continue;
      assert.match(colour, /var\(--k[,)]/, `${selector?.trim()} must take its colour from the kind`);
    }
  });

  it('paints the panel from the editor\'s theme, not from a palette of its own', () => {
    /*
     * The panel was a hand-picked dark palette — two dozen hex values scattered through the
     * file — which looked right in one theme, wrong in every other, and unreadable in a light
     * one: a near-black card on a white background. Everything but the ten kind colours, which
     * have to stay distinguishable from each other, now comes from the editor.
     */
    const tokens = css.slice(0, css.indexOf('* {'));
    const rules = css.slice(css.indexOf('* {'), css.indexOf('/* ── the kinds, by colour'));
    const strays = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(strays, [], 'no raw colours outside the token block and the kind palette');
    // Every token falls back to something considered, so a theme missing one of these does not
    // hand the panel a browser default.
    for (const [, name, value] of tokens.matchAll(/(--rl-[a-z-]+):\s*([^;]+);/g)) {
      assert.match(value ?? '', /var\(--vscode-|color-mix\(/, `${name} comes from the theme`);
    }
  });

  it('is a stylesheet, not a pile of fragments', () => {
    /*
     * Cheap structural checks, because the file is edited by hand and by script and neither
     * notices when a rule loses its body. Deleting a dead selector out of a grouped rule once
     * took the *live* rule's declarations with it, and everything still parsed — the dimming
     * that stops you clicking a second button while one is running silently became a
     * border colour, and nothing failed.
     */
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(
      (bare.match(/\{/g) ?? []).length,
      (bare.match(/\}/g) ?? []).length,
      'every rule is closed',
    );
    assert.equal(
      [...bare.matchAll(/,\s*\n\s*\}/g)].length,
      0,
      'no selector list running into a closing brace',
    );
    for (const [, body] of bare.matchAll(/\{([^{}]*)\}/g)) {
      assert.notEqual((body ?? '').trim(), '', 'no rule with an empty body');
    }
  });

  it('defines every class the script puts on the page', () => {
    /*
     * The overflow menu once shipped as a list of words under the last card: its rules were
     * lost with a block that was replaced wholesale, and nothing failed — the markup was still
     * correct, it just had no styling, so an absolutely-positioned popup laid out in the flow.
     *
     * Concatenated class lists count too. Skipping them let `drafting` ship with no rule at
     * all, because every *state* class reaches the page through a `+`, which is exactly the
     * half of the markup this was blind to. The expressions inside are unreadable statically,
     * so the literal fragments around them are what gets collected.
     */
    const used = new Set<string>();
    const collect = (raw: string): void => {
      for (const name of raw.split(/\s+/)) {
        // Codicons come from the icon font's own stylesheet, which ships beside this one.
        // A fragment ending in `-` is half a name with the expression cut out of it — `k-`
        // from `class="kind k-' + kind + '"`. There is nothing there to look for.
        if (name.endsWith('-')) continue;
        if (/^[a-z][a-z0-9-]*$/i.test(name) && !name.startsWith('codicon')) used.add(name);
      }
    };
    // `class="card ' + state + '"` → the literal parts, `card` here, with the expression cut
    // out. Anything a template puts in is checked by the tests that render it.
    for (const m of js.matchAll(/class="([^"]*)"/g)) {
      for (const literal of (m[1] ?? '').split(/'\s*\+[^+]*\+\s*'|'\s*\+|\+\s*'/)) {
        if (!/[$()?:]/.test(literal)) collect(literal);
      }
    }
    for (const m of js.matchAll(/className = '([^']+)'/g)) collect(m[1] ?? '');
    // `classList.add('dropping')` and friends. These are the ones that go missing quietly:
    // nothing but the stylesheet reads them, so an absent rule is an absent effect and no
    // error anywhere — which is how the drag feedback disappeared.
    for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) collect(m[1] ?? '');
    // Every state a card can be in, which reach the page only through concatenation.
    for (const word of ['drafting', 'waiting', 'approve', 'rejected', 'done']) used.add(word);

    // Rules only: a name mentioned in a comment is not a rule, and this stylesheet names half
    // its own classes in prose. Comments are stripped before looking.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const missing = [...used].filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(rules));
    assert.deepEqual(missing, [], `classes with no rules: ${missing.join(', ')}`);
  });

  it('positions the popup out of the flow, wherever its other rules go', () => {
    const menu = /\.menu\s*\{([^}]*)\}/.exec(css);
    assert.ok(menu, 'the menu is styled');
    assert.match(menu[1] ?? '', /position:\s*(absolute|fixed)/, 'or it renders as text under the cards');
  });
});
