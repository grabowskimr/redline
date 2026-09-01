# Changelog

## 1.7.0 — 2026-08-31

Fixes to the note widget and the panel.

- **The widget stops flashing a box that does nothing.** A new note showed a reply bar for as
  long as it took to read the file and ask git about it — the editor re-renders a thread it has
  not been told otherwise about, and everything after that point waits on something. The thread
  is now told before anything that waits, and a test asserts it happens *before* the first
  `await` rather than after the work.
- `applyNoteToThread` sets `canReply` on every path, not only for threads that already carry a
  note.
- **The session is a toolbar, not a card.** It used to be a rounded, bordered box above a
  column of rounded, bordered boxes — so the one thing that is not a note looked exactly like
  one, and you had to read it to find that out. It now spans the panel edge to edge with a rule
  under it, and reads as chrome at a glance.
- **Cards end somewhere.** The buttons sit in a band of their own, ruled off and slightly
  sunken: what you can do is not another paragraph of what was said, and in a column of cards
  each one otherwise ran into the next. The note itself is now labelled *Your request*, so it
  reads as one voice in an exchange rather than loose text above an answer.
- Shorter placeholder in the comment widget: it sits above a box the editor gives a
  ninety-pixel floor to, and a sentence that long reads as the field's contents.
- **The widget stays until the code moves.** 1.6.0 took it away as soon as Claude answered.
  That was wrong for the case it mattered most in — a question changes nothing, so its answer
  belongs against the lines it is about, and closing the widget sent you to find a card to read
  a reply about code still in front of you. It now goes when the note's *own* lines differ from
  the ones that were sent, which is what a change request produces and a question does not. The
  rule is still one rule: the kinds differ because their effects do.
- **A kind is an instruction, not a label.** `Kind: question` named the note and permitted
  everything, and questions came back with the code changed. Every kind now carries its rule on
  the note itself — questions are answer-only, in those words — and the standing rule for
  questions is absolute rather than a matter of agreeing first. Adding a kind without writing
  its rule is a compile error.
- **`todo` notes are no longer filed under change requests**, where the heading said "work
  through these in order" and the note said "later work, not now — do not start it". A
  contradiction in a prompt is read as permission.
- **Cards have an edge again.** Not the kind-coloured rule that made the panel read as a form —
  a hairline a step lighter than the card's own fill. A card was only ever as visible as the
  theme's gap between the sidebar and the editor, and plenty of themes leave no gap at all.
- The widget's label carries the state that goes with the answer it is now showing — *needs
  approval*, *turned down*, *on your clipboard* — in the card's own words.
- **A run's changes could go missing entirely.** The working-tree snapshot stages against a
  copy of the repository's index, and copying stamped the copy with the time of the copy — so
  git's guard against its own stat cache never fired, and an edit landing in the same instant
  as the staging that recorded it was answered from the cache. Two snapshots, one tree, and a
  run that rewrote a file reported as having changed nothing. About one run in a few hundred,
  and it lasted, because the stale entry survives until something refreshes the index.
- The lines-changed signal is announced, and the comment host listens for it. Without both, an
  agent that edits elsewhere in a file first, or rewrites a note's lines in place, changed
  nothing any store event would report — and the widget sat on lines it was no longer about.


## 1.6.0 — 2026-08-29

**The conversation happens in one place.** A note's widget now leaves the editor as soon as
Claude answers it, and every follow-up is written on the card. The same rule for every kind,
questions included: keeping a question's widget because it changed no code was defensible on
its own and unreadable in a file with four notes in it — two gone, two still there, for a
reason nothing on screen explained.

- **Removed from the comment widget:** *Follow-up*, *Add Follow-up…*, the reply box's submit
  and its Cancel, and the Escape binding that closed it. Four commands
  (`redline.followUpHere`, `redline.addFollowUp`, `redline.replyToNote`, `redline.cancelReply`)
  are gone. Two of them offered a follow-up at once, in two menus, which is what made the
  widget look like it was asking twice. Creating a note in the widget is unchanged.
- **Removed:** `redline.reviseNote` — reachable from no menu, and a worse version of what
  *Not this* plus a follow-up already does.
- Fixed: **"Not this" said Claude was working on it** the moment it was clicked. Nothing had
  been sent — a rejection does not go anywhere until you say what was wrong — and there was no
  button to send it with either. The card now asks for the reason, offers *Send your reply*
  once it is written, and says *Claude is having another go…* only once it has gone.
- **A misclicked rejection has a way back.** *Not this* sits one button from *Approve*; the
  card now offers *Keep it* until something is written.
- Fixed: **a screenshot attached to the note appeared twice** once the first follow-up was
  written — once under the note and once inside the follow-up — because both were recorded
  with the same number. An attachment now names its turn as an index plus one, with 0 meaning
  the note itself, and is drawn beside the words it was taken for.
- Fixed: **a half-written report was consumed and lost.** The Stop hook writes it while the
  panel may be reading, and unparseable JSON was renamed aside as though it had been applied.
  A report that began and did not finish is now left where it is and read again next time;
  prose that was never JSON is still consumed, or it would be re-read for ever.
- Fixed: **a report that arrived after the sent notes were cleared sat on disk for ever.** It
  is collected before that exit now, so a new round never opens on top of a stale one.
- Fixed: **answers naming notes that are no longer there vanished in silence**, and the panel
  reported that nothing was found. They are counted and named.
- Fixed: **a note whose file Claude deleted shipped its old code as current.** The prompt says
  the file is no longer on disk and labels the code as the note's own record of it.
- Fixed: **a batch over ~120 KB failed obscurely on Linux** when typed into an Orca terminal —
  a single argument is capped at 128 KiB there. It now says so, and the prompt is on the
  clipboard either way. macOS has no such cap and is unaffected.
- Fixed: **the panel could take seconds to show a follow-up you had just written.** Repaints
  were held back while a box had focus, so the turn appeared only when you next clicked
  elsewhere. The box and the caret are carried across a repaint instead, and nothing is held.
- Fixed: **a queued focus could be fired much later, on the wrong card.** Turning a change down
  arms the panel to put the cursor in that card's box; it is now consumed on the very next
  repaint whether or not it is used.
- Fixed: **drag-and-drop feedback was invisible.** `.dropping`, `.replying` and `.busy` had no
  rules left; the guard that catches this only read literal class attributes and now reads
  `classList` calls too.
- **The ⋯ menu and the kind picker work from the keyboard** — arrows, ⏎, Escape, and focus
  handed back to the control that opened them. The kind picker was not reachable at all.
- **The session card is two rows**: who Claude is and whether it is listening, then what there
  is to review and at what scope. *Last* and *All* are *Last run* and *Everything*, in one
  segmented control.
- Fixed: **clicking a scope button resized it**, which resized the row, which moved every card
  underneath. The button keeps its label; the card takes the working colour instead.
- The card carries the kind as a coloured dot beside the state, a hatched placeholder that is
  drawn before a screenshot decodes, tighter buttons, and a settled row that names its kind.
- Fixed: the README's prompt sample swallowed four whole sections inside its code fence — *A
  second round*, *Going back*, *Approving what changed* and *While it is working* did not
  render on GitHub at all.

### The widget stops flashing a box that does nothing

- Fixed: **a reply bar appeared under a new note for a moment after you typed it.** The instant
  the editor accepts what you wrote it re-renders the thread, and a thread it has not been told
  otherwise about offers to be replied to — so the bar sat there for as long as it took to read
  the file and ask git about it. It is told at the first instant it can be, before anything that
  waits, and there is a test that this happens before the first `await` rather than after the
  work.
- The widget's placeholder is short now. That change was made once already and silently did not
  apply; this one is checked.

### Suggested changes are gone

- **Removed the suggested-change feature entirely** — `Add Suggested Change…` from the
  comment's menu, `Apply Suggested Change` from a card, the field on a note, and the block it
  wrote into the prompt. It asked you to write the fix yourself and hand it over, which is not
  what this is for: the point is to say what is wrong and let the agent do it. A note's body
  can carry a snippet if you want to be that specific.
- Two knock-on tidies it made possible: the code-fence helper had been lifted into `model/` to
  break a cycle between the widget and the prompt renderer, and with the widget no longer
  rendering code that cycle cannot exist — so it lives with the renderer again, where it is
  used. The subsystem graph stays acyclic.

### A long snippet stops burying the card

- **A snippet longer than three lines folds**, fading out into a *Show all N lines* control
  that is the whole width of the fade rather than a small target beside it. A note on a whole
  function is an ordinary thing to write, and thirty lines of it at the top of a card pushed
  everything that needed answering off the screen.
- It is folded, not truncated — the code is all there, so opening it is a class rather than a
  round trip for the rest.
- Fixed while doing it: **an expanded settled card folded itself back up mid-read.** Which
  cards are open is the panel's own state and was written as a class on the element, which a
  repaint destroys — and while an agent is working the panel repaints constantly. Both that and
  the new fold are held in the script instead, so they survive.

### The note widget looks like a place to type

- Fixed: **the box you write a note in had no background of its own.** Redline was forcing
  `editorCommentsWidget.replyInputBackground` to fully transparent — right when the widget
  still had a collapsed *reply* bar, which took the widget's colour rather than sitting on it
  as a slab. That bar is gone; the only input left is the one you write a new note in, and it
  was left reading as a hole in the widget rather than a field. The override is removed
  entirely: your theme decides, as it should, and a test fails if a default like that comes
  back — one set here overrides every theme a user might install.
- The placeholder is shorter. It sits above a box the editor gives a 90-pixel floor to, and a
  sentence that long across an empty field reads as the field's contents.
- The box cannot be made shorter than that: the floor is a constant in VS Code, not a setting.

### A note without reaching for the mouse

- **`⌘R` opens the note widget on the line the cursor is on** — the same thing the `+` in the
  gutter does, with a selection if you have one. It asks the editor to open it rather than
  building the thread itself: the editor already knows where the commentable ranges are, how to
  focus the box, and what to do when you press Escape. A thread opened here and walked away
  from would leave an empty marker in the gutter with nothing in it.
- `⌘⌥M` still types into a prompt, for a narrow screen where the widget takes half the editor.
- On macOS `⌘R` is *Open Recent*. The binding is scoped to an editor with focus, so it takes
  over only there; `⌘⇧R` and the command palette still reach the original.

### Screenshots go with the note

- **Deleting a card now throws away its screenshots** — the ones attached to the note and the
  ones attached to its follow-ups alike. They were swept only when a window opened, so a
  deleted card's pictures sat in storage until the next restart, and they are the one thing
  stored here measured in megabytes.
- The sweep runs once the note is gone for good, after its Undo window closes rather than when
  it is deleted, and it counts the archive as well as the active batch: a sent note lives on
  there, *Restore Last Submitted Batch* brings it back whole, and its pictures have to be there
  when it arrives.

### Documentation, and a tidier tree

- **[`docs/`](docs/) is written for whoever changes this next** — nine pages covering what the
  parts are and why the boundaries fall where they do, what a note is and which four predicates
  decide everything the UI shows, how the panel and the plugin work, which test suite to reach
  for, where a new file goes, and a page of decisions that look wrong until you know why. It
  exists because the answers were spread across a thousand code comments and one long
  conversation, and neither survives a fresh session.
- **One copy of the hook script.** There were two — `resources/` and `plugin/hooks/` — kept
  identical by a script in `npm test`. Nothing ever read the second one, and both shipped in
  the `.vsix`.
- `src/` root is the entry point and the two things everything uses. `attachments.ts` and
  `migrate.ts` moved into `store/`, which owns what they touch; `dnd/dropPayload.ts` into
  `view/`, which owns the panel. A fourth file at the root now means a subsystem is missing.
- The panel's tests were one 1,500-line file named after the smallest thing in it. They are five
  files by concern, over a shared harness, with the duplicate `describe` names separated.
- Fixed: **`test:unit` ran stale compiled tests.** Deleting a test file left its compiled copy
  behind and mocha ran whatever was there, so a test that no longer existed kept passing — and
  a split file ran twice. It clears `out/test` first now.
- The `spec/` files each carry a superseded banner. They are the original build handoff, they
  name commands that were never built, and they read as live contracts.

### Tests for the half of the extension that had none

- **Half the source imported `vscode`, which put it beyond the unit suite** — the four largest
  files had no test that so much as loaded them, and the integration suite costs half a minute
  a run and cannot be pointed at one function. A small stub now stands in for the editor, so
  those modules can be exercised directly. It is deliberately thin: everything in it either
  does the real thing or records that it was asked, and anything not modelled is simply absent,
  so a module reaching for it fails loudly rather than quietly seeing `undefined`.
- **`reviewRange`** — 1,600 lines and the answer to "what changed" — is tested against a real
  repository built in a temp directory: edited, created, deleted and committed files, a pinned
  baseline, the untrusted-folder refusal, and one computation shared between callers asking at
  once. Real git rather than a stub, because everything interesting here is a fact about a
  repository and a stubbed `git` would only confirm what the test author already believed.
- **`batchCommands`** — the round trip — is tested where the bugs actually were: a send held
  while the agent works, two follow-ups held before the first was answered, one card's queue
  called off without the others, one answer per round however many times the agent rewrites it,
  a follow-up typed while the report was being read, and an answer for a note that has gone.
- **`liveTracker`**, behind "notes follow their code": a note that moves when lines are added
  above it, one orphaned when its code goes and never deleted, one that comes back when the
  code does, the frozen snapshot left alone as the key follows the file, and no write at all
  when nothing moved.
- **`cardsView`**, the panel's host half: what a card is told, and the page's own policy —
  including that it allows no inline styles, which is the half of that pair that lives here.
- **`claudeSession`**: what counts as a session that can be typed into, and the paste wrapping
  that stops a multi-line prompt being read as line after line of typing.

### The queue, and sending a reply in one press

- Fixed: **⌘⏎ did not send.** It recorded the turn and stopped, so the shortcut and the button
  beside it did different things — and it left the reply sitting on the card needing a second
  press that the hint next to it said nothing about. It sends, exactly as Send does.
- **One row for a reply, not two.** *Attach · Send your reply* was a near-identical copy of
  *Attach · Send* doing the same job, and with both the shortcut and the button now sending, it
  was hardly reachable at all. A note that arrives carrying an unsent turn — one reopened after
  being settled, say — starts with the box open instead.
- **A reply goes in one press.** While the box is open the card shows *Attach* and *Send*
  instead of *Approve · Not this · Reply* — the verdict buttons are about the answer you were
  given, and are noise beside a half-written reply. Recording and sending were two steps so a
  screenshot could be attached in between; that is what *Attach* beside it is for, and making
  every reply cost two clicks to spare that one was the wrong trade.
- Fixed: **replying to a second card while Claude was still working on the first typed into the
  middle of its turn.** Single sends never consulted the queue at all — the one path that most
  needed it, since replying to several cards in a row is the ordinary way this gets used. They
  are held now, without a dialog for each: the card says *Queued — goes when Claude finishes*
  and offers to call it off.
- Fixed: **the queue could not hold two things.** It was a single `true`, so a second held send
  set the same flag, and the flush re-derived "everything sendable" from the store — what
  actually went was whatever qualified at that moment rather than what either send had asked
  for. It holds ids now, sends exactly those, and drops any note that has gone in the meantime.
  Several held sends leave as one message, which is what they are to the agent.

### Telling the agent which part is the new question

- **A follow-up is now labelled as one in the prompt.** The note, the agent's own replies and
  the new ask were flattened into a single block under `User comment:` — so it read its own
  words back as the user's, both sides carried the same `↳`, and on a note that had been round
  twice the thing actually being asked for was the last line of a quote with nothing marking
  it. Each side is named now, and the live ask stands on its own:

  ```
  User comment: "add a test comment above"
  Already said about this note, oldest first:
    - you: added a `// test comment` line above the component declaration in […]
  Follow-up — this is what to do now: "different comment"
  ```

  A note re-sent with nothing new written on it has no follow-up line: every turn is history,
  and saying "do this now" about the last thing the agent itself said would be nonsense.

### The card, tidied

- Fixed: **every `style` attribute in the panel was being thrown away.** The webview's policy
  has no `'unsafe-inline'` for styles, so the browser dropped all of them without a word — the
  kind's coloured dot beside the state drew as a six-pixel hole in the padding, and the kind
  icon was whatever colour it happened to inherit. The ten kinds have classes now, and a test
  fails if one is added without a colour. The kind is shown once, by the colour of its own icon
  beside the file — the dot beside the state said the same thing a second time, and left the
  state word indented for nothing. The reset that strips the host's button chrome off that icon
  carried a `color: inherit`, which beat the kind's own class two specificity points to one, so
  the icon was handed straight back the colour of the text around it and every kind looked
  identical. A test now fails if anything but a kind class sets a colour on it.
- **The follow-up box is behind Reply.** It sat open under every card that needed an answer,
  above the buttons, so the first thing a card asked for was typing — when the usual answer is
  one of the three buttons beneath it. Reply opens it, a ✕ discards it, and pressing Reply
  again sends what you wrote. It is rendered either way and only hidden, so a repaint cannot
  lose a half-written reply.
- **Attach is a word, not a paperclip** nobody could make out at that size, and neither button
  on a card stretches across the row any more: *Send to Claude* taking every pixel Attach did
  not made a two-button row read as one enormous button with a chip beside it.
- A card turned down now offers **Write it** as well as **Keep it** — with the box behind
  Reply, a repaint would otherwise leave the card asking for a reason with nothing on it that
  takes one.

### The code on a card is the code you wrote about

- Fixed: **the snippet on a card was live, not the lines you highlighted.** It showed
  `anchor.snippet`, which looks like a record of what you selected and is not — it is the key
  the note is found by, and the live tracker rewrites it from the current file every time the
  code moves, or the note would orphan on the agent's first edit. So the lines under a comment
  quietly became whatever had just been written there, and a note saying "why this early
  return?" ended up sitting over the code that replaced it. What you highlighted is now kept
  separately and never moves, with the line numbers it had at the time; the key goes on
  following the code, which is its job. Notes written before this fall back to the old
  behaviour, which is the best that can be said for them.
- A note whose file is gone now shows what it was written about, rather than the key, in the
  prompt as well.

### The run's files, where you look for changed files

- **"Claude's last run" in the Source Control view lists what the run changed.** The section
  was there and always empty: a quick diff can only be contributed by a source control, and one
  shows up in that view whether or not it has anything in it, so the list was a hole where an
  obvious one belonged. Clicking a file opens the run's own two sides — the file as the run
  found it, against the file now — which is *Last run* for one file. Added, deleted and renamed
  files are all listed, each with the side it is missing stood in for. It is built from the
  comparison the panel has already computed, so it costs a walk of a map rather than any git,
  and it does not add to the badge on the activity bar: those are the same files git is already
  counting.

### Saying who is actually holding the work

- Fixed: **a batch that only reached the clipboard said "Waiting for Claude…".** With no session
  to type into, the notes go to your clipboard and nobody has read them — but the card claimed
  the agent had them and was working, which is a lie about where the work is and whose turn it
  is, on the one screen that exists to answer both. A note now records how it left, and the card
  says *On your clipboard — paste it into Claude Code*, or *Staged — type the delivery word in
  your session*, or waits on Claude only when Claude actually has it. It corrects itself the
  moment the code changes.
- Fixed: that send also said it twice — "…the notes are on the clipboard. Copied to the
  clipboard instead."
- **"Last run" covers the round, not the last message.** The boundary was read from the
  transcript as "the last thing you asked for", so answering three cards one at a time made
  each answer its own run and the diff narrowed to whatever the newest one touched — the rest
  of the round disappeared from it. It now starts at the oldest send you have not settled, and
  hands the boundary back to the transcript once everything is settled.
- Fixed: **the answer appeared twice on a card**, in slightly different words. Reading the
  report while the run is still going means the same note is answered several times as the
  agent refines what it wrote, and each version was appended as a new turn. There is one answer
  per round now, replaced rather than added; turns from earlier rounds are never touched.
- Fixed, at the root this time: **the box around the session switcher was a card's status row.**
  `working` named two different things — the row a card shows while it waits on Claude, which
  paints a dark box with eight pixels of padding, and the mark put on a row of controls while
  its command runs. Marking the controls with it drew that box around the icon and grew the
  card by the padding, which is why pinning the button's size never helped: nothing was wrong
  with the button. The two are `working` and `running` now, and the box is scoped to a card.
  The switcher is also no longer a `<button>`, so there is no host chrome left to inherit; both
  rows of the card have fixed heights; and the summary line is short enough to fit beside the
  buttons instead of clipping mid-word and shoving them off the edge.

### Answers while the run is still going

- **A card answers seconds after the edit, not at the end of the turn.** The agent was asked to
  write its report "when you are done", so a note whose code you could already see change sat
  saying nothing until the whole batch finished — on a dozen notes, a long time watching a card
  that plainly knew something had happened. It is now asked to write the file again each time
  it settles a note, and the panel reads it as it lands. The read never consumes the file: the
  run is still going and everything after it is still to come, and applying the same outcome
  twice is a no-op. The end-of-run path takes and clears it exactly as before, so a stale
  report still cannot survive into the next round. Needs the plugin; without it the outcomes
  still arrive together at the end.
- Fixed: **Reply did nothing.** It only moved focus into a box that was already on screen, so
  typing a follow-up and pressing it changed nothing at all — the words sat there, and the one
  way to commit them was a keyboard shortcut nobody had been told about. It now takes what you
  wrote, exactly as ⌘⏎ does.
- Fixed: **the session switcher still grew when clicked.** Its size was pinned, but hovering
  and running filled a box behind it that is bigger than the icon. There is nothing for that
  box to say — the card already takes the working colour — so the icon carries the state in
  its own colour and paints no box at all.
- Fixed: **a reply written and not sent said "Sent"**, which is the one thing it is not. It
  says *Reply not sent*, in the colour the panel uses for "waiting on you".
- Fixed: **"Waiting for Claude…" under an answer Claude had already given.** Approval waited on
  a *code change*, so a question answered without touching the code — "the note just says test,
  so I left it alone" — matched no branch and fell through to the default row.
- **Settled cards sink to the bottom**, collapse to one line with the code behind the click,
  carry a ✕, and open onto **Pick this up again** — approving is not the end of the
  conversation if something occurs to you afterwards.
- Fixed: the file icon on a card sat on a filled square (it became a `<button>` for the
  keyboard's sake and arrived wearing the host's chrome); the settled row's icon floated off
  its line; the session card changed shape as a run went; and a file reference inside an answer
  had the text cursor, because an anchor with no `href` never gets a pointer.

### Reachable, and honestly described

- **Every command a menu can reach is now reachable, and every one that isn't is gone.**
  *Re-anchor at Cursor* and *Apply Suggested Change* were both documented in the README and
  wired to no menu at all — the card told you a note had lost its lines and offered nothing to
  do about it. Both are on a card's `⋯` now, each only when it applies. Five quick-kind
  commands that no menu, palette or panel could invoke were removed.
- Fixed: **the follow-up box said ⏎ and ⏎ inserts a newline.** It says ⌘⏎ (Ctrl+⏎ elsewhere),
  which is what actually sends.
- Fixed: **an untrusted folder was told it was "not a git repository"** — a false explanation
  for the one case that is both common and fixable from the message. It now says what is
  actually wrong and offers *Manage Trust*.
- Fixed: **"no reachable Claude Code session found"** explained nothing. It says what would
  count as one, and that sending works anyway — clipboard, or the plugin from any session.
- Fixed: **the session card read "not watched" while the plugin was reporting every tool
  call.** The idle monitor only ever attaches to Orca terminals, so everyone else saw a fault
  where there was none.
- **The empty panel offers the two things worth doing** — open the last run's diff, install the
  plugin — instead of only describing how to leave a note.
- README: added the missing **Installing** section (there was no way to install the extension
  from the README at all), corrected the second-round prose to the buttons that exist, the
  one-click kinds to the five that are there, the `⋯` menu to its real contents, and the
  "exactly one thing in your editors" claim, which the run gutter has not been true of.

### Speed

- **A run in another repository no longer wakes this window.** The hook writes one directory
  per working directory and the extension watches the tree whole, so any agent anywhere used
  to cost every open window a change-summary recomputation and a session discovery, several
  times a second, for work that could not touch anything on screen. Signals are matched to the
  folders this window is open on — including a session started in a subdirectory of one, or in
  a parent of one, which is the monorepo case.
- **Every git call is bounded.** Only the snapshot ones had a timeout; a `git` that never
  returned — an index lock, a network filesystem, a wedged `core.fsmonitor` — pinned the
  in-flight summary for the life of the window, and the panel and status bar simply stopped
  updating with no way back but a reload.
- **Anchors: 11.97 ms → 0.06 ms** for twenty notes in a 3,000-line file, on every save, on the
  UI thread. Every note was re-splitting and re-normalising the whole file for itself, and
  every *sent* note was hashing it again on top of that.
- **The panel repaints the header without rebuilding the cards.** The header names the file
  Claude is writing right now, and it shared one HTML string with the card list — so a run
  touching thirty files re-parsed every card thirty times, dropping the scroll position each
  time.
- **Two fan-outs have a ceiling.** One `git diff` per changed file, all at once, was five
  hundred git processes for a five-hundred-file run; comparing against the snapshot held both
  copies of every changed file in memory at the same moment.
- The panel no longer stats every note's file while it is closed, `updateMany` is no longer
  quadratic in the number of notes, and stopping a session watch no longer leaves an `orca
  terminal wait` running for up to five minutes.

## 1.5.3 — 2026-08-28

- Fixed: **a follow-up you wrote appeared nowhere on the card.** It was kept, and the button
  changed to *Send your reply*, but the words themselves were only ever rendered in the rejected
  state — so on every other card it looked as though they had been thrown away.
- The card shows **the whole exchange** now, in the order it happened, rather than Claude's
  newest turn alone. Reading back over a conversation is most of what a card is for once it has
  been round more than once.
- A turn Claude has not seen is marked **not sent yet**, so a written follow-up cannot be
  mistaken for a sent one.
- The follow-up box stays while the conversation is live, not only while a card is waiting for
  approval: after writing one follow-up you usually want another.

## 1.5.2 — 2026-08-28

- Fixed: **the ⋯ menu rendered as a list of words under the last card.** Its rules went with the
  block the redesign replaced, and nothing failed — the markup was still right, it just had no
  styling, so a popup that is appended to `body` and positioned absolutely laid out in the
  normal flow instead. The kind picker used the same rules and was broken with it.
- A test now checks that every class the panel script writes has a rule somewhere in the
  stylesheet, and that the popup is positioned out of the flow. Nothing else would have caught
  this: the failure is invisible to a type checker and to every test that reads markup.
- That check immediately found dead code behind it — the old code-box renderer the redesign
  replaced, and the "current code" it was fed, which was being read off disk for every changed
  note on every render and shown nowhere.

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
