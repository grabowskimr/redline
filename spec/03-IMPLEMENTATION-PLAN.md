> **Superseded — kept for history.** This is part of the original build handoff that Redline
> was written from, when it was called Local Review. It names `localReview.*` commands, settings
> that were never built, and a panel implemented as a tree view rather than a webview. It is not
> a contract with anything. For how Redline works now, read [`docs/`](../docs/); for what it does,
> read [the README](../README.md).

# Implementation plan

Build in the order below. Each phase ends in a state that can be run with `F5` and
manually verified. Do not start a phase before the previous one's acceptance criteria pass.

Report at the end of each phase: what was built, what deviated from this spec and why,
what's still stubbed.

---

## Phase 0 — Scaffold (0.5 day)

**Tasks**
1. `npm create` a TypeScript extension skeleton (or hand-roll; do **not** run
   `yo code` interactively). Structure per `01-ARCHITECTURE.md` §1, with empty modules.
2. `tsconfig.json`: `strict: true`, `target: ES2022`, `module: Node16`, `noUncheckedIndexedAccess`.
3. esbuild bundling (`esbuild.js` with `--bundle --external:vscode --platform=node`),
   npm scripts: `compile`, `watch`, `package`, `lint`, `test`.
4. ESLint + Prettier, `.vscodeignore`, `.gitignore`.
5. `package.json` with the full manifest from `02-CONTRIBUTIONS.md` — all commands
   registered as no-op stubs so nothing throws.
6. `.vscode/launch.json` for the Extension Development Host.
7. `logger.ts` + output channel wired in `activate`.

**Acceptance:** `F5` opens a dev host, the Local Review activity-bar icon appears, the
view shows the welcome text, every command in the palette runs without error.

---

## Phase 1 — Model, store, persistence (1 day)

**Tasks**
1. `model/note.ts`, `model/ids.ts`, `model/schema.ts` per the data model.
2. `store/persistence.ts`: async load/save against `context.storageUri`, debounced 300 ms,
   atomic write via tmp + rename, corrupt-file quarantine.
3. `store/reviewStore.ts`: CRUD, `onDidChange`, in-memory truth, save on every mutation.
4. `store/archive.ts`: `archiveActive()`, `restore()`, cap at `archiveLimit`.
5. `config.ts`: typed getters, `onDidChangeConfiguration` re-read.
6. Support `localReview.storage === 'workspaceFolder'` (`.review/notes.json`) including the
   one-time "add to `.git/info/exclude`?" prompt.
7. Unit tests for store CRUD, archive rotation, schema migration, corrupt-file recovery.

**Acceptance:** unit tests green; a note added via a temporary debug command survives a
window reload; deleting `notes.json` mid-session doesn't crash anything.

---

## Phase 2 — Inline comment UX (2 days) ⚑ highest risk

**Tasks**
1. `comments/rangeProvider.ts` — `+` on hover for supported documents, with scheme, glob,
   and size guards.
2. `comments/commentHost.ts` — controller lifecycle, `threadsByNoteId` map, lazy thread
   materialisation on `onDidChangeVisibleTextEditors`, disposal on store `clear`.
3. `comments/noteComment.ts` — `NoteComment implements vscode.Comment`, markdown body with
   kind badge, `contextValue`.
4. `commands/noteCommands.ts`:
   - `createNote(reply: vscode.CommentReply)` — guard empty text, build the anchor, add to
     store, convert the empty thread in place.
   - `addAddendum(reply)` — append to `note.addenda`.
   - `editComment(comment)` / `saveComment(comment)` / `cancelEdit(comment)` — toggle
     `CommentMode`, reassign `thread.comments` to force re-render.
   - `deleteNote(threadOrTreeItem)` — accept both argument shapes.
   - `setKind` — quick pick over `NoteKind`, updates badge + tree icon.
   - `addSuggestion` — multiline input box (or open a scratch untitled doc and read it
     back on close; prefer the input box for v1).
5. `commands/navCommands.ts` — `quickAddNote` (input box at cursor/selection),
   `revealNote` (open, `revealRange` with `InCenterIfOutsideViewport`, expand the thread).
6. Wire `git/gitApi.ts` to stamp `note.git` at creation. Best-effort, never blocking.

**Acceptance:**
- Hovering the gutter of any file shows `+`; clicking opens the widget with the configured
  prompt text.
- Typing + `Cmd+Enter` creates a note and the widget collapses to a rendered comment —
  no flicker, no second empty widget left behind.
- Selecting 5 lines then clicking `+` produces a note whose range is those 5 lines.
- Edit, save, cancel, and delete all work from the widget's `…` menus.
- Reloading the window restores every thread in the correct place.
- Creating a note in a 200k-line generated file is refused gracefully (no `+` shown).

**Watch out for:**
- `thread.comments` must be *reassigned*, not mutated, or the UI won't update.
- Command arguments differ by invocation site (`CommentReply` vs `Comment` vs `TreeItem`);
  write a small `resolveNoteId(arg)` helper rather than trusting one shape.
- Empty threads the user abandons: don't leak entries in the map.

---

## Phase 3 — Panel (1 day)

**Tasks**
1. `view/notesTreeProvider.ts` with the four grouping strategies + filter.
2. `view/treeItems.ts` — labels, descriptions, markdown tooltips (body + fenced snippet),
   kind icons, `contextValue`s.
3. Tree ↔ store subscription; `TreeView.badge`; reveal-in-tree when a thread is focused
   (optional, via `onDidChangeTextEditorSelection` → `treeView.reveal`).
4. `view/statusBar.ts` — `$(comment-discussion) 12` with tooltip and click → focus view.
5. Context keys (`hasNotes`, `hasArchive`, `filterActive`, `grouping`) maintained on every
   store change.
6. Tree item actions: done, park, copy, delete, set kind, delete-all-in-file.

**Acceptance:** adding a note from the editor makes it appear in the panel instantly;
clicking it jumps to the exact range and expands the widget; grouping and filter both
work; the badge and status bar counts match the number of active notes.

---

## Phase 4 — Render & submit (1 day)

**Tasks**
1. `export/formatters/*` — the four built-ins plus `custom` interpolation.
2. `export/renderBatch.ts` — header assembly, git context, snippet extraction with
   context lines and truncation, 1-based line conversion, orphan section.
3. `export/submit.ts` — confirm → clipboard write → verify readback → archive → clear →
   toast with `Undo` / `Show batch`.
4. `previewBatch` — open the rendered markdown in an untitled document
   (`workspace.openTextDocument({ content, language: 'markdown' })`), preview to the side.
5. `copyNote`, `copyFileNotes`, `exportToFile`, `restoreLastBatch`, `clearAll`
   (`clearAll` requires a modal confirm; it does *not* archive silently — archive it too).
6. Unit tests for all formatters against fixture batches, including: empty batch,
   single note, multi-line ranges, notes with suggestions, orphaned notes, a note whose
   body contains a fenced code block (make sure fences don't collide — use 4-backtick
   outer fences when the body contains 3-backtick fences).

**Acceptance:** submit copies text matching the fixture in `04-OUTPUT-FORMATS.md` §2,
clears the panel and all inline widgets, and `Undo` puts everything back exactly —
including anchors and kinds.

---

## Phase 5 — Anchoring (1.5 days)

**Tasks**
1. `anchor/anchorService.ts` — `create()` and `resolve()` per `01-ARCHITECTURE.md` §6.2,
   as a pure module (input: file text + anchor; output: range or undefined).
2. `anchor/liveTracker.ts` — `onDidChangeTextDocument` range transforms + debounced
   re-anchor for dirty notes; reconcile `thread.range` back into the store on save.
3. `onDidRenameFiles` / `onDidDeleteFiles` handling.
4. FileSystemWatcher for files with notes → re-resolve on external change (this is the
   Claude-Code-edits-the-file case, and it's the important one).
5. Orphan UX: pinned tree group, `Re-anchor at Cursor`, `Keep as file-level note`.
6. Unit tests: insertion above / below / inside, deletion of the anchored block,
   duplicate snippets disambiguated by context, whole-file reformat (prettier run),
   file renamed, file deleted.

**Acceptance:** with notes on lines 10, 50 and 200, run a real Claude Code edit session
that inserts and removes code across the file — all three notes end up on the right lines
or, if genuinely destroyed, appear in the orphan group with their snippet intact. No note
is ever silently lost.

---

## Phase 6 — Polish & extras (1 day)

**Tasks**
1. `nextNote` / `prevNote` walk mode.
2. `changedLinesOnly` + `baseRef` (F22) via `git/changedLines.ts` and diff-hunk parsing.
3. Diff-editor handling per `01-ARCHITECTURE.md` §8.
4. Multi-root correctness pass.
5. README with a GIF-worthy description of the flow, an explicit "no network, no telemetry"
   statement, the custom-template placeholder reference, and the keybindings table.
6. CHANGELOG, `resources/icon.svg` (monochrome, follows the activity-bar icon guidelines:
   24×24, single colour, `currentColor`), marketplace `icon.png` (128×128).
7. Integration tests via `@vscode/test-electron`: activate, create a note through the
   command layer, assert store + tree state, submit, assert clipboard.

**Acceptance:** `vsce package` produces a `.vsix` that installs cleanly in a fresh VS Code
and the full journey works from a cold start.

---

## Backlog (do not build in v1 unless asked)

F21 named batches · F25 markdown import / round-trip · F26 drag reorder ·
F27 symbol-based anchors · F30 auto-paste into a terminal.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Comments API surprises (thread re-render, menu `when` clauses) | Phase 2 is scheduled first after the store and given the most time. If a `when` clause misbehaves, log `commentController`/`comment` context values and adjust rather than working around with extra commands. |
| Anchors drift and notes point at the wrong code | Content-based resolution, never delete on failure, always show the stored snippet in the output so a human can still locate it. |
| Clipboard write fails silently (Wayland, remote SSH) | Read-back verification + untitled-document fallback. |
| Submit destroys work | Archive before clear, `Undo` action, `restoreLastBatch` command. |
| Off-by-one in line numbers | 0-based internally, converted once in `renderBatch`; unit-tested with explicit fixtures. |
| Notes leak into git | Default storage is outside the repo; the opt-in path offers `.git/info/exclude`. |

## Definition of done

- All Phase 0–6 acceptance criteria pass.
- `npm run lint` and `npm test` clean.
- No `any` in `src/` except at documented VS Code API boundaries.
- Every registered command handles being invoked from the palette with no arguments
  (either acts sensibly or shows a clear message) — this is the most common crash source.
- README documents every setting and command.
