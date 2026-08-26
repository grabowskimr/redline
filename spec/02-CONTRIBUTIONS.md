# package.json contributions

This is the contract between the UI and the code. Implement it as written; the `when`
clauses in particular are easy to get subtly wrong.

## 1. Commands

| id | title (Category: `Local Review`) | icon | invoked from |
|---|---|---|---|
| `localReview.createNote` | Add Note | `$(add)` | comment widget (empty thread) |
| `localReview.addAddendum` | Add Follow-up | `$(reply)` | comment widget (existing thread) |
| `localReview.editComment` | Edit | `$(edit)` | comment title menu |
| `localReview.saveComment` | Save | `$(check)` | comment title menu (editing mode) |
| `localReview.cancelEdit` | Cancel | `$(close)` | comment title menu (editing mode) |
| `localReview.deleteNote` | Delete Note | `$(trash)` | thread title menu + tree |
| `localReview.setKind` | Set Kind… | `$(tag)` | thread title menu + tree |
| `localReview.addSuggestion` | Add Suggested Change… | `$(diff)` | thread title menu + tree |
| `localReview.toggleDone` | Toggle Done | `$(check)` | tree |
| `localReview.toggleIncluded` | Include / Park | `$(circle-slash)` | tree |
| `localReview.quickAddNote` | Add Note at Cursor (Quick Input) | — | palette / keybinding |
| `localReview.revealNote` | Reveal Note | — | tree click |
| `localReview.nextNote` / `.prevNote` | Go to Next / Previous Note | `$(arrow-down)` / `$(arrow-up)` | palette / keybinding |
| `localReview.submit` | Submit & Copy to Clipboard | `$(cloud-upload)` | view title, palette |
| `localReview.previewBatch` | Preview Batch | `$(preview)` | view title, palette |
| `localReview.copyNote` | Copy This Note | `$(copy)` | tree item |
| `localReview.copyFileNotes` | Copy Notes for This File | `$(copy)` | tree group |
| `localReview.clearAll` | Clear All Notes | `$(clear-all)` | view title |
| `localReview.restoreLastBatch` | Restore Last Submitted Batch | `$(history)` | palette, toast action |
| `localReview.exportToFile` | Export Batch to File… | — | palette |
| `localReview.setGrouping` | Group By… | `$(list-tree)` | view title |
| `localReview.setFilter` | Filter Notes… | `$(filter)` | view title |
| `localReview.clearFilter` | Clear Filter | `$(filter-filled)` | view title (when filter active) |
| `localReview.reanchorNote` | Re-anchor at Cursor | `$(pin)` | tree (orphan items) |
| `localReview.showLog` | Show Log | — | palette |

## 2. Views

```jsonc
"viewsContainers": {
  "activitybar": [{
    "id": "localReview",
    "title": "Local Review",
    "icon": "resources/icon.svg"        // a speech-bubble-with-code glyph, monochrome
  }]
},
"views": {
  "localReview": [{
    "id": "localReview.notes",
    "name": "Review Notes",
    "contextualTitle": "Local Review",
    "icon": "resources/icon.svg"
  }]
},
"viewsWelcome": [{
  "view": "localReview.notes",
  "contents": "No review notes yet.\n\nOpen a file and click the ➕ that appears in the gutter when you hover a line, or select lines and press [Add Note](command:localReview.quickAddNote).\n\nWhen you're done, [Submit](command:localReview.submit) copies everything to your clipboard as one markdown prompt and clears the list."
}]
```

## 3. Menus

```jsonc
"menus": {
  // ── inline comment widget ────────────────────────────────────────────────
  "comments/commentThread/context": [
    {
      "command": "localReview.createNote",
      "group": "inline@1",
      "when": "commentController == localReview.notes && commentThreadIsEmpty"
    },
    {
      "command": "localReview.addAddendum",
      "group": "inline@1",
      "when": "commentController == localReview.notes && !commentThreadIsEmpty"
    }
  ],
  "comments/commentThread/title": [
    {
      "command": "localReview.setKind",
      "group": "navigation@1",
      "when": "commentController == localReview.notes && !commentThreadIsEmpty"
    },
    {
      "command": "localReview.addSuggestion",
      "group": "navigation@2",
      "when": "commentController == localReview.notes && !commentThreadIsEmpty"
    },
    {
      "command": "localReview.deleteNote",
      "group": "navigation@3",
      "when": "commentController == localReview.notes && !commentThreadIsEmpty"
    }
  ],
  "comments/comment/title": [
    {
      "command": "localReview.editComment",
      "group": "group@1",
      "when": "commentController == localReview.notes && comment == localReview.comment"
    },
    {
      "command": "localReview.deleteNote",
      "group": "group@2",
      "when": "commentController == localReview.notes && comment == localReview.comment"
    }
  ],
  "comments/comment/context": [
    {
      "command": "localReview.saveComment",
      "group": "inline@1",
      "when": "commentController == localReview.notes"
    },
    {
      "command": "localReview.cancelEdit",
      "group": "inline@2",
      "when": "commentController == localReview.notes"
    }
  ],

  // ── panel ────────────────────────────────────────────────────────────────
  "view/title": [
    { "command": "localReview.submit",       "when": "view == localReview.notes && localReview.hasNotes", "group": "navigation@1" },
    { "command": "localReview.previewBatch", "when": "view == localReview.notes && localReview.hasNotes", "group": "navigation@2" },
    { "command": "localReview.setFilter",    "when": "view == localReview.notes && !localReview.filterActive", "group": "navigation@3" },
    { "command": "localReview.clearFilter",  "when": "view == localReview.notes && localReview.filterActive",  "group": "navigation@3" },
    { "command": "localReview.setGrouping",  "when": "view == localReview.notes", "group": "1_config@1" },
    { "command": "localReview.clearAll",     "when": "view == localReview.notes && localReview.hasNotes", "group": "9_danger@1" },
    { "command": "localReview.restoreLastBatch", "when": "view == localReview.notes && localReview.hasArchive", "group": "1_config@2" }
  ],
  "view/item/context": [
    { "command": "localReview.toggleDone",   "when": "view == localReview.notes && viewItem =~ /^localReview.note/", "group": "inline@1" },
    { "command": "localReview.copyNote",     "when": "view == localReview.notes && viewItem =~ /^localReview.note/", "group": "inline@2" },
    { "command": "localReview.deleteNote",   "when": "view == localReview.notes && viewItem =~ /^localReview.note/", "group": "inline@3" },
    { "command": "localReview.setKind",      "when": "view == localReview.notes && viewItem =~ /^localReview.note/", "group": "1_edit@1" },
    { "command": "localReview.toggleIncluded","when": "view == localReview.notes && viewItem =~ /^localReview.note/", "group": "1_edit@2" },
    { "command": "localReview.reanchorNote", "when": "view == localReview.notes && viewItem == localReview.orphan", "group": "inline@1" },
    { "command": "localReview.copyFileNotes","when": "view == localReview.notes && viewItem == localReview.group", "group": "inline@1" }
  ],

  // ── editor ───────────────────────────────────────────────────────────────
  "editor/context": [
    { "command": "localReview.quickAddNote", "when": "editorTextFocus", "group": "1_localReview@1" }
  ],
  "commandPalette": [
    { "command": "localReview.createNote",  "when": "false" },
    { "command": "localReview.addAddendum", "when": "false" },
    { "command": "localReview.saveComment", "when": "false" },
    { "command": "localReview.cancelEdit",  "when": "false" },
    { "command": "localReview.editComment", "when": "false" },
    { "command": "localReview.revealNote",  "when": "false" }
  ]
}
```

Context keys the extension must maintain via `setContext`:
`localReview.hasNotes`, `localReview.hasArchive`, `localReview.filterActive`,
`localReview.grouping` (string).

## 4. Keybindings

```jsonc
"keybindings": [
  { "command": "localReview.quickAddNote", "key": "ctrl+alt+m", "mac": "cmd+alt+m", "when": "editorTextFocus" },
  { "command": "localReview.submit",       "key": "ctrl+alt+s", "mac": "cmd+alt+s", "when": "localReview.hasNotes" },
  { "command": "localReview.nextNote",     "key": "alt+f8" },
  { "command": "localReview.prevNote",     "key": "shift+alt+f8" }
]
```

`Cmd+Enter` inside the widget is handled by VS Code and maps to the first `inline` group
action of `comments/commentThread/context` — i.e. `createNote`. No custom binding needed.

## 5. Settings

```jsonc
"configuration": {
  "title": "Local Review",
  "properties": {
    "localReview.storage": {
      "type": "string", "enum": ["workspaceStorage", "workspaceFolder"],
      "default": "workspaceStorage",
      "markdownDescription": "Where notes are persisted. `workspaceStorage` keeps them out of your repo; `workspaceFolder` writes `.review/notes.json` (the extension will offer to add it to `.git/info/exclude`)."
    },
    "localReview.outputTemplate": {
      "type": "string", "enum": ["claude-prompt", "checklist", "json", "plain", "custom"],
      "default": "claude-prompt",
      "description": "Format used when submitting or previewing a batch."
    },
    "localReview.customTemplate": {
      "type": "object", "default": {},
      "markdownDescription": "Used when `#localReview.outputTemplate#` is `custom`. Keys: `header`, `fileHeader`, `note`, `footer`. See the README for available placeholders."
    },
    "localReview.includeSnippet": { "type": "boolean", "default": true,
      "description": "Include the referenced source lines in the output." },
    "localReview.snippetContextLines": { "type": "number", "default": 0, "minimum": 0, "maximum": 20,
      "description": "Extra lines of context above and below the snippet." },
    "localReview.includeGitContext": { "type": "boolean", "default": true,
      "description": "Include branch and commit SHA in the output header." },
    "localReview.clearAfterSubmit": { "type": "boolean", "default": true },
    "localReview.confirmOnSubmit": { "type": "boolean", "default": true },
    "localReview.archiveLimit": { "type": "number", "default": 20 },
    "localReview.defaultKind": { "type": "string", "default": "comment",
      "enum": ["comment","bug","nit","question","refactor","perf","security","todo","praise"] },
    "localReview.askForKindOnCreate": { "type": "boolean", "default": false,
      "description": "Prompt for a note kind every time a note is created." },
    "localReview.grouping": { "type": "string", "enum": ["file","kind","time","flat"], "default": "file" },
    "localReview.changedLinesOnly": { "type": "boolean", "default": false,
      "description": "Only allow notes on lines changed relative to the base ref." },
    "localReview.baseRef": { "type": "string", "default": "",
      "description": "Base ref for changed-lines mode. Empty means diff against HEAD (uncommitted changes)." },
    "localReview.allowNotesOnBaseSide": { "type": "boolean", "default": false,
      "description": "Allow notes on the left/original side of a diff editor." },
    "localReview.excludeGlobs": { "type": "array", "items": { "type": "string" },
      "default": ["**/node_modules/**", "**/dist/**", "**/*.min.*", "**/.git/**"] },
    "localReview.maxFileLines": { "type": "number", "default": 50000 },
    "localReview.showStatusBar": { "type": "boolean", "default": true },
    "localReview.trace": { "type": "string", "enum": ["off","errors","verbose"], "default": "errors" }
  }
}
```

## 6. Other manifest fields

```jsonc
{
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other", "SCM Providers", "Notebooks"],
  "keywords": ["review", "comments", "annotations", "claude", "ai", "notes"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "capabilities": {
    "untrustedWorkspaces": { "supported": true },
    "virtualWorkspaces": { "supported": "limited", "description": "Git context is unavailable in virtual workspaces." }
  }
}
```

The extension does no code execution and no network I/O, so untrusted workspaces are fine.
