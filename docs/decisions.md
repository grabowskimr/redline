# Decisions that look wrong

Each of these has been "fixed" at least once and had to be put back, or was a bug that took a
long time to find. If you are about to change one, this is why it is the way it is.

## The widget leaves when the code moves, not when Claude answers

A note's inline widget stays through the answer. What takes it away is the code under it
changing — the lines it was anchored to differing from the ones that were sent — plus the two
cases where it is pointing at nothing: an orphaned anchor, and a note you have settled.

It used to go the moment there was an answer, on the reasoning that the widget cannot show a
conversation. It can: `renderCommentBody` renders the whole thread, Claude's turns included.
What the old rule cost was the case it was least suited to — a question changes nothing, and
its answer is most useful sitting against the code it is about, so closing the widget sent you
to find a card to read a reply about lines still in front of you.

The rule is still uniform across kinds. A change request loses its widget and a question keeps
it because their *effects* differ, not because either is special-cased.

Two things make it work, and both look removable:

- `NoteIndex.setLinesChanged` fires `onDidChange`. Silently setting the flag is a change nobody
  hears: an agent that edits elsewhere in the file first leaves `changedSinceSent` already
  true, so that setter returns without firing.
- `CommentHost.sync()` is subscribed to that event. An agent rewriting a note's lines in place
  leaves the note itself untouched — same file, same line numbers — so no store event is raised
  and nothing reconsiders the widget on its own.

## Claude saying "done" does not close a note

The report sets `sent.outcome`, never `done`. A note Claude has finished with sits in **needs
approval** until a person looks at it.

This is the product. An agent reporting success is a claim about the code, not a verdict on it,
and a review that closes itself is not a review.

## A note is never deleted implicitly

Losing the code it pointed at makes a note **orphaned** — a flag, and a card that offers to
re-anchor it. The question it asks is still worth reading.

## `anchor.snippet` is rewritten; `snapshot.code` is not

They look like the same field and are opposites. See
[`data-model.md`](data-model.md#anchorsnippet-vs-snapshotcode--not-the-same-thing). If you ever
find yourself deleting one as a duplicate, read that first.

## One agent turn per round, replaced not appended

The report is read repeatedly while the run is going — that is what makes a card answer seconds
after the edit rather than at the end of the turn. The agent refines its wording between writes,
so appending each version showed the same answer twice in slightly different words.

`agentTurnThisRound()` never reaches back past `addendaAtSend`: earlier rounds are the record of
what was actually said, and rewriting them would be rewriting history.

## Reading the report does not consume it

`readReport()` and `takeReport()` are separate for this reason. Consuming it mid-run would throw
away every note still to come. The end-of-run path consumes it exactly as before, so a stale
report still cannot survive into the next round.

## Sends run one at a time

Every send ends with `clearSent(theseIds)`, which archives and deletes every *other* sent note
on the understanding that it is the previous round. Two sends in flight break that
understanding: the second deletes the first's notes seconds after they went, and Claude's answer
comes back naming notes that no longer exist. `serialise.ts` is a queue of one.

## The queue holds ids, not a flag

It was a boolean. One flag cannot hold two things — replying to one card and then a second
before the first was answered set the same flag twice, and the flush re-derived "everything
sendable" from the store, so what actually went was whatever qualified at that moment.

Holding a note writes nothing *on* the note, so it stays an ordinary unsent note to every other
send path; whoever sends it first claims it out of the queue, or it goes twice.

## The panel repaints wholesale, and carries three things across

No diffing, no framework. What it explicitly preserves is: every open follow-up draft (not just
the focused one — clicking Attach moves focus, and that used to destroy the draft the screenshot
was *for*), the caret in the focused one, and the scroll position.

The header and the card list are separate containers because the header changes constantly and
the cards hardly ever do.

## Every colour is a theme token; the ten kinds are not

There is no set of ten `--vscode-*` variables that stays distinguishable. Everything else —
surfaces, borders, text, the good/bad/warning colours — comes from the theme, so the panel is
not a dark-themed island in a light editor.

## The plugin swallows every error

It runs inside someone's agent session. A hook that fails loudly interferes with their turn.
Redline treats "the plugin said nothing" and "the plugin is not installed" identically, and both
are supported modes.

## Timeouts everywhere, including the boring calls

`ps`, `lsof`, `orca`, and every `git`. A hung `lsof` against a stale network mount, or a `git`
waiting on an index lock, used to leave the panel frozen for the life of the window with no
message — the failure looks like the extension being broken, not like a stuck subprocess.

## `sendSelected` queues when the agent is busy, with no dialog

A whole batch asks first, because it is a deliberate, larger action. A single card does not:
replying to several cards in a row while the agent works is the ordinary way this gets used, and
a modal for each would be worse than the wait. The card says it is holding and offers to call it
off.

## The scratch index has a pid in its name

Two sessions in one worktree collided on git's `index.lock`; one lost its "before" snapshot, so
everything it changed was attributed to whatever came next. Both the extension and the hook do
this now, and both learned it the same way.
