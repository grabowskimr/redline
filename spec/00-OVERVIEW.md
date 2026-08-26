# Local Review — VS Code Extension

> Handoff spec for Claude Code. Read this file first, then `01-ARCHITECTURE.md`,
> `02-CONTRIBUTIONS.md`, `03-IMPLEMENTATION-PLAN.md`, `04-OUTPUT-FORMATS.md`.

---

## 1. Problem

When reviewing code (own branch, a PR, or AI-generated changes), the natural place to
capture feedback is *inline, next to the line*. GitHub's PR extension gives that UX but
requires a real PR and posts comments to GitHub.

I want the same inline UX, but:

- notes stay **100% local** — no network, no GitHub, no auth;
- they accumulate into a **review batch** visible in a side panel;
- a single **Submit** action renders the whole batch as one markdown blob, copies it to
  the clipboard, and clears the list;
- that blob gets pasted into a **separate Claude Code session** which then does the work.

So this extension is a *feedback capture buffer* between "human reads code" and
"agent fixes code".

## 2. Non-goals

- No GitHub / GitLab / Bitbucket API integration.
- No multi-user collaboration, no sync, no server.
- No AI calls from inside the extension (the whole point is handing off to a session
  the user already controls).
- Not a replacement for the GitHub PR extension when a real PR review is wanted.

## 3. Naming (change freely)

| Thing | Value |
|---|---|
| Extension id | `local-review` |
| Publisher | `marcin` (placeholder) |
| Display name | Local Review |
| Command prefix | `localReview.` |
| Comment controller id | `localReview.notes` |
| Activity bar container | `localReview` |
| Settings namespace | `localReview.*` |

If renaming, rename consistently across `package.json`, `when` clauses, and command ids.

## 4. Core concepts

**Note** — one piece of feedback anchored to a file + line range. Has a body (markdown),
an optional kind/severity tag, an optional suggested replacement snippet, and an anchor
(so it survives edits).

**Thread** — the inline widget in the editor. One thread == one note. Additional comments
inside the thread are *addenda* appended to the note body on export.

**Batch** — the current set of unsubmitted notes. There is exactly one active batch per
workspace. Submitting renders + clears it and pushes it to the archive.

**Archive** — the last N submitted batches, kept on disk so a submit is never destructive.

## 5. User journeys

### 5.1 Add a note inline (primary flow)

1. User hovers over the gutter of any line in a normal editor or a diff editor.
2. A `+` icon appears (standard VS Code commenting-range affordance).
3. Click it (or select several lines and click, or press `Cmd/Ctrl+Alt+M`).
4. An inline comment widget opens with a text box, a kind picker in the title bar, and an
   `Add note` button.
5. Typing and pressing `Cmd/Ctrl+Enter` (or clicking `Add note`) saves the note.
6. The widget collapses to a compact rendered comment; the gutter shows the comment icon.
7. The note appears immediately in the **Review Notes** panel and the status bar count
   increments.

### 5.2 Manage notes

- Panel is a tree: `Batch → file → note`. Note label is the first line of the body,
  description is `L142-150`, tooltip is the full body + code snippet.
- Click a note → opens the file, reveals the range, expands the inline widget.
- Per-note inline actions: `Edit`, `Delete`, `Toggle done`, `Copy this note`.
- Per-file action: `Delete all notes in file`.
- Panel toolbar: `Submit`, `Preview`, `Clear all`, `Group by: file | kind | time`, `Refresh`.
- Editing is possible either in the inline widget or via the tree (opens the widget).

### 5.3 Submit

1. `Submit` (panel toolbar, command palette, or `Cmd/Ctrl+Alt+S`).
2. Extension renders the batch using the configured template (see `04-OUTPUT-FORMATS.md`).
3. If `localReview.confirmOnSubmit` is true, show a preview in an untitled markdown doc
   with `Copy & clear` / `Copy only` / `Cancel` buttons (modal quick pick or notification).
4. On confirm: write to clipboard, move batch to archive, clear all threads + tree +
   decorations, toast `Copied 12 notes across 5 files. Undo?`.
5. `Undo` (or `localReview.restoreLastBatch`) restores the archived batch verbatim.

### 5.4 Orphaned notes

If a file changed under a note and the anchor can't be found, the note is not deleted.
It moves to a `⚠ Needs re-anchoring` group in the tree, keeps its stored snippet, and
offers `Re-anchor here…` (uses the current cursor position) or `Keep as file-level note`.

## 6. Feature list

### Must-have (v1)

| # | Feature | Notes |
|---|---|---|
| F1 | Inline `+` gutter affordance on every line of supported documents | via `commentingRangeProvider` |
| F2 | Inline widget to create / edit / delete a note | via `CommentController` |
| F3 | Multi-line notes from a selection | range comes from the selection |
| F4 | Local persistence, per workspace, survives reload | JSON in `context.storageUri` |
| F5 | Tree view panel in its own activity-bar container | grouped by file |
| F6 | Navigate from tree → editor location | reveal + expand thread |
| F7 | Submit = render + copy to clipboard + clear | with confirm + undo |
| F8 | Status bar item with pending count, click → focus panel | |
| F9 | Anchor notes to content, not just line numbers | see `01-ARCHITECTURE.md` §6 |
| F10 | Works in the diff editor (both sides) | map `git:` URIs to workspace paths |

### Should-have (v1.1)

| # | Feature | Notes |
|---|---|---|
| F11 | Note **kind**: `bug`, `nit`, `question`, `refactor`, `perf`, `security`, `praise`, `todo` | drives icon + grouping + output section order |
| F12 | **Suggested change** block — a fenced code block the agent should apply | ```suggestion fences, like GitHub |
| F13 | Configurable **output templates** with presets: `claude-prompt`, `checklist`, `json`, `plain` | user can supply own template string |
| F14 | Code snippet context in output (N lines before/after, configurable) | default 0 before / 0 after, snippet = the anchored lines |
| F15 | Git context in the header: repo name, branch, HEAD sha, dirty flag | via built-in `vscode.git` extension API |
| F16 | Archive + `Restore last batch` | keeps last 20 batches |
| F17 | Preview batch as an untitled markdown document | |
| F18 | `Copy single note` / `Copy file's notes` | same formatter, filtered |
| F19 | Quick add without a widget: `Add note (quick input)` bound to a key | for keyboard-only flow |
| F20 | Filter/search box in the tree (`localReview.filter`) | matches body + path + kind |

### Nice-to-have (backlog)

| # | Feature | Notes |
|---|---|---|
| F21 | Named batches / multiple parallel batches | e.g. `auth-refactor`, `perf-pass` |
| F22 | `Review changed lines only` mode — restrict `+` affordance to lines in the diff vs a base ref | reduces noise on huge files |
| F23 | Walk mode: `Next note` / `Previous note` navigation across the batch | `F8`-style |
| F24 | Export batch to a file instead of clipboard (`.review/2026-08-23-batch.md`) | |
| F25 | Import: parse a markdown batch back into notes (round-trip) | useful for resuming |
| F26 | Priority ordering / drag-reorder in the tree | output preserves order |
| F27 | Snippet-only notes: attach a note to a symbol (via `DocumentSymbolProvider`) rather than a line | more edit-resistant |
| F28 | Per-note "include in submit" checkbox (park a note without deleting) | |
| F29 | Batch stats in the header: counts by kind | agent can prioritise |
| F30 | Auto-open the Claude Code terminal and paste (opt-in, `localReview.pasteTarget`) | risky; keep opt-in |

## 7. Key design decisions (already made — don't re-litigate)

1. **Use the native `vscode.comments` API**, not a webview and not decorations + hovers.
   It is exactly the mechanism the GitHub PR extension uses; it gives the gutter `+`,
   the widget, keyboard handling, and theming for free.
2. **One thread = one note.** Replies are supported but flattened into the note body on
   export as `--- addendum ---` blocks. Do not model conversations.
3. **Storage location is `context.storageUri/notes.json`**, not `.vscode/`. Reviews are
   personal scratch data and must not be committed by accident. A setting
   (`localReview.storage: "workspaceStorage" | "workspaceFolder"`) can opt into
   `.review/notes.json` for people who want it, and in that case the extension offers to
   add `.review/` to `.git/info/exclude`.
4. **Submit clears by default** but always archives first, and the toast offers Undo.
   Never lose user-written text.
5. **Anchors are content-based** (snippet + hash + line hint), because the whole workflow
   is "review, hand to agent, agent edits the file" — line numbers *will* move.
6. **No network calls, ever.** The extension should work fully offline. Add a note in the
   README stating this explicitly.

## 8. Assumptions

- VS Code engine `^1.90.0`, TypeScript 5.x, esbuild for bundling, pnpm or npm.
- Single-root workspaces are the primary target; multi-root must not crash (notes keyed by
  workspace-folder-relative path + folder name).
- The user is on macOS and Linux; use `Cmd` on darwin, `Ctrl` elsewhere via `mac`/`win`
  keybinding fields.
