# Local Review — build handoff

Paste this into a fresh Claude Code session at the root of an empty directory:

> Build the VS Code extension specified in the files in this folder. Read
> `00-OVERVIEW.md`, `01-ARCHITECTURE.md`, `02-CONTRIBUTIONS.md`, `03-IMPLEMENTATION-PLAN.md`
> and `04-OUTPUT-FORMATS.md` in that order before writing any code. Then work through
> `03-IMPLEMENTATION-PLAN.md` phase by phase, stopping at the end of each phase to report
> status against its acceptance criteria. Do not skip ahead. Where the spec is ambiguous,
> make the smallest reasonable decision, implement it, and flag it in your phase report.

## What it is

A VS Code extension that gives you GitHub-PR-style inline comments, but the comments stay
local. You collect them while reading code, they show up in a side panel, and one
**Submit** action renders them all as a markdown prompt, copies it to your clipboard, and
clears the list — so you can paste it into a separate Claude Code session that does the
actual work.

## Files

| File | Contents |
|---|---|
| `00-OVERVIEW.md` | Problem, user journeys, full feature list, fixed design decisions |
| `01-ARCHITECTURE.md` | Module layout, data model, comments-API design, anchoring algorithm |
| `02-CONTRIBUTIONS.md` | Complete `package.json` contributions: commands, menus, `when` clauses, settings |
| `03-IMPLEMENTATION-PLAN.md` | Seven phases with tasks, acceptance criteria, risks |
| `04-OUTPUT-FORMATS.md` | The clipboard templates, with worked examples |

## Things worth deciding before you start

Defaults are already chosen in the spec; change them there if you disagree, rather than
mid-build.

1. **Extension name / id** — currently `local-review` / `localReview.*`.
2. **Storage location** — default is VS Code's workspace storage (out of the repo).
   `.review/notes.json` is available as a setting.
3. **Submit clears by default** — with archive + undo. Flip
   `localReview.clearAfterSubmit` if you'd rather keep the batch.
4. **One thread = one note** — replies are flattened as addenda, not modelled as
   conversations.
5. **Kinds** (`bug` / `nit` / `question` / …) are optional metadata; if you find them
   noisy, set `localReview.defaultKind: "comment"` and never touch the picker.

## Ideas added on top of your original ask

Beyond inline add + panel + submit-to-clipboard: content-based anchoring so notes survive
the agent rewriting the file, an archive + undo so submit is never destructive, suggested-change
blocks (GitHub-style) that give the agent an exact target, note kinds that shape the output,
four output templates plus a custom one, changed-lines-only mode so the `+` only appears on
lines you actually touched, next/previous walk mode, parked notes, and a preview-before-copy
step. All are marked by priority in `00-OVERVIEW.md` §6 — the must-have set is F1–F10.
