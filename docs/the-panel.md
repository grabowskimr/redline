# The panel

`media/cards.js` — about 1,450 lines of plain JavaScript, no build step, no framework, no
dependencies. `src/view/cardsView.ts` is the extension-host half that feeds it.

## Why it looks like that

A webview runs in its own sandboxed page. Whatever goes in it has to be shipped as source, so
every dependency is weight in the `.vsix` and another thing to keep current. The panel is one
file of DOM-string building because that is genuinely the smaller cost at this size.

The consequences are worth knowing up front:

- **Rendering is `innerHTML = html`.** There is no diffing. Anything the user was doing in the
  DOM is destroyed and has to be explicitly carried across — see *What a repaint costs* below.
- **There is no type checking.** `media/jsconfig.json` gives the editor some help, and
  `npm run check:media` runs `node --check` for syntax, but a typo in a property name is found
  by a test or by nobody.
- **A class with no CSS rule fails silently.** Correct markup, no styling, no error. This has
  shipped four times. There is a test for it now; see below.

## The message protocol

Every message is `{ type, ...fields }`. This is the whole contract.

**Extension → panel**

| type | carries |
|---|---|
| `notes` | `cards`, `sent`, `kinds` — the entire state, every time |
| `session` | the session card's contents |
| `activity` | what the agent is writing right now, if the plugin is reporting |
| `idle` | the last command finished; stop any spinner |

**Panel → extension**

| type | means |
|---|---|
| `ready` | the script loaded (sent once) |
| `command` | run this command id, with this note id |
| `addAddendum` | record this follow-up on this note |
| `dropTurn` | take back an unsent follow-up |
| `setKind` | change a note's kind |
| `attachPick` / `attach` / `attachPaths` | attach a screenshot, three ways in |
| `removeAttachment`, `openAttachment`, `openPath` | the obvious |
| `dragNeedsShift`, `dropRejected` | tell the user why a drop did nothing |
| `panelError` | an exception in the panel, so it reaches the log rather than vanishing |

`cards` is a flat list; the panel does no filtering the extension could have done, and the
extension sends no HTML.

## Card state

`cardState(n)` returns one of five, in this order of precedence:

```
done      → settled. Collapses to one line; everything else is behind the click.
rejected  → you turned a change down. Owes a reason.
approve   → Claude has answered and nobody has agreed with it yet.
drafting  → written, never sent.
waiting   → sent, no answer yet.
```

The action row is chosen separately and has a *different* precedence, which is a trap worth
knowing: `sending` → `queued` → `drafting` → `approve` → `rejected` → `awaiting` → default.
`rejected` sits before `awaiting` on purpose. Without a report — the common case with no plugin
— a rejected note keeps `awaiting`, so the waiting branch matched first and the card showed
"Claude is having another go…" with no buttons, about a rejection that had gone nowhere.

**Every state must have a way forward.** A card you can reach and not leave without the ⋯ menu
or a reload is a bug. `src/test/unit/panel.card.test.ts` covers each state; there is also a
scratch harness pattern for rendering all of them at once, which is how the last three dead
ends were found.

## What a repaint costs

`paint()` replaces the card list wholesale. It explicitly carries across:

- **every open follow-up draft**, not only the focused one (clicking Attach moves focus, and
  that used to destroy the draft the screenshot was for);
- the caret position in the focused one;
- the scroll position, but only when the content is still tall enough for it to mean anything.

It deliberately does **not** carry: text selection, focus on anything but a textarea, an
expanded settled card, or a `.snip`'s horizontal scroll. Those are known and cheap to lose.

One piece of state lives only in the DOM and has to be re-applied after a repaint: `.replying`,
which says the compose box is open. `restoreBox` puts it back. The `sending` set is a
module-level `Set` in the script, so it survives a repaint by construction — it is the other
half of the same problem (the extension has been asked and has not answered yet) solved the
easier way, because it is not attached to an element.

The header and the card list are painted into **separate containers** and compared separately.
The header carries the name of the file the agent is writing right now, so sharing one string
meant every file it touched re-parsed every card — thirty full rebuilds in a run.

## Rules the panel has to obey

1. **No inline `style` attributes.** The content security policy has no `'unsafe-inline'` for
   styles, so the browser drops every one of them *without a word*. The ten kind colours are
   classes (`.k-bug` etc.) for exactly this reason. `panel.card.test.ts` asserts no `style="`
   is emitted; `cardsView.test.ts` asserts the policy still forbids it.
2. **Every class needs a rule.** `panel.stylesheet.test.ts` collects every class the script
   writes — from `class="…"` literals *and* `classList.add/remove/toggle` — and fails if one
   has no rule. It strips comments first, because this stylesheet names half its own classes in
   prose.
3. **Colours come from the theme.** Everything is a `--rl-*` token resolving to a
   `--vscode-*` variable. A test fails on a raw hex outside the token block and the kind palette.
4. **Nothing may change size on interaction.** Hover, press and busy states may change colour
   only. A button that grows moves the card, which moves every card under it, while someone is
   reading one.

## The extension half

`cardsView.ts` builds `CardData` for each note — the panel never sees a `ReviewNote`. It is a
deliberate translation layer: the panel gets `kindColor`, `fileRef`, `firstLine`, `seenTurns`,
`route`, `queued` — flattened, pre-decided values, so the panel makes presentation decisions
only and never has to know the model.

`postNotes()` is synchronous and cannot fail. `postSession()` may be slow (it shells out to find
sessions) and is never awaited on the render path.
