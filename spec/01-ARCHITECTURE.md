# Architecture

## 1. Module layout

```
local-review/
├── package.json                  # contributions — see 02-CONTRIBUTIONS.md
├── tsconfig.json
├── esbuild.js
├── .vscodeignore
├── README.md
├── CHANGELOG.md
└── src/
    ├── extension.ts              # activate/deactivate, DI wiring, disposables
    ├── config.ts                 # typed accessor over workspace configuration
    ├── logger.ts                 # OutputChannel wrapper, `localReview.trace` setting
    ├── model/
    │   ├── note.ts               # ReviewNote, NoteKind, NoteAnchor, Batch types + guards
    │   ├── ids.ts                # nanoid-ish id generator (no dep: crypto.randomUUID)
    │   └── schema.ts             # persisted-file schema + version + migrations
    ├── store/
    │   ├── reviewStore.ts        # single source of truth; CRUD + onDidChange event
    │   ├── persistence.ts        # load/save JSON, debounce, atomic write
    │   └── archive.ts            # submitted batches, restore
    ├── anchor/
    │   ├── anchorService.ts      # create/resolve/repair anchors
    │   └── liveTracker.ts        # onDidChangeTextDocument range transforms
    ├── comments/
    │   ├── commentHost.ts        # CommentController lifecycle, thread<->note sync
    │   ├── rangeProvider.ts      # commentingRangeProvider (+ changed-lines-only mode)
    │   ├── threadFactory.ts      # build CommentThread / NoteComment objects
    │   └── noteComment.ts        # class NoteComment implements vscode.Comment
    ├── view/
    │   ├── notesTreeProvider.ts  # TreeDataProvider, grouping strategies
    │   ├── treeItems.ts          # BatchItem / GroupItem / NoteItem / OrphanItem
    │   ├── statusBar.ts
    │   └── decorations.ts        # optional overview-ruler marks
    ├── export/
    │   ├── formatters/
    │   │   ├── claudePrompt.ts   # default template
    │   │   ├── checklist.ts
    │   │   ├── json.ts
    │   │   └── custom.ts         # user template string interpolation
    │   ├── renderBatch.ts        # picks formatter, assembles header + sections
    │   └── submit.ts             # render → clipboard → archive → clear → toast/undo
    ├── git/
    │   ├── gitApi.ts             # access built-in vscode.git extension, degrade gracefully
    │   └── changedLines.ts       # diff vs base ref → line ranges (for F22)
    ├── commands/
    │   ├── index.ts              # registerAllCommands(ctx, deps)
    │   ├── noteCommands.ts       # add/edit/delete/toggleDone/setKind/addSuggestion
    │   ├── batchCommands.ts      # submit/preview/clearAll/restore/export
    │   └── navCommands.ts        # revealNote/nextNote/prevNote/filter
    └── test/
        ├── unit/                 # store, anchor, formatters (mocha, no vscode host)
        └── integration/          # @vscode/test-electron
```

**Dependency rule:** `store` and `export` and `anchor` must not import `vscode` types
beyond `Range`/`Uri`-shaped plain structures, so they are unit-testable. Do this by
defining local `SerialRange { startLine, startChar, endLine, endChar }` in `model/note.ts`
and converting at the boundary (`comments/`, `view/`).

## 2. Data model

```ts
// model/note.ts

export type NoteKind =
  | 'comment' | 'bug' | 'nit' | 'question'
  | 'refactor' | 'perf' | 'security' | 'todo' | 'praise';

export interface SerialRange {
  startLine: number;   // 0-based, matches vscode.Position
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface NoteAnchor {
  /** Exact text of the anchored lines at creation time. */
  snippet: string;
  /** sha1 of `snippet` after whitespace normalisation. */
  snippetHash: string;
  /** Up to 3 lines above/below, used for disambiguation when snippet repeats. */
  contextBefore: string[];
  contextAfter: string[];
  /** Line where it was last successfully resolved — the search starting point. */
  lineHint: number;
  /** Set when resolution failed; note is shown in the orphan group. */
  orphaned?: boolean;
}

export interface ReviewNote {
  id: string;                    // crypto.randomUUID()
  /** Workspace-folder-relative posix path. */
  path: string;
  /** Name of the workspace folder (multi-root disambiguation). */
  workspaceFolder?: string;
  range: SerialRange;
  anchor: NoteAnchor;
  /** Markdown. May be multi-paragraph. */
  body: string;
  /** Follow-up comments added inside the same thread; appended on export. */
  addenda: string[];
  kind: NoteKind;
  /** Fenced code the agent should apply verbatim at `range`. */
  suggestion?: string;
  /** Parked notes are kept but excluded from submit. */
  included: boolean;
  done: boolean;
  order: number;                 // for manual reordering (F26)
  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  /** Git snapshot at creation, best-effort. */
  git?: { branch?: string; sha?: string; dirty?: boolean };
}

export interface Batch {
  id: string;
  name: string;                  // default: 'default'
  notes: ReviewNote[];
  createdAt: string;
  submittedAt?: string;
}
```

Persisted file (`storageUri/notes.json`):

```jsonc
{
  "version": 1,
  "active": { /* Batch */ },
  "archive": [ /* Batch[], newest first, capped at 20 */ ]
}
```

`schema.ts` exposes `migrate(raw: unknown): PersistedState` — unknown/newer versions must
fail *soft*: log, back up the file to `notes.corrupt-<ts>.json`, start empty. Never throw
during activation.

## 3. ReviewStore

Single source of truth. Everything else subscribes.

```ts
export interface StoreChange {
  type: 'add' | 'update' | 'delete' | 'clear' | 'restore' | 'reload';
  noteIds: string[];
}

export class ReviewStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<StoreChange>();
  readonly onDidChange = this._onDidChange.event;

  get notes(): readonly ReviewNote[];
  getById(id: string): ReviewNote | undefined;
  byPath(path: string): ReviewNote[];

  add(input: NewNoteInput): ReviewNote;
  update(id: string, patch: Partial<ReviewNote>): void;
  delete(ids: string[]): void;
  clear(): void;

  /** Moves active batch to archive, returns it. */
  archiveActive(): Batch;
  restore(batchId?: string): void;   // default: newest archived
}
```

Persistence is **debounced 300 ms** and written atomically (write `notes.json.tmp`,
then `fs.rename`). Save immediately on `deactivate()`.

## 4. Comment host (the inline UX)

This is the part to get right; it's what makes it feel like the GitHub PR extension.

```ts
// comments/commentHost.ts
const controller = vscode.comments.createCommentController(
  'localReview.notes',
  'Local Review'
);
controller.options = {
  prompt: 'Leave a review note for Claude Code…',
  placeHolder: 'What should change here?'
};
controller.commentingRangeProvider = new RangeProvider(config, changedLines);
```

### 4.1 Commenting range provider (the `+` icon)

```ts
provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] | undefined {
  if (!isSupported(document)) return undefined;            // scheme + size guards
  if (config.changedLinesOnly && changedLines.has(document.uri)) {
    return changedLines.rangesFor(document.uri);           // F22
  }
  return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
}
```

`isSupported`: allow schemes `file`, `git`, `vscode-vfs`, `untitled` is excluded; skip
documents over `localReview.maxFileLines` (default 50_000); respect
`localReview.excludeGlobs`.

### 4.2 Thread ↔ note synchronisation

- **Note created** (`localReview.createNote` invoked from the widget's submit button,
  arg is `vscode.CommentReply { thread, text }`):
  1. `anchorService.create(document, thread.range)` → `NoteAnchor`
  2. `store.add({ … })`
  3. mutate the same thread in place: set `thread.comments = [new NoteComment(note)]`,
     `thread.label`, `thread.contextValue = 'localReview.note'`,
     `thread.collapsibleState = Collapsed`, and register it in the `threadsByNoteId` map.
     **Do not dispose and recreate** — recreating makes the widget flicker/close.
- **Note updated from tree** → find thread, update `comments` array (must reassign the
  array for VS Code to re-render; mutating in place does nothing).
- **Note deleted** → `thread.dispose()`, remove from map.
- **Editor opened** (`onDidChangeVisibleTextEditors`) → materialise threads for that URI
  lazily; dispose threads for URIs no longer visible only if `config.disposeHiddenThreads`
  (default false — keeping them is cheap and avoids re-anchor churn).
- **Store cleared** → dispose all threads, clear the map.

Keep a bidirectional map:

```ts
private threadsByNoteId = new Map<string, vscode.CommentThread>();
private noteIdByThread  = new WeakMap<vscode.CommentThread, string>();
```

### 4.3 NoteComment

```ts
export class NoteComment implements vscode.Comment {
  body: vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: 'You' };
  label?: string;              // e.g. 'bug'  → shown next to the author
  contextValue = 'localReview.comment';   // drives comments/comment/title menu
  timestamp?: Date;
  constructor(public readonly noteId: string, note: ReviewNote) { … }
}
```

Set `comment.mode = CommentMode.Editing` for the edit flow, then reassign
`thread.comments = [...thread.comments]` to force a re-render.

Render the body as a `MarkdownString` with `isTrusted = false`, `supportHtml = false`.
Prefix with a kind badge, e.g. `**🐞 bug** · L142-150`.

### 4.4 Empty-thread affordance

When the user clicks `+`, VS Code creates an empty thread and sets context
`commentThreadIsEmpty == true`. The widget's action buttons come from the
`comments/commentThread/context` menu; gate the "create" command on
`commentController == localReview.notes && commentThreadIsEmpty`, and the "reply/addendum"
command on `!commentThreadIsEmpty`. See `02-CONTRIBUTIONS.md` for exact `when` clauses.

Also handle the **cancel** case: if the user opens an empty thread and dismisses it, VS
Code disposes it; nothing to do. But guard `createNote` against empty `reply.text` —
show a warning instead of creating a blank note.

## 5. Tree view

`TreeDataProvider<TreeNode>` where

```ts
type TreeNode =
  | { kind: 'group';  key: string; label: string; noteIds: string[] }
  | { kind: 'note';   noteId: string }
  | { kind: 'empty' };
```

- Grouping strategies: `file` (default), `kind`, `time`, `flat`. Stored in workspace state,
  toggled from the view title menu; reflected via a context key so the active one is
  checked in the menu.
- Orphaned notes always render in a pinned first group `⚠ Needs re-anchoring`.
- `TreeItem`:
  - `label` = first line of body, truncated to 80 chars
  - `description` = `L{start+1}` or `L{start+1}-{end+1}` plus `✓` if done
  - `tooltip` = MarkdownString with full body, kind, snippet in a fenced block, timestamps
  - `iconPath` = `ThemeIcon` per kind (`bug`, `light-bulb`, `question`, `symbol-method`,
    `dashboard`, `shield`, `checklist`, `heart`, `comment`)
  - `contextValue` = `localReview.note` / `localReview.note.done` / `localReview.orphan`
  - `command` = `localReview.revealNote` with the note id
- Empty state: use `viewsWelcome` in `package.json` with a short blurb + an
  "Open a file and click the + in the gutter" hint and a `Learn more` link to the README.
- Badge: set `treeView.badge = { value: activeCount, tooltip: '…' }`.

## 6. Anchoring

Two layers.

### 6.1 Live tracking (document is open and being edited)

`liveTracker.ts` listens to `workspace.onDidChangeTextDocument` and transforms every
stored range for that document through the content changes:

```
for each change (in reverse document order):
  linesDelta = countLines(change.text) - (change.range.end.line - change.range.start.line)
  if change.range.end.line < note.startLine   → shift note by linesDelta
  else if overlaps(change.range, note.range)  → mark note dirty (re-anchor on idle)
  else                                        → untouched
```

Debounce a re-anchor pass 500 ms after the last change for dirty notes only.

Note: VS Code already moves `CommentThread.range` for open editors, so on save read back
`thread.range` and reconcile it into the store. Treat `thread.range` as authoritative when
the thread exists; the tracker is the fallback for files edited while not visible (e.g. by
Claude Code in a terminal).

### 6.2 Content re-anchor (file changed on disk / on load)

`anchorService.resolve(document, anchor): SerialRange | undefined`

1. If the text at `anchor.lineHint` still hashes to `snippetHash` → done (fast path).
2. Search ±`searchRadius` (default 200) lines around `lineHint` for an exact
   whitespace-normalised match. If exactly one → done.
3. If multiple matches, score by similarity of `contextBefore`/`contextAfter`; take the
   best if its score beats the runner-up by a margin.
4. Whole-file exact search, same scoring.
5. Fuzzy: token-based similarity (trigram / Jaccard over identifier tokens) with a
   threshold of 0.6; accept only a clear winner.
6. Otherwise → `anchor.orphaned = true`, keep last known range for display.

Run resolution on: `onDidOpenTextDocument`, `onDidSaveTextDocument`, and a
`workspace.createFileSystemWatcher('**/*')` change event for files with notes (throttled).
Also handle `onDidRenameFiles` / `onDidDeleteFiles` → rewrite `note.path` or orphan.

Keep the algorithm in a pure module with unit tests — this is the highest-risk logic.

## 7. Git integration

```ts
const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
const api = gitExt?.isActive ? gitExt.exports.getAPI(1) : (await gitExt?.activate())?.getAPI(1);
```

Everything git-related is best-effort; if the extension is missing or the workspace isn't
a repo, features F15/F22 silently no-op. Never block activation on it.

For F22 (changed lines only), use `repository.diffWithHEAD(path)` or
`repository.diffBetween(base, 'HEAD', path)` and parse the unified diff hunk headers
(`@@ -a,b +c,d @@`) into ranges.

## 8. Diff editor support

In a diff editor the left side has scheme `git` with a query like
`{"path":"/abs/path","ref":"HEAD"}`. Rules:

- Right side (`file` scheme) → normal note, full functionality.
- Left side (`git` scheme) → allow notes, but resolve `note.path` from the query's `path`
  field and mark `note.side = 'base'` in the body header on export
  (`in the pre-change version of`). Consider simply **disabling** the `+` on the left side
  in v1 (`localReview.allowNotesOnBaseSide: false` default) — simpler and rarely needed.

## 9. Activation & performance

- `activationEvents`: `onStartupFinished` only. Do not use `*`.
- Load `notes.json` async; render the tree from an empty state first, then refresh.
- Materialise comment threads only for visible editors.
- All event handlers pushed into `context.subscriptions`.
- Guard against very large files in the range provider.

## 10. Error handling & telemetry

- No telemetry. State this in the README.
- An `OutputChannel` named `Local Review`, verbosity via `localReview.trace`
  (`off | errors | verbose`).
- Any caught error: log + a single non-modal warning toast with a `Show log` action.
  Never let a failed anchor resolution or a corrupt file break the editor session.
