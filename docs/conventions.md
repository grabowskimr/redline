# Conventions

Read this before adding anything. Most of it is about *where* a thing goes, which is the
decision that ages worst if you get it wrong.

## Where a new file goes

One folder per subsystem, named for what it owns. See the table in
[`architecture.md`](architecture.md#subsystems).

`src/` root holds three files and should keep holding three: `extension.ts` (the entry point),
`config.ts` and `logger.ts` (used by everything). A fourth file at the root means a subsystem
is missing.

**Do not close a loop.** No two subsystems import each other; see the table in
[`architecture.md`](architecture.md#subsystems). If a new import would create one, the thing
the two modules share almost certainly belongs in `model/` — that is what `images.ts` is — or
the dependent one should take the function it needs rather than the whole object.

If a new file needs the editor for plumbing but contains a **decision** worth testing, split
it: the decision goes in its own `vscode`-free module. That is why `sendQueue.ts`,
`serialise.ts`, `dropPayload.ts`, `runFiles.ts`, `hunks.ts` and `report.ts` exist. Each was
once buried in a module that imported `vscode` and could not be tested until it was lifted out.

## Adding a command

Four places, and the type system catches three of them:

1. `package.json` → `contributes.commands` (title, category `Redline`, icon).
2. `src/commands/index.ts` → add the id to `COMMAND_IDS`.
3. `src/extension.ts` → add the handler to the map passed to `registerAllCommands`.
   `CommandMap` is `Record<CommandId, CommandHandler>`, so a missing handler is a type error.
4. `package.json` → `contributes.menus`. **If it belongs in no menu, it needs
   `"when": "false"` in `commandPalette`** — and then ask whether it should exist at all.

That last point is not pedantry. A recent review found five commands reachable from no menu,
no palette entry and no panel button: they had been registered and forgotten. Two were
*documented in the README*. They are gone now.

Handlers are wrapped so a thrown error becomes a toast plus a *Show log* button rather than a
silent no-op.

## Adding a setting

1. `package.json` → `contributes.configuration.properties`, with a description that says what
   it does, not what it is.
2. `src/config.ts` → a getter. **Always go through `Config`**, never
   `workspace.getConfiguration()` directly: `Config.get()` uses `inspect` so it can tell "set to
   the default" from "not set", which is what makes the legacy `localReview.*` fallback work.
   One setting bypassed this and its fallback had been dead for months.
3. Document it in the README's Settings table. `packaging.test.ts` fails if you do not.

## Adding a note kind

1. `src/model/note.ts` → `KIND_META` (`icon`, `themeIcon`, `color`, `weight`, `label`,
   `description` — all six are required, and `themeIcon` is what the widget and the kind picker
   draw).
2. `media/cards.css` → a `.k-<kind> { --k: <colour>; }` rule. A test fails without it.
3. Optionally a one-click command in the widget toolbar — but only if it earns a place there;
   five kinds already do, and `Set Kind…` lists them all.

Colours are the panel's own, not the theme's: there is no set of ten theme variables that stays
distinguishable. Everything else is a token — see below.

## Colour, in the panel

Every colour comes from a `--rl-*` token defined at the top of `media/cards.css`, and every
token resolves to a `--vscode-*` variable with the old hand-picked value as its fallback. A test
fails on a raw hex outside the token block and the kind palette.

Shading is `color-mix` against a token, never a second hand-picked value: "the surface, a little
lighter" holds in a light theme as well as a dark one, where a fixed `#34363b` only ever held in
the one it was picked for.

## Comments

The codebase has an unusual comment style and it is deliberate: comments explain **why**, and
especially what went wrong before. `// Bounded, not because of a spec, but because a wedged git
pinned the panel for the life of the window` is worth ten lines saying what a timeout is.

The test for whether a comment earns its place: would deleting the code it sits on look
reasonable to someone who has not read this file? If yes, the comment is load-bearing.

Do not write comments that restate the code, or that describe behaviour that has since changed.
Stale comments are worse than none — a review of this repo found four describing superseded
behaviour, each of which would have misled the next reader.

## Errors

- **User-facing failures get a message.** A silent no-op is the worst outcome: it looks like a
  bug in the button.
- **Housekeeping failures are swallowed** — cleaning a temp file must never be the reason a
  send fails.
- **Everything else goes to the log** via `logger.warn`/`trace`, never to `console`.
- Never let a `catch` hide a case you have not thought about. `catch { /* the caret lands at
  the end */ }` is fine; a bare `catch {}` is a question mark.

## Before you commit

```sh
npm test            # types, media syntax, the unit suite
npm run lint
```

And for anything touching the panel, the plugin or the range:

```sh
npm run test:scenario
```

Then build and install it, and actually use it for a few minutes:

```sh
npm run compile && npx @vscode/vsce package --no-dependencies -o /tmp/redline.vsix
code --install-extension /tmp/redline.vsix --force
```

Several bugs in this codebase's history passed every test and were obvious within ten seconds
of looking at the panel.
