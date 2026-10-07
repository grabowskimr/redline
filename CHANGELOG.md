# Changelog

## 1.0.0

First Marketplace release.

- **Last Run** shows what Claude Code changed in your session’s latest completed prompt, as a saved before/after diff in VS Code’s native diff editor.
- **Unreviewed** lists every file changed since you last accepted it, across prompts, with per-file and bulk acceptance and Next Unreviewed File.
- A bundled Claude Code companion records each prompt’s boundaries with three hooks (`UserPromptSubmit`, `Stop`, `StopFailure`), isolated per session and worktree. Changes pulled in by a rebase are kept out of Last Run.
- **Open Working File for Editing** jumps from a saved diff to the live file.
- Native file icons, compact folders, line counts, and a session picker.
