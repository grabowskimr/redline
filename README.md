# Code Redline 2.0

A lightweight VS Code viewer for changes made while you work with Claude Code in a terminal. Talk to Claude normally; open Code Redline when you want to inspect the result.

## Review your changes

Open **Code Redline: Show Changes** from the Command Palette. The native Changes view offers:

- **Last Run** — the saved before/after diff of your selected session’s latest completed code-changing prompt. Later edits do not change this comparison. A question that changes no files leaves the previous code-changing run visible.
- **Unreviewed** — current changes since each file’s last acceptance. Files left over from earlier prompts remain here. Accepting a file advances only that file’s baseline; further edits make it reappear.

Use the scope button in the view title to switch between these views. Choose a session with the plug button. Sessions are limited to repositories open in this workspace, including separate Git worktrees.

Click a file to open its saved diff. Use **Open Working File for Editing** in the row or diff editor toolbar to edit the current file. Saved comparisons remain read-only so their meaning cannot change while you review them.

In Unreviewed, check a file to accept the displayed version, or choose **Mark All Reviewed** from the view menu. Rapid clicks are batched. Acceptance checks that the file has not changed since you saw it; a newer version is left for review. **Next Unreviewed File** opens and selects the next file.

The file tree uses VS Code’s selected file icon theme and native controls. It can be moved to a sidebar using VS Code’s usual view controls.

## Set up the Claude Code recorder

Requires Git, Node.js, a trusted local workspace, and Claude Code with plugin support. No API key or separate API billing is needed: use your existing Claude Code terminal and subscription.

1. Install this VS Code extension.
2. Run **Code Redline: Set Up Claude Code Plugin**. It stages the matching bundled recorder at a stable path and opens installation commands, including replacement of an older Redline registration when detected.
3. Run those commands, restart Claude Code, and resume your session. Remove any old manually configured `redline-touched` hooks to avoid duplicate recorders.
4. Submit a prompt that changes code, wait for it to finish, and open Last Run.

For development from this repository, register the local marketplace and install/update its companion:

```sh
claude plugin marketplace add /absolute/path/to/local-review
claude plugin install redline@redline
# If already installed from this local marketplace:
claude plugin update redline@redline
```

The VS Code extension and companion both use version **2.0.0**. Restart Claude after updating the companion; an already running session may still hold the old hook configuration.

## How it works

Three boundary hooks (`UserPromptSubmit`, `Stop`, `StopFailure`) capture Git trees before and after a prompt. Scratch indexes keep the real index and working tree untouched. This covers tracked edits, added and deleted files, renames, binaries, executable permissions, and files created by shell commands. Git-ignored untracked files follow Git’s ignore rules and are not included.

Records live under `~/.claude/redline/repo-<hash>/runs.json`, isolated by worktree and session. Snapshot and acceptance refs live under `refs/redline/` in the repository. They preserve saved content across ordinary Git garbage collection. Unreviewed acceptance is shared between VS Code windows for the same worktree and review base.

The extension watches the run record and refreshes the visible view. It does not scan transcripts, poll agent processes, inject prompts, read answers, or connect to a terminal. Opening a listed file uses the already displayed snapshot, without rescanning the working tree.

## Boundaries to know

- Last Run describes filesystem changes between the prompt boundaries. Edits made manually or by another process in the same worktree during that interval can be included. Use separate worktrees for concurrent agents.
- When Claude reports background tasks still in flight, the recorder waits for a later Stop with no pending tasks. A long-running monitor can therefore keep the prompt pending.
- An interrupted prompt has no normal Stop boundary. Its partial edits remain available in Unreviewed; they are not attributed to the next completed prompt.
- Supported rebases are removed from the Last Run comparison. If a rebase is unfinished or cannot be separated safely, the viewer reports that the comparison is unavailable.
- Unreviewed includes current branch and working-tree changes, including your own edits. Its initial baseline is the review base, not only the last Claude prompt. A different branch/base has its own acceptance baseline.
- Unsaved editor changes are included in Unreviewed. Claude’s boundary snapshots reflect disk content.
- Deleted files retain their saved diff but cannot be opened for editing unless an existing dirty buffer still exists. Submodule content is not compared as a regular file.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `redline.reviewBase` | `auto` | Unreviewed starts at the default branch merge-base. Set a ref such as `origin/main` explicitly. In a local-only repository, auto keeps the recorded pre-run HEAD (or first observed HEAD) as the review base. |
| `redline.showStatusBar` | `true` | Show the current file count and a shortcut to the viewer. |
| `redline.trace` | `errors` | Output channel verbosity: `off`, `errors`, or `verbose`. |

## Upgrading from 1.x

2.0 replaces the notes/chat panel with a native diff viewer. Inline comments, editor plus buttons, feedback delivery, Claude replies, chat controls, GitHub comment forwarding, and Everything have been removed. Existing run records and acceptance refs remain readable. Old note/outbox files are left untouched but are never consumed by the 2.0 recorder.

After installing the VSIX, run **Developer: Reload Window** once. Restarting only the extension host can leave the old Notes view registered and cause `redline.changes.focus` to be missing. Version 2.0.1 offers a **Reload Window** action when this happens. This extension fix still uses the 2.0.0 Claude Code companion.

## Development

```sh
npm ci
npm test
npm run lint
npm run test:integration
npm run package
```

Integration tests use an isolated VS Code profile and temporary workspace. They do not contact your live Claude sessions.
