# Redline

**Review Claude Code's work — inline notes on the lines that need changes, handed back as one prompt.**

You already know how to review code: read the diff, leave comments on the lines that are
wrong, request changes. Redline gives you that same loop when the author is an agent. You
mark up its work in the editor, and the marked-up copy goes back to the Claude Code session
running in this folder.

Notes live **only on your machine** — no network, no telemetry, no accounts. The extension adds
one thing to every editor — the `+` in the gutter for leaving a note — and, while
`redline.runGutter` is on, a second set of marks for what the last run changed, under
*Claude's last run* in the Source Control view. Your uncommitted changes stay VS Code's own
git indicators.


## Installing

Redline is not on the Marketplace. Build it from this repository and install the `.vsix`:

```sh
git clone https://github.com/grabowskimr/redline.git
cd redline
npm install
npm run package                       # → redline-<version>.vsix
code --install-extension redline-*.vsix
```

Then reload the window. Requires VS Code 1.90 or newer, macOS or Linux, and `git` on `PATH`.
The **Claude Code plugin** below is optional and installed separately — everything works
without it, less precisely.

## The loop

**1. Claude works** — in a terminal, in Orca, wherever. You don't need VS Code open.

**2. You open VS Code** and click **Last run** on the session card: a PR-style multi-file diff
of everything that changed since the session started, including work it committed. `⌥F7` /
`⇧⌥F7` walk hunk by hunk. **Everything** widens the range to every change since the base.


**3. You leave notes** on the lines that need work — hover the gutter for `+`, or select
lines and press `⌘R`. The widget's toolbar carries the five kinds worth one click — change
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
`#<number> done — <what you changed>` · `#<number> skipped — <why>` · `#<number> answer: <your answer>`

Keep each line to one sentence. It is shown beside the note in a narrow panel, so say what changed and stop — "done" alone leaves nothing to read next to code that moved, and three paragraphs are worse than one line. Point at code as `[file.ts:12](path/to/file.ts)`, which is rendered as a short link.
````

</details>


## A second round

Send a batch, read the answers, reply to the ones that need more — then send **all** of those
follow-ups in one message, the same way you sent the first round. **Reply** on a card opens a
box; **Send** — or `⌘⏎` — sends that one. The toolbar's **send** comes back as soon as any
follow-up is waiting and takes the lot, and `⌘⌥S` does the same. Sending while Claude is
working holds the notes instead: the card says so, and they all go together the moment the run
ends.

Each follow-up carries its own thread — the note, Claude's answer, your reply — so it lands
with the context it is replying to, and the whole batch goes to the session that conversation
already lives in, without asking you which one.

## Going back

**Redline: Review a Previous Run** opens the diff of a run that has already finished. The
plugin remembers the last five, both ends of each, so sending a follow-up no longer puts the
run you were reading out of reach. Both sides come from snapshots rather than from disk — the
working tree has moved on, and showing today's file beside that run's starting point would
attribute everything since to it.

## Approving what changed

Claude reporting a note as finished is a claim about the code, not a verdict on it — so the note
moves to **needs approval** rather than closing itself. Its before and after stay on the card,
and three buttons answer it: **Approve** settles it, **Not this** turns the change down and asks
you what was wrong, **Reply** carries on the conversation. All three are on the card, so nothing
asks you to type in two places — while the widget in the editor keeps showing the answer beside
the code it is about, until that code changes.

With the plugin installed the outcomes arrive as a file rather than as prose. The prompt names a
path and asks for JSON; Redline reads that and falls back to scanning the reply for `#12 done`
lines only when there is no file. Reading outcomes out of prose is what produced "0 of 3
addressed" with all three addressed.

**Answers arrive as they happen, not at the end of the turn.** The agent is asked to write that
file again each time it settles a note, and Redline reads it while the run is going — so a card
whose code you can already see change answers within a second or two of the edit, rather than
waiting for the whole batch to finish. Without the plugin there is no file to watch, and the
outcomes still arrive together when the run ends.

## While it is working

The last run's changes appear in the editor gutter, beside the git extension's own marks. Those
answer "what is uncommitted", which in a worktree an agent has worked in for an hour is nearly
everything; these answer "what did the last run change in the file I am looking at".

The same run also lists its files in the Source Control view, under **Claude's last run** —
clicking one opens that file as the run found it beside the file now, which is *Last run* for a
single file. Turn both off with `redline.runGutter`.

The panel says what the session is working on as it goes — the file it is writing, and how many
it has touched — taken from the plugin's own record rather than from the session. A terminal in
another window shows this and the panel could not.

Sending while Claude is mid-turn offers to wait: notes dropped into the middle of a turn are as
likely to be ignored as read, and queued ones go the moment the run ends.


**5. Keep talking about it.** A note is a conversation, not a one-shot. Claude is asked to say
what it did in each report line — "done — moved applyDiscount above the return" rather than a
bare "done" — and that becomes its turn on the card. The widget stays on the lines while the
code under it holds still, so the answer is readable where the code is; the whole exchange is
also on the card, with a box behind its **Reply** button. **Send**, or `⌘⏎`, sends the exchange entire: your original
note, Claude's answer, your correction — with **Attach** beside it if a screenshot says it
better. That repeats until you approve or remove the note. Useful when it changed the right
file for the wrong reason.

**6. Track the round.** Sent notes stay in the panel with a live state — **Sent** while Claude
is working, **Needs approval** once it has answered. When Claude replies with `#4 done` /
`#4 skipped — reason` / `#4 answer: …`, **Apply Claude's Report** attaches its answers to
the cards.

The report is read from the session transcript rather than the terminal: an agent TUI
repaints in place, so a terminal capture is mostly redraw frames and the reply is usually
not in it. The terminal and the clipboard are fallbacks.


## Requirements, and where it stops

- **VS Code 1.90+**, **git**, and **Claude Code** for anything to do with sessions.
- **A trusted folder.** Reviewing changes runs git, and a repository defines configuration and
  filters that git executes — so none of it runs in a restricted window. Notes still work;
  change detection resumes when you trust the folder.
- **macOS and Linux.** Finding a session to send to reads the process table, and the plugin's
  hooks are shell scripts. Notes, the panel and the whole review side work anywhere; on
  Windows every send goes to the clipboard for you to paste, which is the fallback the rest of
  the product is built around anyway.
- **One repository per window.** In a multi-root workspace Redline reviews the first folder
  that is a git repository. Every card names its own file; the change range covers that one
  repository.
- **One session at a time per worktree.** Two Claude Code sessions working in the *same*
  worktree overwrite each other's run markers; Redline notices the mismatch and falls back to
  the slower, wider answer rather than reporting a run built from both. Separate worktrees are
  unaffected — which is what worktrees are for.
- **A gitignored file is never in a review.** If Claude writes one, nothing here will show it.

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
opened long after the agent finished. Modified, staged, newly added, deleted, renamed and
**committed-during-the-session** files all count. Gitignored files do not.

**Last run** narrows that to the round you are working through: everything Claude has done
since the oldest note you have not settled yet was sent, however many messages that took. So
answering three cards one at a time still shows all of it, rather than narrowing to whichever
answer went last. Once everything is approved the round closes, and the boundary goes back to
being the last thing *you* asked for, read from the session transcript.

With the plugin installed, "the last run" is a comparison between two snapshots of the working
tree — see below. Without it, the run is cut where the agent was idle longer than
`redline.lastRunGapMinutes`, and files are dated by modification time, which cannot tell your
own saves from the agent's work.

## Prompts you type yourself

Redline does not have to be the one that started the run. Every prompt goes through the
plugin's hooks, so a request you type straight into a Claude Code session — in a VS Code
terminal, in iTerm, in tmux, in any terminal at all — produces the same record of what
changed, and the panel updates the same way.

When the run stops you get **Claude finished — 4 files changed** with a **Review changes**
button, and the panel's figures move with it. `redline.onRunFinished` decides what happens:
`notify` (the default), `reveal` to bring the panel forward with the summary in the status bar,
`open` to go straight to the diff, or `nothing` to leave it to the panel.

This used to depend on Redline finding a session it could *type into*, so a session running
outside VS Code's own terminals was never reported at all — even though the hook had recorded
the whole run. Knowing a run finished and being able to reach it are two different things, and
only sending needs the second one.

Sending still works in that case, from the other direction: Redline stages the batch where the
hook looks and copies one short word — type `redline-review` into your session and the hook
injects the whole review into its context. No pasting kilobytes into a terminal.

## The Claude Code plugin (optional)

Redline works on its own. The plugin makes it exact and quiet:

```sh
claude plugin marketplace add grabowskimr/redline
claude plugin install redline@redline
```

Restart Claude Code. `claude plugin details redline` shows four hooks and **~0 tokens added to
every session** — nothing is added to a turn unless you have staged a batch and typed the
delivery word, which is the one case where the whole point is to put it in front of the model.

**What it buys you**

- **The exact set of files, including new ones.** At `UserPromptSubmit` the hook stages the
  whole working tree into a *throwaway* index and writes the resulting tree object; at `Stop`
  it does the same again. What the run changed is then one command:

  ```sh
  git diff-tree -r -M --name-status <before> <after>
  ```

  About 20 ms, and it reports added, deleted, modified and renamed exactly — no timestamps, no
  separate listing for untracked files, no guessing who wrote what. This is what makes a file
  the run *created* appear, alongside the file whose import it updated.
- **Line-level accuracy.** **Last run** compares each file against the snapshot, not against the
  base commit — so editing line 2 in one run and line 4 in the next shows line 4 alone. Git
  cannot do this on its own: a diff against a base commit is cumulative.
- **A panel that keeps up.** Redline watches the hook's own directory, so figures move about
  half a second after the agent writes a file instead of on a timer.
- **Sending that always lands.** Without the plugin the whole prompt is typed into the
  terminal, and several kilobytes take an unpredictable time to be ingested — which is what
  made Enter unreliable. With it, the prompt is written to disk and a short token is typed;
  the hook injects the feedback into the model's context.

**What it costs.** The hook writes to `~/.claude/redline/<slug>/` and, while a snapshot is
being taken, a scratch index in your temp directory that it removes afterwards. Never into your
repository. It answers immediately and does its work detached, so it adds no measurable time
to a tool call — apart from the two snapshots, which have to be taken at the moment they
describe. A snapshot is about 1.3 s on a 42k-file repository: the repository's own index is
copied to a scratch file first, so git's stat cache does the work, and `GIT_INDEX_FILE` keeps
the staging away from your index and working tree, which are never touched.

The tree and blob objects land in your repository's object store, unreachable, the same way
`git stash create` leaves its own behind — git prunes them on its usual schedule. Redline
creates no refs, branches or commits, and Redline's side never blocks the panel on a snapshot:
it uses the hook's, or takes one in the background and refreshes when it lands.

**Editing `settings.json` by hand still works** and is what earlier versions asked for: point
the four hooks at `plugin/hooks/redline-touched.sh` from a clone of this repository. If you did
that, remove those entries once the plugin is installed, or every hook runs twice — **Redline:
Set Up Claude Code Plugin** checks for exactly that and tells you.

## Notes

- **Kinds** shape how the agent treats a note. The widget has one-click 💬 change request ·
  🐞 bug · 💭 question · 💡 idea · 🔧 refactor; **Set Kind…** lists them all, and so does the
  coloured dot on a card. Prefixes work too: `? why`, `! crash`, `* what if`, `~ typo`,
  `+ nice`.

  | kind | means | the agent is told |
  |---|---|---|
  | 💬 change request | change this as described | do it |
  | 💡 idea | improve / extend this | implement if easy, else sketch and ask |
  | 🐞 bug · 🔒 security · ⚡ perf · 🔧 refactor · ✂️ nit · 📌 todo | flavours of change request | do it |
  | 💭 question | explain before changing | answer first |
  | ✨ praise | this is good | no action |

- **Screenshots**: click **Attach** on a card to pick an image, press ⌘V with a card focused to
  paste one, or **hold ⇧ while dragging** an image file onto a card. The ⇧ is not optional:
  VS Code blocks pointer events over every webview during a drag and lifts the block only
  while Shift is held, so a plain drag never reaches the panel. Images are stored outside
  your repo and passed to the agent as a file path it reads.
- **Anchors are content-based**: notes follow their code when the agent rewrites a file. If
  the code truly disappears the note is kept, flagged ⚠ stale, and its `⋯` offers
  **Re-anchor at the cursor**.
- **The `⋯` on a card** holds what does not earn a place in its row of buttons: attach a
  screenshot, copy the note, mark it done without asking again, delete it — plus re-anchor,
  when a note has lost its lines.
- Notes survive reloads, live in VS Code's per-workspace storage, and never enter your repo.

## Commands

| Command | Key | Where |
|---|---|---|
| Add note | `⌘⏎` in the widget | `+` in the gutter |
| Add Note Here | `⌘R` / `Ctrl+R` | editor menu — opens the widget on the line |
| Add Note at Cursor | `⌘⌥M` / `Ctrl+Alt+M` | palette — types into a prompt instead |
| Send Notes to Claude Code | `⌘⌥S` / `Ctrl+Alt+S` | panel toolbar |
| Review Latest Changes · Review All Changes | — | session card **Last run** / **Everything** |
| Go to Next / Previous Change | `⌥F7` / `⇧⌥F7` | palette |
| Apply Claude's Report · Clear Sent Notes | — | panel |
| Preview Notes · Refresh · Clear All Notes | — | panel toolbar |
| Pin Baseline Here · Clear Pinned Baseline | — | panel `…` menu |
| Choose Claude Code Session… | — | panel `…` menu, session card `⇄` |
| Restore Last Submitted Batch | — | panel `…` menu |
| Do Not Send the Queued Notes | — | session card, beside *N queued* |
| Review a Previous Run | — | palette |
| Set Up Claude Code Plugin | — | palette |
| Show Notes | — | palette |
| Set Kind… | — | widget title, card kind icon |
| Delete Note · Copy Note · Mark Done | — | card `⋯` |
| Re-anchor at Cursor | — | card `⋯`, when a note has lost its lines |
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
| `redline.requestReport` | `true` | Ask for outcomes back — a JSON file with the plugin, `#12 done` lines without it |
| `redline.confirmOnSubmit` | `true` | Confirm before sending |
| `redline.defaultKind` | `comment` | Kind given to new notes |
| `redline.kindPrefixes` | `true` | `? ` `! ` `* ` `~ ` `+ ` set the kind |
| `redline.claudeAutoSubmit` | `true` | Press Enter for you in the session |
| `redline.clearDoneAfterReport` | `false` | Remove notes Claude reported as done, instead of leaving them for a reply |
| `redline.watchSessions` | `true` | Watch the session and offer the diff when a run ends |
| `redline.onRunFinished` | `notify` | When a run ends: `notify`, `reveal` the panel, `open` the diff, or `nothing` |
| `redline.excludeGlobs` | `node_modules`, `dist`, `*.min.*`, `.git` | No `+` in these files |
| `redline.maxFileLines` | `50000` | No `+` in files longer than this |
| `redline.runGutter` | `true` | Mark the last run's changes in the editor gutter |
| `redline.showStatusBar` | `true` | Note and changed-file counts in the status bar |
| `redline.lastRunGapMinutes` | `15` | Idle gap that separates one run's changes from the last |
| `redline.trace` | `errors` | Output-channel verbosity |

Settings you wrote as `localReview.*` before the rename are still read, so nothing breaks if
you don't touch them.

## Appearance

The comment widget is VS Code's own, themed by `editorCommentsWidget.*`, and Redline overrides
none of it — your theme decides. The box you type a note into has a 90-pixel floor set by the
editor itself, so it cannot be made shorter from here.

Tune it in your settings if you want to:

```json
"workbench.colorCustomizations": {
  "editorCommentsWidget.replyInputBackground": "#1e1e1e",
  "editorCommentsWidget.unresolvedBorder": "#d97757",
  "editorCommentsWidget.resolvedBorder": "#00000040",
  "editorCommentsWidget.rangeBackground": "#d9775714"
}
```

## Privacy

No network access of any kind, no telemetry. Git and session information is read locally;
nothing leaves the machine until you paste it yourself.

What is written, and where:

- **Notes** in VS Code's own workspace storage, never in your repository.
- **Screenshots** you attach, in the extension's storage directory — also outside the
  repository, and deleted with the note once it is gone for good, follow-ups' included. A note
  that is only *sent* keeps them: it is still in the archive, and restoring that batch brings
  it back whole.
- **The plugin's state** in `~/.claude/redline/<folder>/`: which files each run touched, the
  snapshots that bound a run, and a batch of feedback while it waits to be collected. The most
  recent round is also kept there once it has been used — the batch you sent (`outbox.sent.md`)
  and Claude's answers about it (`report.json.applied`) — so a round that went wrong can still
  be read. One of each: the next round overwrites them. Delete the directory at any time; it is
  rebuilt on the next run.
- **Snapshot objects** in your repository's own object store, unreachable, exactly as
  `git stash create` leaves its own. Redline creates no refs, branches or commits, and never
  writes to your index or working tree. Git prunes them on its usual schedule.

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

**[`docs/`](docs/) is written for whoever changes this next** — what the parts are, what a note
is, how the panel and the plugin work, which test suite to reach for, where a new file goes,
and a page of decisions that look wrong until you know why. Start with
[`docs/architecture.md`](docs/architecture.md).
