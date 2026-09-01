# Testing

Four suites. Knowing which one to reach for is most of the skill.

| | command | runs in | takes | for |
|---|---|---|---|---|
| **unit** | `npm run test:unit` | plain node + mocha | ~10 s | almost everything |
| **integration** | `npm run test:integration` | a real VS Code | ~30 s | the editor's own behaviour |
| **scenario** | `npm run test:scenario` | real VS Code + a real repo | ~40 s | the extension reading a run's state |
| **real-repo** | `npm run test:real` | as above, against a repo you name | varies | measuring on your own monorepo |

`npm test` runs the type check, the media syntax check and the unit suite. That is the gate to
pass before committing.

## The unit suite

the bulk of the suite, and the one you should be adding to. It is fast enough to run on every save and it
can be pointed at a single function.

Two things make it able to test more than a unit suite usually can:

### The `vscode` stub

`src/test/unit/support/vscode.ts` stands in for the editor, registered by
`src/test/unit/support/register.ts` before mocha loads anything. Half the source imports
`vscode`, and until this existed the four largest files had no test that could even load them.

It is deliberately thin. Everything in it either does the real thing (`Uri`, `EventEmitter`,
`Position`, workspace-folder resolution) or records that it was asked (`shown.messages`,
`shown.statusBar`). **Anything not modelled is absent**, so a module reaching for it fails
loudly rather than quietly seeing `undefined`. When you hit that, add the smallest honest thing
that satisfies it — never a behaviour the editor does not actually have.

`vscode.state` is what a test sets up front: `trusted`, `folders`, `settings`, `clipboard`.
`vscode.resetStub()` in a `beforeEach` puts it back.

### The panel harness

`src/test/unit/support/panelHarness.ts` runs the **real** `media/cards.js` against a minimal
DOM shim, so panel tests exercise the shipped file rather than a copy of its logic. The panel
tests are split by concern:

| | |
|---|---|
| `panel.card.test.ts` | one card, in every state |
| `panel.list.test.ts` | which cards show, in what order, what a repaint costs |
| `panel.dnd.test.ts` | dragging a screenshot on, and what a running command looks like |
| `panel.session.test.ts` | the card at the top |
| `panel.stylesheet.test.ts` | the rules that must exist for any of it to be visible |

### Real git, and the real hook, where they are the subject

`reviewRange.test.ts` builds a repository in a temp directory and runs real git against it.
Stubbing git there would only confirm what the test author already believed.

`hook.test.ts` runs the plugin's actual script as a subprocess — a JSON payload on stdin,
`HOME` pointed at a temp directory — and reads what it wrote back with the extension's own
readers, so the two halves of the product check each other rather than a copy of one of them.

Note what the **scenario** suite does *not* do: it reimplements the snapshot in shell and
hand-writes the files a run would leave, so it exercises the extension's reading and not the
plugin's writing. If you change the hook, `hook.test.ts` is what will notice.

## The tests that exist to catch a specific class of bug

These are worth knowing about, because each was written after something shipped broken:

- **Every class the panel writes has a CSS rule.** Correct markup with no styling produces no
  error at all — this shipped four times. It reads `class="…"` literals *and* `classList` calls,
  and strips comments before looking, because the stylesheet names its own classes in prose.
- **The stylesheet is structurally sound** — braces balanced, no empty rules, no dangling
  selector lists. A script-driven edit once deleted a live rule's body and everything still
  parsed.
- **Every kind has a colour, and nothing else sets one on the kind icon.** A reset carrying
  `color: inherit` out-specified the kind's own class, and every kind looked identical.
- **The panel emits no inline `style`.** The security policy silently drops them.
- **The manifest matches reality** (`packaging.test.ts`): every setting is documented in the
  README, the repo URLs are well-formed, one copy of the hook script ships. The stronger check
  — every contributed command is actually registered — is in the *integration* suite, so it
  does not run under `npm test`.

If you fix a bug of a kind that leaves no error behind, add the guard rather than only the fix.

## Writing a test here

The house style is that a test **explains the bug it prevents**. Not "renders correctly" —
what went wrong, and what a user saw. Compare:

```ts
it('shows the follow-up', ...)                      // says nothing
it('shows the follow-up you wrote, and offers to send it', () => {
  // It went into the store and appeared nowhere: the card looked as though the words had
  // been thrown away, and the only sign anything had happened was the button changing.
```

The second tells the next person why deleting it would be a mistake.

## A trap

Deleting a test file leaves its compiled copy in `out/`, and mocha runs whatever is there — so
a test that no longer exists keeps passing, and a split file runs twice. `test:unit` clears
`out/test` first. If you ever see the count jump for no reason, that is why.
