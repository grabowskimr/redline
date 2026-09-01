# Architecture

## The shape of it

Two programs that never call each other:

```
  ┌─────────────────────────────┐        ┌──────────────────────────────┐
  │ VS Code extension           │        │ Claude Code plugin           │
  │ (this repo, src/)           │        │ (this repo, plugin/)         │
  │                             │        │                              │
  │  reads ──────────────────────────────── writes                      │
  │       ~/.claude/redline/<slug>/ ── hook.json, runs.json,             │
  │                                    stopped.json, touched.jsonl       │
  └─────────────────────────────┘        └──────────────────────────────┘
              │                                        ▲
              │ types a prompt into                    │ runs as hooks inside
              ▼                                        │
        a Claude Code session ─────────────────────────┘
```

The only channel between them is a directory of files. Nothing imports anything across that
line, there is no socket, no port, no daemon. That is deliberate: the plugin runs inside
someone's agent session, where a crash or a stall is *their* problem, so it must be able to
fail completely without the extension noticing anything worse than "no plugin installed".

## Subsystems

One folder per subsystem, named for what it owns.

| Folder | Owns | Imports from |
|---|---|---|
| `src/model/` | What a note **is**: types, kinds, the predicates that decide state, and the pure helpers two subsystems share. | — |
| `src/claude/` | A Claude Code session: finding it, sending to it, reading what its hooks wrote. | — |
| `src/store/` | The notes themselves: hold, mutate, persist, migrate, attach files. | `model` |
| `src/comments/` | The inline widget: threads, ranges, URI mapping. | `model`, `store` |
| `src/git/` | What changed, and the diffs to show it. | `model`, `store`, `claude` |
| `src/anchor/` | Keeping a note on its code as the code moves. | `model`, `store`, `comments`, `view` |
| `src/view/` | The panel, the gutter, the status bar, the `when`-clause context. | `model`, `store`, `comments`, `git`, `claude` |
| `src/export/` | Turning notes into a prompt, and parsing what comes back. | `model`, `anchor`, `comments`, `git`, `claude` |
| `src/commands/` | Every user action. The layer that orchestrates all of the above. | all of them |
| `src/*.ts` | The entry point, and the two things everything uses (`config`, `logger`). | everything, from `extension.ts` only |

**There are no cycles between subsystems**, and that is worth keeping. Three existed until
recently and each was one small helper in the wrong place: an image-name predicate, a code-fence
helper, and a module taking a whole class when it wanted one method. The fixes were all the
same shape — put the shared thing in `model/`, or take the function instead of the object.

If you are about to add an import that closes a loop, that is the signal. Ask what the two
modules actually share; it is usually four lines that belong to neither.

### The `vscode`-free rule

`src/model/` imports no `vscode` at all, and neither do the pure halves of the other
subsystems — `anchorService`, `renderBatch`, `report`, `runFiles`, `hunks`, `snapshotTree`,
`touched`, `transcripts`, `sendQueue`, `serialise`, `dropPayload`. This is not architectural
fastidiousness: it is what lets the unit suite test them directly, at millisecond speed,
against real inputs.

`src/store/` is *mostly* clean — `reviewStore`, `persistence` and `emitter` are pure; only
`attachments` and `migrate` need the editor, because they move files around.

Where a module genuinely needs the editor, the decision is usually separable from the plumbing.
That is why `sendQueue.ts`, `serialise.ts`, `dropPayload.ts`, `runFiles.ts`, `hunks.ts`,
`report.ts` and `snapshotTree.ts` exist as their own files: each is a decision that was once
buried in a `vscode`-importing module and could not be tested until it was lifted out.

Modules that do need the editor can still be unit-tested — see
[`testing.md`](testing.md#the-vscode-stub) — but prefer lifting the decision out.

## The flow, end to end

**1. Something changed.** The plugin's hooks write to `~/.claude/redline/<slug>/` as the agent
works. `hookSignals.ts` watches that directory and turns writes into events. Without the
plugin, `reviewRange.ts` falls back to file modification times.

**2. The panel shows what changed.** `reviewRange.ts` answers "which files, since when", using
tree snapshots when the plugin provided them. See [`review-range.md`](review-range.md).

**3. You leave notes.** `commentHost.ts` puts a widget on the lines; `noteCommands.ts` creates
the note; `reviewStore.ts` holds it; `persistence.ts` writes it to workspace storage.

**4. You send.** `batchCommands.ts` gathers the notes, `renderBatch.ts` turns them into one
prompt, `claudeSession.ts` finds a session and types it in — or the plugin's handover stages it
and you type one word. If the agent is busy the batch waits in `sendQueue.ts`.

**5. Claude answers.** It writes `report.json` — into the same directory, but by the model
rather than by the hook — as it settles each note. `hookSignals.ts` sees
the write, `batchCommands.applyFiledSoFar()` reads it without consuming it, and each note gets
its answer. At the end of the run the same report is consumed properly.

**6. You approve, or reply.** Approving settles the note. Replying adds a turn and sends the
whole exchange back, from the card — see [`the-panel.md`](the-panel.md). The widget stays on
the lines through all of it, showing the answer where the code is, and goes when the code under
it changes.

## Where the complexity actually is

Three places, and they are worth knowing before you touch anything:

- **`git/reviewRange.ts` (~1,600 lines).** Answering "what changed since the run started" is
  genuinely hard: commits during the session, untracked files, renames, deletions, files that
  were already dirty. It has its own page: [`review-range.md`](review-range.md).
- **`commands/batchCommands.ts` (~1,000 lines).** The round trip. Sending, queueing,
  serialising, applying reports, restoring batches.
- **`media/cards.js` (~1,450 lines).** The whole panel UI, in one file, in plain ES5-ish
  JavaScript because it runs in a webview with no build step. See [`the-panel.md`](the-panel.md).

After those, the largest are `claudeSession.ts` (~735), `cardsView.ts` (~640),
`noteCommands.ts` (~450), the hook (~430) and `transcripts.ts` (~420). Everything else is under
400 lines and does one thing.
