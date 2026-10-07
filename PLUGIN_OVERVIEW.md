# Redline — plugin overview

Redline is a local VS Code diff viewer for Claude Code terminal workflows. The user talks to Claude in the terminal and reviews code in the extension.

The native Changes tree has two scopes:

- **Last run:** immutable before/after snapshots of the selected session’s latest completed code-changing prompt.
- **Unreviewed:** the current file version compared with that file’s last accepted version. Acceptance is per file; files from older prompts remain until accepted. Further changes reopen them.

The view supports native themed file icons, compact folders, added/deleted line counts, session selection, next-unreviewed navigation, individual acceptance and Mark All Reviewed. A saved diff can open its editable working file without changing the saved comparison.

The Claude companion uses three hooks: UserPromptSubmit, Stop and StopFailure. Each captures a Git tree through an isolated scratch index. Runs are recorded by canonical worktree and Claude session, and Git refs retain snapshots. The viewer watches these records; it does not communicate with Claude, consume feedback, read transcripts or store replies.

Changes are attributed by prompt intervals, not by file timestamps. Rebase normalization prevents supported upstream rebases from appearing as agent edits. Concurrent edits in the same worktree may still be part of the interval. Interrupted prompts are not given a guessed final snapshot.

No separate API account or key is required. The user keeps the normal Claude Code subscription and terminal session. See [README.md](README.md) for setup, commands, limitations and settings.
