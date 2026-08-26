# Redline

**Review Claude Code's work — inline notes on the lines that need changes, handed back as one prompt.**

You already know how to review code: read the diff, leave comments on the lines that are
wrong, request changes. Redline gives you that same loop when the author is an agent. You
mark up its work in the editor, and the marked-up copy goes back to the Claude Code session
running in this folder.

Notes live **only on your machine** — no network, no telemetry, no accounts. The extension
adds exactly one thing to your editors: the `+` in the gutter for leaving a note. Changed
lines stay VS Code's own git indicators.


## The loop

**1. Claude works** — in a terminal, in Orca, wherever. You don't need VS Code open.

**2. You open VS Code** and click **Last** on the session strip: a PR-style multi-file diff
of everything that changed since the session started, including work it committed. `⌥F7` /
`⇧⌥F7` walk hunk by hunk. **All** widens the range to every change since the base.


**3. You leave notes** on the lines that need work — hover the gutter for `+`, or select
lines and press `⌘⌥M`. The widget's toolbar carries the five kinds worth one click — change
request, bug, question, idea, refactor — with the rest behind **Set Kind…**, plus **send this
note** and **remove it**, so a single piece of feedback never needs the panel.


**4. Send** (`⌘⌥S`). The notes become one prompt for the Claude Code session in this folder —
and go to your clipboard as a fallback. **Preview Notes** shows you exactly what it will
receive first. Three notes on two files produce this:

<details>
<summary>The generated prompt</summary>

````markdown
I reviewed the generated code and have some feedback: 2 change requests, 1 question.
Work through the change requests in order; if one is unclear or you disagree, say so and ask before changing it. Answer the questions first — only change code for a question if we agree. Only touch the files listed below; don't make unrelated changes.

**Branch:** feat/annual-billing · **HEAD:** e746bf1 (uncommitted changes present)

## Change requests

### #2 — src/billing/load.ts · Line 2
Kind: security
Code:
```ts
  const rows = await db.query(`SELECT * FROM plans WHERE id = ${id}`);
```
User comment: "id goes straight into the query. Use a parameterised statement."

### #1 — src/billing/price.ts · Line 3
Kind: bug
Code:
```ts
  return base;
```
User comment: "This drops the annual discount — base is returned before applyDiscount runs."

## Questions

### #3 — src/billing/price.ts · Line 3
Kind: question
Code:
```ts
  return base;
```
User comment: "Why return early here rather than falling through to the tax step?"

## When you are done

Reply with one line per note so I can track it, using exactly this format:
`#<number> done` · `#<number> skipped — <reason>` · `#<number> answer: <your answer>`
````

</details>


**5. Keep talking about it.** A note is a conversation, not a one-shot. Claude is asked to say
what it did in each report line — "done — moved applyDiscount above the return" rather than a
bare "done" — and that becomes its turn beside your note. The note stays on its line, so you
can click the marker and add a follow-up. It goes live again (**✎ follow-up not sent**), so you
can attach a screenshot first, and **➤** sends the whole exchange: your original note, Claude's answer, your correction. That repeats until you
remove the note. Useful when it changed the right file for the wrong reason.

**6. Track the round.** Sent notes stay in the panel with a live badge — **✏️ code changed**
or **⏳ not addressed yet**. When Claude replies with `#4 done` / `#4 skipped — reason` /
`#4 answer: …`, **Apply Claude's Report** marks them ✅ / ⛔ / 💬 and attaches its answers to
the cards.

The report is read from the session transcript rather than the terminal: an agent TUI
repaints in place, so a terminal capture is mostly redraw frames and the reply is usually
not in it. The terminal and the clipboard are fallbacks.


## What "changed" means

The review range is resolved for you, in this order:

1. a baseline you pinned yourself (**Pin Baseline Here**),
2. **the commit HEAD pointed at when the current Claude session started** — read from
   Claude Code's own transcript for this folder, so changes it *committed* count too,
3. otherwise **everything this worktree has that the remote does not** — local commits
   included, which a plain `HEAD` comparison would hide.

Every automatic base is clamped to **the last published commit**: the review never reaches
back past a `git pull`. Without that clamp, a session that started before a pull is told
that every file the pull brought in changed — on a real worktree that was 2353 files where
the honest answer was none.

Because a commit is always compared against the working tree, this works when VS Code is
opened long after the agent finished. The file list is `git diff --name-only <base>` plus
untracked files, so modified, staged, newly added, deleted, renamed and **committed-during-
the-session** files all count. Gitignored files do not.

**Last** narrows that to your most recent request. The boundary is the last thing *you* asked
for, read from the session transcript, so three requests a few minutes apart stay three
separate reviews. If no request can be found, the run is cut where the agent was idle longer
than `redline.lastRunGapMinutes`; with no transcript at all it falls back to clustering file
modification times, which cannot tell your own saves from the agent's work.

## The Claude Code plugin (optional)

Redline works on its own. The plugin makes it exact and quiet:

```sh
claude plugin marketplace add /path/to/redline     # this repo, or the installed extension
claude plugin install redline@redline
```

Restart Claude Code. `claude plugin details redline` shows four hooks and **~0 tokens added to
every session** — they are harness-only and never enter the model's context.

**What it buys you**

- **Exact attribution.** Timestamps cannot tell *who* changed a file; a save of yours, or a
  formatter's write, looks like the agent's work. The hook records the agent's own edits, so
  **Last** means "files Claude changed" rather than "files that changed while Claude worked".
- **Line-level accuracy.** At `UserPromptSubmit` it copies every already-modified file, and
  **Last** diffs against those copies — so editing line 2 in one run and line 4 in the next
  shows line 4 alone. Git cannot do this: a diff against a base commit is cumulative.
- **A panel that keeps up.** Redline watches the hook's own directory, so figures move about
  half a second after the agent writes a file instead of on a timer.
- **Sending that always lands.** Without the plugin the whole prompt is typed into the
  terminal, and several kilobytes take an unpredictable time to be ingested — which is what
  made Enter unreliable. With it, the prompt is written to disk and a short token is typed;
  the hook injects the feedback into the model's context.

The hook writes only to `~/.claude/redline/<slug>/`, never into your repository. It answers
immediately and does its work detached, so it adds no measurable time to a tool call — apart
from the run-start snapshot, which must finish before the agent starts editing and costs about
150 ms on a 42k-file repository.

**Editing `settings.json` by hand still works** and is what earlier versions asked for. If you
did that, remove those entries once the plugin is installed, or every hook runs twice —
**Redline: Set Up Claude Code Plugin** checks for exactly that and tells you.

## Notes## Notes

- **Kinds** shape how the agent treats a note. The widget has one-click 🐞 bug · 💭 question ·
  💡 idea; **Set Kind…** lists them all. Prefixes work too: `? why`, `! crash`, `* what if`,
  `~ rename`, `+ nice`.

  | kind | means | the agent is told |
  |---|---|---|
  | 💬 change request | change this as described | do it |
  | 💡 idea | improve / extend this | implement if easy, else sketch and ask |
  | 🐞 bug · 🔒 security · ⚡ perf · 🔧 refactor · ✂️ nit · 📌 todo | flavours of change request | do it |
  | 💭 question | explain before changing | answer first |
  | ✨ praise | this is good | no action |

- **Screenshots**: click 📎 on a card to pick an image, press ⌘V with a card focused to
  paste one, or **hold ⇧ while dragging** an image file onto a card. The ⇧ is not optional:
  VS Code blocks pointer events over every webview during a drag and lifts the block only
  while Shift is held, so a plain drag never reaches the panel. Images are stored outside
  your repo and passed to the agent as a file path it reads.
- **Suggested change**: attach the code you want. **Apply Suggested Change Locally** (in `⋯`)
  applies it with a normal undoable edit — no round-trip for mechanical fixes.
- **Anchors are content-based**: notes follow their code when the agent rewrites a file. If
  the code truly disappears the note is kept, flagged ⚠ stale, and can be re-anchored.
- Notes survive reloads, live in VS Code's per-workspace storage, and never enter your repo.

## Commands

| Command | Key | Where |
|---|---|---|
| Add note | `⌘⏎` in the widget | `+` in the gutter |
| Add Note at Cursor | `⌘⌥M` / `Ctrl+Alt+M` | palette, editor menu |
| Send Notes to Claude Code | `⌘⌥S` / `Ctrl+Alt+S` | panel toolbar |
| Review Latest Changes · Review All Changes | — | strip **Last** / **All** |
| Go to Next / Previous Change | `⌥F7` / `⇧⌥F7` | palette |
| Apply Claude's Report · Clear Sent Notes | — | panel |
| Preview Notes · Refresh · Clear All Notes | — | panel toolbar |
| Pin Baseline Here · Clear Pinned Baseline | — | panel `…` menu |
| Choose Claude Code Session… | — | panel `…` menu, strip `⇄` |
| Restore Last Submitted Batch | — | panel `…` menu |
| Set Kind… · Add Follow-up… · Add Suggested Change… · Delete Note | — | widget title, card `⋯` |
| Show Log | — | palette |

## Sending to a session

Redline finds Claude Code processes, matches them to **this folder**, and pastes the prompt
into the right one — a VS Code integrated terminal directly, or an Orca terminal via
`orca terminal send`. A session working on a *different* worktree is never targeted; if
there is none here, the notes just go to the clipboard. macOS/Linux.

With `redline.watchSessions` on (default) an Orca session is also watched, so a run that
finishes while VS Code is open pings you with the diff.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `redline.outputTemplate` | `claude-prompt` | `claude-prompt` or `json` |
| `redline.includeSnippet` | `true` | Include the referenced source lines |
| `redline.includeGitContext` | `true` | Repo, branch and HEAD in the prompt |
| `redline.scopeGuard` | `true` | Tell the agent to touch only these files |
| `redline.requestReport` | `true` | Ask for `#12 done` lines so the panel can update itself |
| `redline.confirmOnSubmit` | `true` | Confirm before sending |
| `redline.defaultKind` | `comment` | Kind given to new notes |
| `redline.kindPrefixes` | `true` | `? ` `! ` `* ` `~ ` `+ ` set the kind |
| `redline.claudeAutoSubmit` | `true` | Press Enter for you in the session |
| `redline.clearDoneAfterReport` | `false` | Remove notes Claude reported as done, instead of leaving them for a reply |
| `redline.watchSessions` | `true` | Watch the session and offer the diff when a run ends |
| `redline.excludeGlobs` | `node_modules`, `dist`, `*.min.*`, `.git` | No `+` in these files |
| `redline.maxFileLines` | `50000` | No `+` in files longer than this |
| `redline.showStatusBar` | `true` | Note and changed-file counts in the status bar |
| `redline.lastRunGapMinutes` | `15` | Idle gap that separates one run's changes from the last |
| `redline.trace` | `errors` | Output-channel verbosity |

Settings you wrote as `localReview.*` before the rename are still read, so nothing breaks if
you don't touch them.

## Appearance

The comment widget is VS Code's own, themed by `editorCommentsWidget.*`. Redline sets one
default: the reply bar's background is transparent, so it takes the widget's colour instead of
sitting on it as a slab. Transparency rather than a colour, because a literal one would be
wrong on half the themes people use.

Override it, or tune the rest, in your settings:

```json
"workbench.colorCustomizations": {
  "editorCommentsWidget.replyInputBackground": "#00000000",
  "editorCommentsWidget.unresolvedBorder": "#d97757",
  "editorCommentsWidget.resolvedBorder": "#00000040",
  "editorCommentsWidget.rangeBackground": "#d9775714"
}
```

## Privacy

No network access of any kind, no telemetry. Git and session information is read locally;
nothing leaves the machine until you paste it yourself.

## Renamed from Local Review

Redline was called **Local Review**. Workspace storage is keyed by extension id, so the
first activation copies your existing notes and screenshots across and tells you it did.
The old extension is a separate install — uninstall it once you're happy.

## Development

```sh
npm install
npm run watch              # esbuild, then F5 for the Extension Development Host
npm test                   # typecheck + webview syntax check + unit tests
npm run test:integration   # @vscode/test-electron (includes a panel-boot smoke test)
npm run package            # → redline-<version>.vsix
```

The panel is a webview whose script and stylesheet are real files in `media/` — they are
syntax-checked by `npm test`, and unit tests drive `media/cards.js` directly against a DOM
shim, which is what keeps the drag, paste and render paths from silently breaking.
