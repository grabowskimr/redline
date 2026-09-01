# "What changed?"

`src/git/reviewRange.ts`, about 1,600 lines — the biggest file in the extension, and the one
that answers the question the whole product is built around. It is large because the question
is genuinely hard, not because it grew badly.

## Two questions, not one

The panel offers two scopes and they are **not** nested. Neither contains the other.

- **Everything** — what differs from the *base commit*. "Show me the whole change."
- **Last run** — what *this round* changed. "Show me what it just did about what I asked."

A file the agent created and then reverted differs from nothing at the base, so it is
legitimately absent from *Everything* while being the entire point of *Last run*. Filtering one
by the other — which the code once did — hid exactly the changes a review had just produced.

## Resolving the base

In order of preference:

1. **A baseline you pinned** (*Pin Baseline Here*). Uses `git stash create`, which writes an
   unreferenced commit and modifies nothing. Files already untracked at that moment are
   remembered separately, or they would read as "changed since the pin" forever.
2. **The commit HEAD pointed at when the Claude session started**, read from the session
   transcript — so work the agent *committed during the session* is still part of the review.
3. **The published floor** — `merge-base HEAD <upstream>`, i.e. everything this worktree has
   that the remote does not. This is what answers for anyone opening a repository cold, with no
   session to read, and it is the common case.
4. **HEAD** — every uncommitted change.

Because a commit is always compared against the working tree, all four hold even when VS Code
is opened long after the agent finished.

## Resolving the run

*Last run* needs a boundary. In order:

1. **The round you are working through** — `roundStart(store.notes)`, the oldest send you have
   not settled. This is what makes answering three cards one at a time still show all of it.
2. **Your last request**, read from the transcript.
3. **An idle-gap heuristic** (`redline.lastRunGapMinutes`) when there is no transcript.

Then the files:

- **With the plugin**: `git diff-tree` between the before and after tree objects. Exact about
  additions, deletions and renames. ~20 ms.
- **Without it**: the changed files, filtered by modification time against the run's start.
  Cannot tell your saves from the agent's, which is the honest limit of that mode.

`recentSource` on the summary says which of these answered — `hook`, `transcript` or `mtime` —
and the panel uses it to phrase things accurately.

## The performance rules

This runs constantly while an agent works. The measurements below are from a 42,000-file
monorepo and are the reason for most of the machinery in the file.

| | cost |
|---|---|
| a working-tree snapshot, warm (the index copied first) | ~1 s |
| the same, cold from an empty index | ~6 s |
| `git diff-tree` between two trees | tens of milliseconds |

Those are the figures the code's own comments record, measured on that repository. Treat them
as orders of magnitude rather than benchmarks: they are what the design is shaped around, not
numbers anything asserts.

Which produces these rules, all of them load-bearing:

- **Every git call is bounded** — 60 s by default, 30 for a snapshot, 10 for resolving the
  root. Only the snapshot ones were, and one wedged `git` —
  an index lock, a network filesystem — pinned the in-flight summary for the life of the
  window: the panel and status bar silently stopped updating with no way back but a reload.
- **One computation is shared between callers.** The panel, the status bar and the gutter all
  ask on the same signal. The in-flight promise is memoised.
- **There is a floor between recomputations** (`MIN_RECOMPUTE_MS`), and a snapshot is taken
  only when something has actually changed. An idle window takes none at all — asserted by
  `npm run test:scenario` against a real repository.
- **Fan-outs have a ceiling.** One `git diff --no-index` per changed file, all at once, is five
  hundred git processes for a five-hundred-file run. Reading both sides of every file to
  compare bytes holds both copies of each in memory at once. Both are batched.
- **`IGNORED_PATH`** keeps build output and VCS internals from triggering recomputation. It is
  a hand-written denylist, not gitignore-aware — a known limit.

## Things that will surprise you

- **`-z` everywhere.** `core.quotePath=false` does *not* stop git quoting a path containing a
  quote, a backslash or a newline. Only `-z` does. Patch headers cannot take `-z`, which is
  why `unquotePath` exists, octal escapes and all.
- **Nothing blocks on a snapshot.** `currentTree()` returns what it has and refreshes in the
  background. A panel that waits two seconds for git on every keystroke is not a panel.
- **Untrusted workspaces read no git at all.** A repository defines filters and configuration
  that git executes, so none of it runs before the user trusts the folder. That is what the
  manifest's `limited` support means.

## Changing it

Read `src/test/unit/reviewRange.test.ts` first: it builds a real repository in a temp directory
and asserts against real git — edited, created, deleted and committed files, a pinned baseline,
the untrusted refusal. Add to that. A stubbed `git` here only ever confirms what you already
believed.

For the run-scoping rules specifically, `src/git/runFiles.ts` is the pure decision
(`selectRunFiles`) lifted out of the plumbing, with its own tests. Prefer putting new rules
there over adding them to `reviewRange`.
