# A note, and its life

Everything the product does is a function of one `ReviewNote`. `src/model/note.ts` is the file
to read; this page is the map of it.

## The fields that matter

Most of `ReviewNote` is uninteresting (`id`, `seq`, `path`, `body`, `createdAt`). These are the
ones that decide behaviour, and the ones people get wrong:

### `anchor.snippet` vs `snapshot.code` — not the same thing

They look identical and mean opposite things.

- **`anchor.snippet`** is the **search key**. When the agent rewrites a file, `liveTracker`
  re-resolves the note by matching this text, then *rewrites it* from the file. It has to
  follow the code, or a note orphans on the first edit.
- **`snapshot.code`** is the **record** — the lines as they were when you wrote the note, with
  the line number they had. It is written once, at creation, and never touched again.

The card shows `snapshot`. It used to show `anchor.snippet`, so the lines under a comment
quietly became whatever the agent had just written there, and a note saying "why this early
return?" ended up sitting over the code that replaced it.

### `sent` — the record of one round

```ts
sent?: {
  at: string;              // when
  snippetHash: string;     // to detect "the code changed since I sent this"
  fileHash?: string;       // ditto, for edits *beside* the note
  target?: string;         // which session it went to; a reply goes back to that one
  route?: 'clipboard' | 'staged';  // how it left, when it did not reach a session
  outcome?: 'done' | 'skipped' | 'answered';  // what Claude said it did
  reply?: string;          // in one sentence
  addendaAtSend?: number;  // how many turns Claude has seen
}
```

`markSent()` replaces this object wholesale on every send — it does **not** merge. That is
deliberate (a new round is a new record) and is the cause of a bug worth remembering: code that
asks "has this been answered?" by looking at `sent.outcome` alone is asking about *this round*,
not about the note — which is what `agentTurnThisRound` and `hasUnsentReply` are careful about.

`addendaAtSend` is the waterline. Anything in `addenda` past that index is yours and Claude has
not seen it — which is what `hasUnsentReply` means, and what the card marks *not sent yet*.

### `addenda` — the conversation, both sides

A flat array of strings, oldest first. Claude's turns are prefixed with `Claude:`
(`AGENT_TURN_PREFIX`); everything else is yours. `isAgentTurn()` is the only thing that should
ever test that prefix.

One agent turn per round. When a report arrives it **replaces** this round's agent turn rather
than appending, because the report is read repeatedly while the run is going and the agent
refines its wording — appending showed the same answer twice in slightly different words.
`agentTurnThisRound()` decides which turn that is; it never reaches back past `addendaAtSend`,
because earlier rounds are the record of what was actually said.

### `attachmentTurns` — which words a screenshot belongs to

Parallel to `attachments`. Each entry is *an index into `addenda`, plus one*, with `0` meaning
the note itself. The `+1` is what separates "attached while drafting the note" from "attached
while writing the first follow-up" — both happen with `addenda` empty, so a bare count gave
them the same number and the card drew the picture twice.

## The predicates

These four functions in `model/note.ts` decide almost everything the UI shows. Change one and
read every caller.

| | true when | decides |
|---|---|---|
| `isOpen(n)` | never sent, not done | whether a send includes it |
| `hasUnsentReply(n)` | sent, not done, and a turn of yours sits past `addendaAtSend` | whether a send is owed |
| `showsInEditor(n, linesChanged)` | not done, not orphaned, **and its own lines have not changed since it was sent** | whether the inline widget exists |
| `roundStart(notes)` | — | when the round you are still working through began |

`showsInEditor` is the one that takes an argument, and it has to. Nothing on the note records
whether the code under it has moved: the answer lives in `NoteIndex.linesChanged`, filled by
the anchor tracker as documents are read. Unknown — no document open, nothing resolved yet —
counts as unchanged, because a widget that vanished for that reason would come back on opening
the file.

It used to ask whether Claude had ever answered, and that was wrong for the case it mattered
most in: a question changes nothing, so its answer belongs beside the code it is about. See
[`decisions.md`](decisions.md).

`roundStart` is what makes **Last run** mean "the round", not "the last message". It is the
oldest `sent.at` among notes you have not settled. When everything is settled it returns
`undefined` and the boundary goes back to the transcript.

## The life of a note

```
    written ──send──▶ sent ──Claude answers──▶ needs approval ──approve──▶ done
       │                │                          │    │                    │
       │                │                          │    └──not this──▶ rejected
       │           (queued, if                     │                       │
       │            Claude is busy)                └──reply──▶ sent again ◀─┘
       │
       └── deleted (undoable) ────────────────────────────── reopened ◀── done
```

Two rules that are easy to break:

- **Claude reporting "done" does not settle a note.** It is a claim about the code, not a
  verdict on it. Only a person approving closes a note — that is the whole point of a review.
- **Nothing deletes a note implicitly.** Losing the code it pointed at makes it *orphaned*, a
  flag; the question it asks is still worth reading.

## Where notes live

`ReviewStore` (`src/store/reviewStore.ts`) holds them; every consumer subscribes to
`onDidChange`. `Persistence` writes them to VS Code's per-workspace storage — never into the
repository — debounced, atomically, with a corrupt file quarantined rather than thrown away.
`schema.ts` validates and migrates on load; a malformed note is dropped and counted rather than
failing the whole file.

There is one active batch and up to twenty archived ones. Sending archives the previous round,
which is what makes "Restore Last Submitted Batch" possible.

### Screenshots, and when they are thrown away

Attachments are the one thing stored here measured in megabytes, so they are swept — but only
on "nothing refers to this any more", counting **the archive as well as the active batch**. A
sent note lives on in the archive and *Restore Last Submitted Batch* brings it back whole; its
pictures have to be there when it arrives. Sweeping on "no active note refers to it" would take
them the moment a round was cleared.

The sweep runs when a note is gone for good — after its Undo window closes, not when it is
deleted — and at activation. A batch that falls off the end of the archive orphans its
attachments too; those wait for the next sweep.
