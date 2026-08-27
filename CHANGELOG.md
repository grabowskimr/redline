# Changelog

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
