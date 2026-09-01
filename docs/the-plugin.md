# The Claude Code plugin

`plugin/` — four hooks, a shell wrapper and the script it runs, no dependencies. It runs inside someone's agent session,
which shapes every decision in it.

## The contract it works under

**A hook that fails or stalls interferes with the turn.** So:

- Every error is swallowed. The script cannot report a problem, because reporting it would mean
  writing to the agent's output. If it fails, Redline simply behaves as though the plugin is
  not installed — which is a supported mode, not a broken one.
- Every git call has a timeout. `repoRoot()` and the `git diff` after a Bash tool call run on
  the critical path of *every* tool call and are bounded at 5 seconds; the snapshot, which is
  slower by nature, at 30.
- It answers immediately and detaches the work it can. The `UserPromptSubmit` snapshot is the
  exception — it has to finish before the agent's first edit, or the "before" is not before
  anything — and the `.sh` wrapper runs that one event synchronously and every other detached.
  `REDLINE_HOOK_SYNC=1` forces synchronous mode for any event, which is how you debug it.

## The four hooks, and what each writes

Everything goes to `~/.claude/redline/<slug>/`, where `<slug>` is the **repository root** with
every character outside `[A-Za-z0-9-]` replaced by `-`. The root, not the payload's `cwd`:
keying by `cwd` scattered a directory per subdirectory the agent happened to `cd` into, and the
extension — which asks about the repository — found none of it.

| Hook | When | Writes | Why |
|---|---|---|---|
| `UserPromptSubmit` | you send a message | `hook.json` (the plugin is alive, and its version), `runs.json` (the run's start and its "before" tree) | The run boundary has moved, and this is the only moment the *pre-run* tree exists. |
| `PreToolUse` (Bash) | before a shell command | a `bash-<session>.start` marker | A shell command can change files no tool call names, so the hook brackets it. |
| `PostToolUse` (Edit/Write/MultiEdit/NotebookEdit/Bash) | after a change | appends to `touched.jsonl` | The only signal that distinguishes the agent's edits from yours or a formatter's. |
| `Stop` | the turn ends | `stopped.json`, carrying the "after" tree | The run is over; the panel can stop guessing. |

The tree objects live *inside* `runs.json` and `stopped.json` — there is no separate file for
them. `report.json` sits in the same directory but is written by the model, not by the hook.

`UserPromptSubmit` also does one thing that is not observation: if the prompt is exactly the
**delivery token** (`redline-review`), it returns the staged batch as `additionalContext`. That
is the handover route for a session Redline cannot type into — you type one short word and the
whole batch arrives in the model's context. Nothing is injected for any other prompt.

## The tree snapshots

The single most valuable thing the plugin provides. At `UserPromptSubmit` it stages the entire
working tree into a **git tree object**:

```sh
cp "$(git rev-parse --git-path index)" "$SCRATCH"
GIT_INDEX_FILE="$SCRATCH" git add -A --ignore-errors
GIT_INDEX_FILE="$SCRATCH" git write-tree
```

Your index and working tree are untouched. The objects land in the repository unreachable, the
way `git stash create` leaves its own, and git prunes them on its usual schedule.

Copying the real index first is what makes it fast: staging 42,000 files against an empty index
takes about six seconds, against a copy of the repository's own index about one, because git's
stat cache does the work.

Two things that were learned the hard way and must not be undone:

- **`git add --ignore-errors` still exits non-zero** when a file vanishes mid-walk, which is
  the normal state of a tree an agent is working in. Catch it and write the tree anyway:
  everything that did stage is in the scratch index, and abandoning leaves the run with no
  "before" at all.
- **The scratch index needs a pid and a counter in its name.** Two sessions in one worktree ran
  this at the same time on one path and collided on git's `index.lock` — one lost its "before"
  entirely, so everything it changed was attributed to whatever came next.

With those two trees, "what did this run change" is `git diff-tree -r -M -z --name-status`:
about 20 ms, and exactly right about additions, deletions and renames. Without them it is
modification times, which cannot tell your saves from the agent's.

## The report file

The prompt asks Claude to write `report.json` next to those files:

```json
{ "notes": [ { "seq": 12, "outcome": "done", "text": "one sentence about what changed" } ] }
```

It is asked to write it **as it goes** — the whole list again each time it settles a note — not
once at the end. That is what lets a card answer within a second or two of the edit rather than
when the whole batch finishes. Redline reads it repeatedly without consuming it, and consumes it
properly only at the end of the run.

`readReport()` vs `takeReport()` is that distinction, and it matters: consuming the file
mid-run would throw away every note still to come.

A file that begins as JSON and fails to parse is treated as a **partial write** and left where
it is — the Stop hook writes it while the panel may be reading. Prose that was never JSON is
consumed, or it would be re-read forever.

## Reading it from the extension

`src/claude/` is the reading half:

| File | Reads |
|---|---|
| `hookSignals.ts` | Watches the whole `~/.claude/redline/` tree and turns writes into events. **Filters by slug** — without that, a run in any other repository woke every open window several times a second. |
| `touched.ts` | `touched.jsonl` — which files, when, by which tool. Pure, no `vscode`. |
| `runTrees.ts` | `runs.json` and `stopped.json` — the before/after tree objects, and the last five runs. |
| `handover.ts` | `hook.json` and `outbox.md` — staging a batch for a session Redline cannot type into, and the delivery token. |
| `reportFile.ts` | The report, read or consumed. |
| `transcripts.ts` | Claude Code's own JSONL transcripts — the fallback when there is no plugin, and where the run boundary comes from. |

`snapshot.ts` reads a `snapshot/` directory that a pre-0.2 hook wrote and the current one
deletes on sight. It is kept only so an old run's data still opens; nothing writes it now.

## Editing the plugin

The script is `plugin/hooks/redline-touched.mjs`, invoked by `redline-touched.sh` — 60 lines
that are worth reading before you change either: it decides synchronous versus detached from
the event name in the payload, and hunts for `node` across Homebrew, Volta and nvm, because a
hook runs in whatever environment the agent has.

There is exactly one copy of the script. There used to be a second under `resources/`, kept in
sync by a check in `npm test`, which nothing ever executed.

`src/test/unit/hook.test.ts` runs the real `.mjs` as a subprocess — a JSON payload on stdin,
`HOME` pointed at a temp directory, against a real repository — and reads its output back with
the extension's own readers, so the two halves check each other. It invokes the script
directly, so the wrapper's node-hunting and its sync/detach decision are **not** covered:
change `redline-touched.sh` and you are testing by hand. `npm run test:scenario` does
**not** exercise the hook: it reimplements the snapshot in shell and hand-writes the files, so
it tests the extension's reading, not the plugin's writing. If you change the hook, the unit
test is the one that will notice.
