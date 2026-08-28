# Changelog

## 1.5.1 — 2026-08-28

- Screenshots are a row each now — thumbnail, name, and what they are attached to — rather than
  a strip of thumbnails. After the fact you recognise a capture by its name, not by 46 pixels
  of it.
- A screenshot attached to a follow-up sits **with the follow-up**, captioned as one, instead
  of with the note. Both are just paths, so which turn one belongs to is recorded when it is
  attached — there is no way back to it afterwards.
- **Attach** sits beside *Send to Claude* on a card that has not gone yet, and the follow-up box
  has a paperclip of its own.
- Fixed while adding it: removing a screenshot filtered the paths and not the turns beside them,
  which would have shifted every later attachment onto the wrong caption.

## 1.5.0 — 2026-08-28

**The cards are redesigned.** One column, no file headers — the cards come from all over a
change, so a header was usually one card each. Every card names its own file and line instead,
in mono, never truncated.

A card reads top to bottom: what state it is in and where it is · the lines it was written
about, numbered from where they actually are · what you asked for · what Claude said, under a
dashed rule · a box for the next thing you want · the answer, in one row of buttons.

Four states, each with its own edge colour and its own set of actions:

- **Drafting** — nothing has happened yet. One button: *Send to Claude*.
- **Needs approval** — Claude changed something and nobody has agreed with it. Its words, a box
  to ask for another attempt, and *Approve* · *Not this* · *Reply*.
- **Rejected** — you turned that change down. Its answer stays, dimmed, with your reason
  beneath it and *Claude is working on it…* where the buttons were.
- **Done** — the snippet and one line about it. The exchange is folded away, not dropped:
  clicking opens it.

Kinds are shown as their own coloured codicon, no label and no emoji — ten of them are told
apart by colour long before anyone reads a word, and the name is in the tooltip.

Rejecting is now recorded rather than inferred. "There is a follow-up after its answer" is also
what asking a further question looks like, and the two want different cards.

Delete, copy, attach and reopen moved into the card's overflow: three buttons is the tightest
row that fits a 420px panel, and a fourth would wrap — a wrapped verb stops reading as a button.

## 1.4.0 — 2026-08-28

- **Sessions come from Claude Code itself.** `claude agents --json` lists every session with its
  directory, its real id and what it is doing. Redline worked this out from the process table
  instead — one `ps` plus an `lsof` per Claude process — which cost about a third of a second per
  lookup, could not see background agents, returned nothing at all on Windows, and never yielded
  a session id: that had to be inferred from which transcript was modified most recently, which
  is what put a reply in the wrong session when two were open. The old path is kept for a CLI
  too old to have the subcommand.
- **Outcomes arrive as a file, not as prose.** The prompt names a path and asks for JSON; Redline
  reads that and falls back to scanning the reply for `#12 done` lines only when there is none.
  A model that writes `#12 — done`, or puts the line in a code fence, or covers three notes in
  one sentence defeats any parser — which is what produced "0 of 3 addressed" with all three
  addressed. The file is consumed on read, so a later round cannot inherit it.
- **A note waits for your approval.** Claude reporting one as finished is a claim about the code,
  not a verdict on it, so the note no longer closes itself: it moves to **waiting for approval**,
  keeps its before and after on the card, and offers two buttons that need no typing — 👍 closes
  it, 👎 reopens it with the follow-up box open. `redline.clearDoneAfterReport` now clears notes
  *you* approved rather than ones Claude declared finished.
- **The last run's changes show in the gutter**, beside the git extension's marks against HEAD.
  Those answer "what is uncommitted", which in a worktree an agent has worked in for an hour is
  nearly everything; these answer "what did the last run change in this file". Off with
  `redline.runGutter`.
- **The panel says what the session is working on** — the file it is writing and how many it has
  touched — read from the plugin's own record rather than from the session. A silent minute and a
  hung one look the same otherwise, and the terminal that would show this is often not the window
  you are looking at.
- **Sending while Claude is mid-turn offers to wait.** Notes dropped into the middle of a turn are
  as likely to be ignored as read; queued ones go the moment the run ends, which the hook already
  reports.

## 1.3.1 — 2026-08-28

- **Follow-up** sits next to **Send** in the widget toolbar, in that order: you write the
  follow-up, then you send it.
- Fixed: clicking it drew a *second* "Follow-up…" bar beside the first. Opening the box went
  through the same refresh the rest of the extension uses, which reassigns the thread's comment
  array — VS Code rebuilds the reply widget from that without disposing the old one. It also
  re-opened the document, which can re-enter thread creation and leave two widgets on one note.
  Neither was needed: the widget is on screen already, because its own toolbar was just clicked.
- The box now lands **ready to type** instead of as a bar you click first.

## 1.3.0 — 2026-08-28

- The follow-up box no longer sits under every note in the editor widget. It was there whether
  or not anything was being written in it, below a card that already carries the note, Claude's
  answer and a row of actions — so the widget stopped being readable at a glance. **Follow-up**
  is now a button on the widget's own toolbar: it opens the box, expands the thread and puts
  the cursor in it.
- The box stays open across store changes, which happen constantly while you are typing in it,
  and closes on cancel or once the turn is recorded.

## 1.2.0 — 2026-08-28

Ten improvements, four of them to how much work the extension does when nothing is happening.

**Interface**

- The diff says what happened to each file. An added file's empty side is labelled *(new file)*
  and a deleted one's *(deleted)*, which the multi-file editor shows above each entry — a
  deletion used to read exactly like an edit until you opened it. The title carries the
  breakdown too: *3 files (1 new, 1 deleted, 1 edited)*.
- **Last changed nothing** is no longer a dead end: when the run changed nothing but the
  working tree has changes, it offers them.
- **Redline: Review a Previous Run** diffs a run that has already finished. The plugin
  remembers the last five, both ends of each, so sending a follow-up no longer puts the run you
  were reading out of reach.
- Notes filter by state — *waiting*, *answered*, *done* — as chips above the list, appearing
  only once there are enough notes to lose something in.
- A note whose file has been **deleted** says so and stops offering to open it. A note whose
  lines have **moved out from under it** is marked as well: that state was computed and sent to
  the panel all along, and then never drawn.
- `redline.onRunFinished` gains **`reveal`**: bring the panel forward and put the summary in the
  status bar, without a notification or taking over the editor.

**Performance**

- The panel no longer rebuilds its markup when nothing it shows has changed. Every store change
  redrew everything — including changes that touch none of it — which dropped the scroll
  position and any selection, and is what made it flicker while Claude worked. Scroll position
  survives a real redraw now too.
- Resolving the base ran a `git` spawn and a transcript read one after the other when neither
  needed the other; same for the published floor and HEAD.
- Several answers come out of the same tail of a transcript, and each was opening and reading
  the file again. They share one read now — they memoize on size and mtime, which is exactly
  what changes on every write while a session is running, so during a run they all missed
  together.
- A pinned baseline dated its pre-existing untracked files one `stat` at a time in a loop.
- Requires plugin **0.3.0**: `claude plugin update redline`.

## 1.1.1 — 2026-08-28

Three bugs in yesterday's second-round sending, all of them only reachable because a batch can
now mix new notes with replies.

- Fixed: **Undo after sending a second round dropped the answered notes out of the sent
  section.** Undo cleared `sent` outright, which was right while a batch could only hold notes
  that had never been sent — but a note carrying a follow-up already had a record worth
  keeping: its outcome, the session it is talking to, and how far its thread had got. Undo now
  restores what was there.
- Fixed: **Preview showed an empty batch when only follow-ups were waiting.** The button became
  visible for that case but the preview still rendered open notes only.
- Fixed: **a mixed batch shipped its conversations with nothing to explain them.** The sentence
  telling Claude that the `↳` lines under a note are the exchange so far was tied to *every*
  note being a follow-up, so a round of two new notes and three replies sent the threads
  unannounced.

## 1.1.0 — 2026-08-28

**A second round can be sent in one go.** Sending a batch, reading the answers and replying to
several notes is the ordinary way this gets used — and there was no way to send that second
round at once. The batch send is gated on having notes *waiting to go*, and once a round has
been sent nothing is waiting, so the button disappeared. Replies could only be sent one card at
a time.

- The **send** button returns as soon as any follow-up is written, and sends every one of them
  in a single message alongside any new notes.
- The *Sent to Claude* section grows a **send N follow-ups** button next to *clear sent*, which
  is where those replies were written.
- Each follow-up carries its whole thread — the note, Claude's answer, your reply — so it
  arrives knowing what it is replying to.
- The batch goes to the session the conversation already lives in, with no chooser, unless the
  notes span two sessions or that session is gone.
- Sending a second round no longer archives the notes it is replying to. `clearSent` sweeps the
  previous round into the archive, and a note carrying a follow-up is *in* that round — so this
  would have deleted the very thing the reply was attached to.

## 1.0.1 — 2026-08-28

- Fixed: a file the run put *back* to its committed state was missing from **Last**. Asking
  Claude to remove a comment you had added but not committed leaves the file identical to the
  base commit — so it differs from nothing there, and a filter that required every file in
  **Last** to also appear in **All** dropped it. Three changes were reported as two.

  The filter was protecting an invariant that is not real. The two scopes answer different
  questions and neither contains the other:

  - **All** — what differs from the base commit.
  - **Last** — what this run changed.

  A file restored to its committed state belongs in the second and not the first, and it is
  precisely what a review that asked for a removal produces. The same now holds for a file
  that was untracked before the run and deleted by it. "N more changed files" counts what the
  run did not touch, rather than subtracting two counts that no longer overlap.

## 1.0.0 — 2026-08-27

A pass over the whole extension for a public release. Nine findings, in the order they would
bite someone.

**A path git had to escape was the wrong path.** `core.quotePath=false` stops git escaping
non-ASCII, which is why `café.ts` worked — but a name containing a double quote, a backslash or
a control character is *still* returned quoted: `"quote\"double.ts"`. Every listing took that
literally, so the file appeared under a name that does not exist and every stat, diff side and
hunk for it failed. Every listing now asks for `-z` (NUL-separated, no quoting at all), and
patch headers — which cannot be asked for `-z` — are unquoted, octal escapes included.

**Git ran in workspaces the user had not trusted.** A repository defines its own configuration,
`.gitattributes` filters and `core.fsmonitor`, all of which git executes. The manifest claimed
full support for untrusted workspaces, so opening a hostile repository was enough to run its
code. Support is now declared `limited` and nothing that reads a repository runs until the
folder is trusted; it starts the moment you trust it, with no reload.

**A folder that is not a repository cost a `git` spawn per call, forever.** The negative answer
was never cached, and the workspace-wide watcher keeps asking for as long as anything writes
files.

- Fixed: in a multi-root workspace, only the first folder was ever examined — if the repository
  was the second one, the whole feature was dead with no explanation. Every folder is tried, and
  the README says plainly that one repository per window is the limit.
- Fixed: session discovery ran `ps`, and an `lsof` per Claude process, on every panel update —
  which meant on every keystroke-sized change to a note. Cached for five seconds and coalesced.
- Fixed: two Claude Code sessions in one worktree overwrite each other's run markers. Each end
  of a run now records its session, and a mismatched pair falls back to the wider answer instead
  of reporting a run assembled from both.
- Fixed: the diff editor's snapshot provider trusted the repository path in its own URI. It now
  serves only this workspace's repository, and only a revision shaped like one.
- Fixed: `~/.claude`-driven work started from a file watcher had nowhere to report a failure, so
  a rejection surfaced as a bare extension error. Logged with context instead.
- Packaging: dev scripts and any stray build directory are excluded — one scratch directory of
  compiled tests came within a command of being published. A check now refuses to package if
  the two copies of the hook script have drifted apart.
- Metadata: the repository URL pointed at a repository that does not exist, the categories
  claimed "Notebooks", and there was no issues or homepage link.
- Verified against a repository built to be awkward: no commits at all, detached HEAD, a
  dangling symlink, a file replaced by a directory, a case-only rename on a case-insensitive
  volume, a submodule, an unreadable file, and names containing quotes, backslashes, tabs,
  newlines, spaces and leading dashes.
- Requires plugin **0.2.2**: `claude plugin update redline`.

## 0.5.0 — 2026-08-27

**Runs you start yourself now show up.** A prompt typed straight into a Claude Code session —
in a VS Code terminal, in iTerm, in tmux, anywhere — goes through the same hooks as one Redline
sent, so the record of what changed is identical. What was missing was the reaction: reporting
a finished run was gated on `resolveTarget`, which only returns a session Redline can *type
into*. A session in an external terminal resolved to nothing, so `onDidEndRun` did nothing at
all, and the run went unreported even though the hook had already written the trees.

Knowing that a run finished and being able to reach it are two different things. Only sending
needs the second one.

- The hook's stop marker is now read directly: it carries the run's timestamp and the session
  id, so a finished run is reported whether or not there is a process to point at — even if the
  session has since exited.
- The run is identified by that timestamp instead of by a time window. The hook keeps state for
  every repository under one directory, so a run finishing in another worktree signalled here
  too and could be announced as this repository's; now a marker that is not ours is simply not
  ours. This also replaces the guesswork that was suppressing duplicate notifications.
- Claude's answer is read from the session the hook *names*, rather than from the
  most-recently-modified transcript in the folder. With two sessions open, that was a guess,
  and the wrong one attributes another session's reply to this run.
- New `redline.onRunFinished`: `notify` (default), `open` to go straight to the last run's diff,
  or `nothing` to leave it to the panel.
- Sending to a session outside VS Code works from the other direction: with no terminal to type
  into, the batch is staged where the hook looks and the delivery word goes on the clipboard —
  type `redline-review` in your session and the hook injects the whole review. Previously this
  case fell back to pasting several kilobytes by hand.
- The panel's session strip names a session it can see but not reach, instead of looking
  disconnected while tracking the run perfectly well.
- No plugin change: this needs 0.2.1, which you already have.

## 0.4.2 — 2026-08-27

A review of 0.4.0, which found six things. Two of them made snapshots fail outright, and both
failed silently, which is how they got through.

- Fixed: a snapshot was abandoned whenever any file could not be staged. `git add --ignore-errors`
  continues past a file it cannot read but **still exits non-zero**, and a file vanishing between
  being listed and being read is routine while an agent moves things around — so the mechanism
  gave up exactly when the tree was changing fastest. The tree is written from whatever did
  stage.
- Fixed: two snapshots at once fought over one scratch index — `Another git process seems to be
  running in this repository` — which hit two windows on one repository, and a background refresh
  beside any other caller. The scratch index is unique per call now, which costs nothing: the
  repository's own index is copied over it every time anyway.
- Fixed: scratch indexes were never deleted. Six to seven megabytes each, forty of them (40 MB)
  after a day of testing. Each snapshot now removes its own, and a window sweeps any left behind
  by a process that was killed mid-snapshot.
- Fixed: a failed snapshot said nothing at all, so a mechanism that never worked was
  indistinguishable from a working tree that never changed. The reason git gave is logged.
- Fixed: images and other binary files were served as text on the snapshot side of a diff, which
  renders as mangled UTF-8. Binary paths are taken from git's own `--numstat` judgement and
  compared the way they were before snapshots existed.
- Fixed: a snapshot that could no longer be trusted was served indefinitely. A tree nothing has
  changed since is exact however old it is — which is what keeps an **idle window from
  snapshotting at all**, now asserted in the tests: `snapshots: 0 while idle, 1 after a write`.
  But once the tree is known to have moved on, a snapshot is only served for a minute before
  falling back to signals that correct themselves. Snapshot calls are also bounded by a timeout,
  so a `git` that never returns cannot leave one permanently in flight.
- Measured, inside the extension host on a 42k-file monorepo: 4871 ms cold, **1956 ms warm**,
  38 ms to compare two trees. From a shell, 1.3 s. It is never blocked on.

## 0.4.1 — 2026-08-27

- Fixed: the Claude Code plugin failed to load. Its manifest pointed at
  `./hooks/hooks.json`, which current Claude Code loads on its own — declaring it as well is
  a duplicate and the whole plugin is rejected: `claude plugin list` showed
  `✘ failed to load` while `install`, `update` and `details` all reported success. Requires
  plugin **0.2.1**.
- **Redline: Set Up Claude Code Plugin** now checks whether Claude Code could actually load
  the plugin, not just whether it is installed, and repeats the reason it gave. An installed
  plugin whose hooks never run looks exactly like a working one with nothing to report.

## 0.4.0 — 2026-08-27

**"The last run" is now a comparison between two snapshots of the working tree.** It used to
be four signals stitched together — `git diff` for tracked files, a separate
`ls-files --others` walk for new ones, modification times to date them, and a directory of
copied files to compare against. Each had a hole, and the holes showed: two files created in
one run where only one appeared, the file whose imports were updated missing entirely.

The largest hole was the untracked walk. It takes about a second in a large repository, so it
was never blocked on — which meant a file created seconds ago was simply absent from the list
until some later refresh happened to catch it. Nothing downstream could recover a file that
was never a candidate.

With the plugin installed, the hook now stages the whole working tree into a throwaway index
at `UserPromptSubmit` and again at `Stop`, and writes the resulting tree object each time. The
answer is then one command — `git diff-tree -r -M --name-status <before> <after>`, about 20 ms
— covering added, deleted, modified and renamed files exactly, with no timestamps and no
second listing. Your index and working tree are untouched: the repository's own index is
copied to a scratch file and `GIT_INDEX_FILE` points the staging at that.

- Fixed: files a run created now appear in **Last**, both of them, together with the file
  whose import changed because of them.
- Fixed: a file created in an *earlier* run no longer shows up as this run's work, and no
  longer has to be dated by its modification time to be excluded.
- Fixed: **Last** compares each file against the snapshot the run started from, so an edit
  from a previous run in the same file no longer appears in this run's diff.
- Fixed: deletions and renames carry their status through to the diff, so a rename reads as a
  move rather than as an unrelated addition and deletion.
- The panel never waits on a snapshot: it uses the hook's, or takes one in the background and
  refreshes when it lands. Measured 1.3 s from a shell and up to 5 s inside a busy extension
  host on a 42k-file repository — far too long to hold a refresh for.
- Faster where it matters: the first summary after a finished run is two `diff-tree` calls
  against snapshots the hook already wrote, and needs neither the untracked walk (823-1203 ms
  here) nor a `stat` per changed file.
- The hook no longer keeps a directory of copied files as the run's "before" — a tree object
  does that now. Existing copies are removed at the end of the next run.
- Requires plugin **0.2.1**: `claude plugin update redline`.

## 0.3.2 — 2026-08-27

- Fixed: the changes view was unreadable — one file's header repeated down the page over
  slivers of content. `vscode.changes` does accept an absent resource for a side that does not
  exist (verified against the command's own implementation), but the multi-file editor lays that
  out badly. Both sides are always real documents now: an added file compares against an empty
  one, a deleted file compares to an empty one, and a committed rename uses the path it came
  from. The empty side is served read-only under its own scheme.
- Fixed: files created in earlier runs were listed under the last run. Treating every untracked
  file as current put files from days ago at the top and buried the two or three things that had
  just changed. New files are dated like everything else; **All** still shows everything
  unreviewed.

## 0.3.1 — 2026-08-27

- Fixed: a file created during a run had no visible changes in the diff. It was in the change
  list, but the multi-file editor was handed a git URI at the base ref for a path that does not
  exist there, so the left side could not resolve and the entry did not render — the same shape
  of bug as a deleted file being given a missing path on the right. Which sides a comparison has
  now comes from `git diff --name-status`: an addition has no left side, a deletion no right
  side, and a committed rename takes the path it came from as its left.

## 0.3.0 — 2026-08-27

First build shared outside this machine. Everything below shipped together; 0.2.0 was never
distributed.

- Fixed: prompts sent to an Orca terminal no longer carry `<ESC>[200~` at the head. Orca's
  `terminal send --text` types into the agent's input box, where newlines stay newlines and
  only `--enter` submits, so the bracketed-paste wrapper was never needed there. It is kept
  for a VS Code integrated terminal, where a newline really is Enter.
- Fixed: **Last accumulated every request instead of showing the newest.** A run was cut on a
  15-minute idle gap, so three requests a few minutes apart were one run and each review
  included all the earlier ones. The boundary is now the user's own last request, read from
  the transcript — tool results are recorded as user turns too, and are excluded.
- Fixed: **changed-file counts appeared five to ten seconds late.** The resolved base, which
  carries the run boundary, was cached for 30 seconds (plus 15 for session lookup and a
  30-second poll). Those are now 4 and 3 seconds with an 8-second poll, made affordable by
  memoizing the transcript readers on file size and mtime — an unchanged session costs one
  `stat` instead of re-reading megabytes.
- Changed: a settled note (done, or reported on by Claude) collapses to a compact card —
  code, screenshots and follow-ups hidden — with **✕** in the footer instead of buried in
  `⋯`. Removing a note now offers Undo, since one click is all it takes.
- Changed: **the panel is told when something changed instead of asking.** Redline watches the
  hook's own log directory, so a change registers within about half a second of the agent
  writing a file, and the end of a run is signalled by a `Stop` hook rather than detected by
  polling an Orca terminal — which also means run-end now works in a plain terminal. The
  backstop poll went from 8s back to 30s.
- Fixed: the panel showed a scrollbar with a single card on it. The document was forced to
  `height: 100%` of a container that already sizes the webview, so it overflowed by whatever
  the body's own padding added. The content decides the height now, and long unbreakable text
  stays inside the block that holds it rather than scrolling the panel sideways.
- Fixed: a file Claude deleted did not appear in the diff. It was in the change list all
  along — the multi-file diff was handed the missing path as the *right* side of the
  comparison, which it cannot open, so the entry did not render. A deleted file now has no
  right-hand side, which is how a deletion is shown.
- Changed: a done card is **marked, not faded**. It carries Claude's account of what it
  changed, so dimming it to 55% opacity made the most useful text on the card the hardest to
  read. A green left spine and a green status say settled instead.
- Changed: every action and status in the panel uses a codicon rather than an emoji — the same
  icon set the kinds and the editor itself use. Emoji sit on their own baseline and render
  differently on every platform, which is why the row never quite lined up.
- Fixed: **a file Claude created did not appear in the last changes.** New files were dated
  against the newest run, so submitting another prompt after one was created — a reply, say —
  moved the boundary past it and it vanished. Measured on a real worktree: the file was written
  at 09:14:16 and the run began at 09:16:46. A file git has never tracked is now always part of
  the review, whichever run wrote it, because it exists in no base and so nothing about it has
  been read yet.
- Fixed: **pressing done did nothing when a follow-up had been typed but not sent.** The card
  cannot collapse while a turn is owed, so a note where you had typed "ok" stayed light,
  went on reading "follow-up not sent", and only swapped its icon. Deciding you are finished
  is exactly when an unsent turn stops mattering: marking done now settles the conversation.
  The turn stays in the thread, and writing a new one reopens it.
- Changed: a note you marked done reads **✅ done**, whatever Claude reported about it. Your
  decision outranks its verdict — previously an answered question showed "not addressed yet"
  after you had marked it done.
- Changed: **Claude's answers are readable now.** The panel showed them as raw text, so a
  markdown link appeared as its label *followed by* its whole path, and a repository path has
  no spaces to wrap at — it pushed the card sideways. Links render as one short reference that
  opens the file (and jumps to the line), backticked code renders as code, and the speaker is a
  label rather than two words buried in the sentence. The text is escaped before any of that,
  so markup inside it stays text.
- Changed: the report asks for **one sentence** per note, and for code to be pointed at as
  `[file.ts:12](path)`. The panel is narrow; three paragraphs there are worse than one line.
- Fixed: **every finished note said "follow-up not sent" when you had written none.** Claude's
  report is stored as a turn in the note's conversation, and the check for an unsent follow-up
  counted every turn added since the send — including the agent's own. So applying a report
  left each note permanently live, offering to send nothing. Only your turns count now.
- Fixed: a note already marked done still offered **✓ mark done**, so clicking it quietly undid
  the state instead. It offers **↺ reopen** there, as the collapsed card already did.
- Fixed: two "Claude finished" notifications could still appear. The guards were about *which
  channel* spoke, and covered the two known reporters; the last line of defence is now about the
  *message* — the same summary twice in quick succession is one run, whatever produced it. Each
  report is also logged with the channel that raised it, so a recurrence names its own cause.
- Changed: Claude is asked to say what it actually did in every report line — `#3 done — moved
  applyDiscount above the return` — and whatever it says becomes its turn in the note's
  conversation. Previously only an answer to a question was kept, so a completed change left a
  bare "done" beside code that had changed, with nothing to read.
- Changed: the box on a note is called a **follow-up** everywhere. It is always present now,
  on a note Claude has answered and on one it has never seen, and one box should not change its
  name depending on what has happened to the note.
- Fixed: the reply box could not be closed. Escape was bound, but only while the editor inside
  the box had focus — click the bar by accident, click elsewhere, and it stayed open with no
  way out. It now has a **Cancel** button, and cancelling closes only the note it belongs to
  rather than every open reply in the file.
- Fixed: a screenshot attached to a reply could not be removed. The remove control was keyed
  on the note having been sent, so any note that had ever been sent kept its images for good —
  including one just added to an unsent reply. It now appears exactly when attaching does.
- Changed: the comment widget's reply bar takes the widget's own background instead of a stark
  block, via a transparent `editorCommentsWidget.replyInputBackground` default. The README
  lists the other `editorCommentsWidget.*` colours worth tuning.
- Fixed: **the reply box had no submit action.** The only command bound to it was gated on the
  thread being *empty*, so on a note that already existed nothing was bound at all — typing and
  pressing ⌘⏎ did nothing, with no error to go on. A reply command is now bound for a thread
  that has a note, and the original stays for a new one.
- Changed: the collapsed reply bar says "Reply…" rather than a sentence. VS Code renders that
  label full width and in bold, where a long one reads as a heading instead of an invitation.
- Fixed: **the comment widget had no reply box.** `canReply` was off — correct while replying
  created a second note on the same line, wrong once it adds a turn — so the only route to a
  reply was the `⋯` menu, where nobody would find it. The widget now has a reply field, and a
  note with an unsent reply no longer takes the resolved styling.
- Fixed: a card replied to from the widget kept the dimmed "done" look. The dimming means
  "nothing to do here", and a reply waiting to be sent is something to do.
- Added: a note sent to Claude shows **waiting for Claude** with a spinner until it reports
  back, and the session strip shows the agent as working from the hook's own markers — so it
  works in a plain terminal, where the Orca idle monitor sees nothing.
- Removed: **⇩ apply report** from the panel. The report is applied automatically when a run
  ends, so the button did nothing that had not already happened. **✓ clear sent** stays.
- Removed: **✍ revise** from cards. It was a reply by another name; the ↳ reply action does the
  same thing and is now the only one.
- Fixed: the "Claude finished" notification appeared twice, a few seconds apart. Two channels
  report a finish, and the Orca idle monitor confirms one about ten seconds after the agent
  goes idle — landing exactly on the ten-second guard meant to stop this. Widening the guard
  would only move the seam, so while the plugin is reporting finishes the monitor's
  notification is dropped: the hook fires instantly and works in any terminal, the monitor
  polls and only works in Orca.
- Fixed: **a reply went to whichever session happened to be preferred, not the one holding the
  conversation.** Sending a single note ignored the session it had already been sent to, so with
  two sessions open it asked every time — and could drop a reply into a session that had never
  seen the note or Claude's answer. A note now goes back to its own session, and a chooser only
  appears when that session is gone.
- Changed: "follow-up" now only means adding to a note *before* Claude has said anything. Once
  it has answered, the same act is a **reply** — the widget, the card and the command all say so,
  and the comment widget shows who said what (**You:** / **Claude:**) instead of a list of arrows.
- Fixed: the delivery token had to merely *appear* in a prompt to hand over a batch, so asking
  Claude about Redline could silently consume a pending review. It must now be the whole prompt,
  and the batch is renamed rather than deleted so it survives anything going wrong mid-handover.
- Added: **a real Claude Code plugin.** `claude plugin marketplace add <repo>` then
  `claude plugin install redline@redline` replaces copying two scripts into `~/.claude` and
  merging four hook blocks into `settings.json`. Hook commands resolve through
  `$CLAUDE_PLUGIN_ROOT`, so an extension update can no longer break the paths. Verified with
  `claude plugin validate`, installed, and confirmed by `claude plugin details`: four hooks,
  ~0 tokens added to a session.
- Added: **sending through the plugin instead of the terminal.** When the plugin is present the
  batch is written to disk and a short token is typed; the `UserPromptSubmit` hook injects it
  into the model's context. Only eight characters have to survive being typed, which removes
  the size-dependent failure where a two-note batch landed in the input and never submitted.
  Without the plugin, the prompt is typed as before.
- Added: **Set Up Claude Code Plugin** warns when the plugin *and* hand-written hooks are both
  present — every hook would fire twice, and two run-start snapshots race each other.
- Changed: a reply is never sent automatically. It is recorded, the note goes live again and
  shows **✎ reply not sent** in both the panel and the comment widget, and **➤** sends it — so
  a screenshot can be attached to the reply before it goes.
- Fixed: a follow-up added in the editor's comment widget left the card looking settled and
  disabled. A note tracks how much of the conversation the agent has actually seen, so anything
  written since the last send reopens it.
- Fixed: 📎 was missing from a card that had already been sent, which made attaching an image to
  a reply impossible. The action row now offers reply and attach whenever something is still
  going to be sent.
- Added: **conversations on a note.** Replying in a note's comment widget no longer creates a
  second note on the same line — it adds a turn and sends the whole exchange back to Claude, so
  you can correct an answer or a change and keep going. Settled cards gain a ↳ reply action, and
  a batch where every note has already been through a round is framed as a continuation rather
  than a fresh review.
- Changed: `redline.clearDoneAfterReport` now defaults to **off**. A note Claude finished stays
  on its line so you can reply to what it did; set it to `true` to get the old auto-clear back.
- Fixed: a sent prompt still sometimes sat in the input without running. Enter was pressed
  after a fixed pause, but how long the agent takes to ingest a prompt depends on its size and
  on what it is doing. Redline now waits for the interface to go quiet (`terminal wait --for
  tui-idle`) and then presses Enter — verified end to end with a 540-character, 22-line prompt,
  which settled in 264ms and submitted intact. A VS Code integrated terminal, which cannot
  report idleness, gets a longer pause and a separate Enter.
- Fixed: the first `⌥F7` took ~2.6s. `hunks()` was calling `ls-files --others` directly — the
  one call site the cached listing had missed — so it paid the full working-tree walk. Now
  165-204ms. New files are also counted in parallel, and one over 2 MB is not read just to
  count its lines.
- Fixed: navigating changes threw when a hunk named a file that no longer exists — a deletion,
  or anything removed since the diff was taken. It now steps past missing files.
- Added: `npm run test:real` — an opt-in integration run against a real repository
  (`REDLINE_TEST_WORKSPACE=…`). It runs *without* `--disable-extensions`, which the default
  suite needs but which also disables the built-in git extension. It caught the bug below on
  its first run.
- Fixed: **untracked files were reported as none.** They were taken from the git extension's
  state, which populates asynchronously — `getRepository` returns null and every change array
  is empty for a while after startup, so "not scanned yet" was indistinguishable from "there
  are none". They come from git again, but the listing is reused until a file is created or
  deleted (editing one cannot change it) and refreshed off the hot path.
- Fixed: the first change summary took ~2.9s on a 42k-file repository, now ~0.7s. Nothing
  waits on the untracked walk any more; the known list is served and the panel re-renders when
  the walk lands.
- Fixed: every hook signal re-resolved the base, re-reading a transcript the running session is
  actively appending to (270-600ms each). A file being edited does not move the run boundary —
  only a new request does, which the hook now signals separately.
- Added: a recomputation slower than 500ms logs its own breakdown (base / files / run), so
  "the panel feels slow" comes with evidence.
- Fixed: session detection ran `ps` and the Orca CLI every 60s forever — ~345ms each time —
  even in a window where Claude is never used. It now backs off to five minutes while nothing
  is found, and a hook signal (the agent is demonstrably working) resets it to an immediate
  look, so nothing is slower to attach.
- Added: activation time is measured and asserted (<1.5s) by an integration test, alongside a
  check that the activation event stays `onStartupFinished` — off VS Code's startup path.
  Measured at 21-25ms.
- Fixed: `⌥F7` / `⇧⌥F7` walked lines from earlier runs. Hunks were computed against the base
  commit while the file list and the diff used the run-start snapshot, so navigation disagreed
  with what the panel showed. Files the snapshot covers now have their hunks computed from it.
- Fixed: every change event ran the git work twice — the panel strip and the status bar both
  ask for the summary synchronously, and neither saw the other's cache. Concurrent requests
  now share one computation.
- Changed: the snapshot manifest and the per-file content comparisons are cached on size and
  mtime, so a recomputation no longer re-reads ~1.6 MB.
- Fixed: a snapshot older than the run it describes is now ignored rather than trusted. That
  state means the hook did not record the request, and believing it reports the previous run's
  edits as this one's — the exact failure the snapshot exists to prevent.
- Fixed: the panel could ask the extension to open any path on disk. `openAttachment` now only
  opens a path some note actually holds, matching the rule `removeAttachment` already applied.
- Fixed: the run-start snapshot cost **1.2-1.7s per prompt**; it is now ~150ms. Almost all of
  it was `git ls-files --others`, which walks the entire working tree applying gitignore —
  823-1203ms to find three untracked files in a 42k-file repo. The snapshot lists tracked
  files only and anything without an entry is dated against the run's start.
- Fixed: that same listing ran on **every** change recomputation. Untracked files now come
  from the git extension's own state, which already maintains them, with the `ls-files` walk
  kept only as a fallback (no API, or `git.untrackedChanges` set to hidden).
- Changed: the comment widget's toolbar went from twelve buttons to eight — change request,
  bug, question, idea and refactor inline, every other kind behind **Set Kind…**, and two that
  were missing: send this note to Claude, and remove it. Add Follow-up moved to the comment's
  own actions.
- Fixed: sending sometimes pasted the prompt without running it. Enter was appended to the
  same Orca call as the text; it now goes as its own keystroke a moment later, once the agent's
  input has taken the prompt in.
- Changed: a note Claude reports as done is cleared automatically (`redline.clearDoneAfterReport`,
  on by default), with Undo on the notification. Skipped notes and answered questions stay.
- Fixed: the hook keyed its state by the agent's working directory, which is often a
  subdirectory of the repository. That scattered the log and the snapshots across a directory
  per subdirectory — so the newest snapshot was frequently an empty one written from deep in
  the tree, while Redline read an older one from the root. It also broke the snapshot copies
  outright, because `git diff` prints paths relative to the repository root and they were being
  joined onto a subdirectory. Everything is keyed by the repository root now.
- Fixed: **Last showed earlier edits to the same file.** Two changes to one file in different
  runs both appeared as the newest run's work. Git cannot tell them apart — an uncommitted diff
  against a base commit is cumulative — so the hook now copies every already-modified file at
  `UserPromptSubmit` and **Last** diffs against that, giving line-level accuracy. Requires the
  new `UserPromptSubmit` hook entry; without it the old file-level behaviour stands.
- Changed: **Claude's report is applied automatically when a run ends.** Notes are marked
  ✅ / ⛔ / 💬 without visiting **Apply Claude's Report**, which existed only because nothing
  could tell when a run was over.
- Fixed: several notifications for one finished run. The hook wrote its end-of-run marker on
  `SubagentStop` as well as `Stop` (once per subagent), a single write can arrive as both a
  create and a change, and the hook signal and the Orca idle monitor both notice the same
  finish. All channels now funnel through one reporter with a quiet window.
- Fixed: opening a diff was slower than it needed to be. Each `git` spawn costs ~0.18s of real
  work against a 42k-file index, so the fix was fewer of them: the published floor (up to four
  `merge-base` calls) and HEAD are cached, the remaining reads run concurrently, and clicking
  **Last** or **All** reuses a summary the hook has just refreshed instead of forcing a rebuild.
- Fixed: the hook's installation check reported "no Node could be found" for a working hook.
  Detaching the work meant the check was looking for the log before it had been written. It
  now runs the hook inline (`REDLINE_HOOK_SYNC`) and only blames Node when the hook says so.
- Changed: **the hook no longer makes Claude wait.** It answers immediately and hands the work
  to a detached child; measured inline cost was 80-120ms per edit and 210-350ms per `Bash`
  call. Log trimming and marker sweeping moved to the end of a run, where nothing is waiting.
- Fixed: under continuous file churn (an agent writing, or a build) the whole change summary
  recomputed every 800ms — four to six `git` spawns plus a `stat` per changed file, against a
  42k-file repo. There is now a 1.2s floor between recomputations; a user-initiated Refresh or
  diff still forces a fresh one.
- Fixed: a settled card hid its addenda, which is where Claude's answer to a question is
  kept — the one thing the round produced.
- Fixed: clicking a note's text replaced it with a spinner (the body carries a `data-act`, and
  only buttons should spin).
- Fixed: an empty hook log was trusted as "the agent changed nothing", so a hook that was
  installed but not firing reported no changes at all. Attribution is now only trusted when
  it says something; otherwise the file-time rule stands in.
- Fixed: the hook log grew without bound. It is trimmed to its newest 2 MB once it passes
  8 MB, on a line boundary, and stale per-session Bash markers are swept after a day.
- Fixed: `orca terminal wait` blocks for up to five minutes and was not killed on dispose, so
  a window reload left the process running.
- Fixed: gutter decoration types were never disposed, and the hook log and agent working
  directories were re-read and accumulated without limit.
- Added: loading feedback. The clicked button spins straight away — finding the Claude
  session shells out to `ps` and the Orca CLI, so there was a second or two where the panel
  looked frozen — and a status-bar spinner names what is happening ("finding the Claude Code
  session…", "sending to …"). A second click while one is running is ignored.
- Added: **Redline: Set Up Claude Code Hook.** An optional hook records the files the agent
  itself edits, so **Last** stops crediting the agent with your own saves or a formatter's
  writes. The script is installed for you; `settings.json` is never edited on your behalf.
- Fixed: **Last showed earlier work as well as the newest.** If the agent committed nothing,
  `run.base..worktree` was identical to the whole session's range, so "the last run" quietly
  meant "everything". Run attribution now takes committed work from git and uncommitted work
  from file times — on a real worktree that is 3 files in the last run instead of 11 spanning
  three days.
- Fixed: **"0/N addressed" when notes had been addressed.** Two independent causes. The
  agent's report was read from the terminal, but Claude Code repaints its TUI in place, so a
  capture is almost entirely redraw frames — the reply had scrolled away. Reports are now
  read from the session transcript, which holds the exact text; the terminal and clipboard
  remain fallbacks. (The Orca read itself was also broken: it looked for `result.text` where
  Orca returns `result.terminal.tail`, so every read came back empty.)
- Fixed: **✏️ code changed never lit up for an edit beside a note.** It compared only the
  snippet under the note, so "add a comment above this line" left that line byte-identical
  and registered as nothing. The containing file's hash is now recorded at send time too.
- Fixed: a session that started before a `git pull` reported every file the pull brought in
  as changed. Automatic bases are now clamped to the last published commit.
- Fixed: **All** was hidden whenever it would not show more than **Last**, which left no way
  out when the last-run range looked wrong. It is now offered whenever anything differs from
  the base, and both buttons show their file count on hover.
- With no Claude session to go on, the range is now everything the remote does not have —
  so local commits show up instead of only uncommitted work.
- **Last** is derived from the session transcript's idle gaps rather than file mtimes, so a
  long pause or an early commit no longer drops files from the run.
- A failed file listing is reported as "changes unavailable" instead of "0 files changed".

**Renamed from Local Review to Redline.** The extension id, commands and settings moved from
`localReview.*` to `redline.*`.

- Existing notes and screenshots are copied over on first activation; `localReview.*`
  settings are still read, so nothing has to be edited by hand.
- Session strip: **Review** / **All** became **Last** / **All** — one scope choice.
- Screenshots can be dropped onto a note card by holding ⇧ while dragging (VS Code blocks
  pointer events over a webview during a plain drag). Picking with 📎 and pasting with ⌘V
  are unchanged.
- Renders are held back while a drag is in flight, so a card can no longer be replaced
  under the pointer mid-drop.

## 0.1.0 — 2026-08-23

Initial release.

- Inline `+` gutter affordance and comment widget via the native `vscode.comments` API.
- Multi-line notes from a selection; quick-add from the keyboard.
- Notes persist per workspace (VS Code storage by default, `.review/notes.json` opt-in).
- Review Notes panel: group by file / kind / time / flat, filter, badge, status bar count.
- Submit → render → clipboard (with read-back verification) → archive → clear, with Undo.
- Templates: `claude-prompt`, `checklist`, `json`, `plain`, `custom`.
- Kinds, suggested-change blocks, addenda, done / parked notes.
- Content-based anchoring that survives edits and external rewrites; orphan group with
  re-anchor / keep-as-file-level actions.
- Diff editor support; changed-lines-only mode; next / previous note walk.
