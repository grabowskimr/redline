import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { Attachments } from '../attachments';
import { Logger } from '../logger';
import {
  firstLine,
  formatLineRange,
  hasUnsentReply,
  isOpen,
  KIND_META,
  KINDS_BY_WEIGHT,
  NoteKind,
  ReviewNote,
} from '../model/note';
import { readStopMarker } from '../claude/runTrees';
import { parseDroppedPaths } from '../dnd/dropPayload';
import { ReviewStore } from '../store/reviewStore';
import { NoteIndex } from './noteIndex';
import { uriForNote } from '../comments/uriMapping';
import { SessionWatcher } from '../claude/sessionWatcher';
import { HookSignals } from '../claude/hookSignals';
import { ReviewRange } from '../git/reviewRange';
import { findTargets, isReachable } from '../claude/claudeSession';

export const CARDS_VIEW_ID = 'redline.cards';

/**
 * Backstop only. The hook pushes a signal the moment the agent touches a file, and the file
 * watcher covers your own edits, so this exists purely for the case where neither fires.
 */
const SESSION_REFRESH_MS = 30_000;

/** Plain data handed to the webview (no vscode types cross the boundary). */
interface CardData {
  id: string;
  seq: number;
  kind: NoteKind;
  kindIcon: string;
  kindLabel: string;
  /** The kind's colour, so ten of them stay apart at icon size. */
  kindColor: string;
  /** `SurveyList.tsx:10` — every card names its own file, since they come from many. */
  fileRef: string;
  /** First line the snippet starts at, for the gutter beside it. */
  firstLine: number;
  /** Turned down: waiting for another attempt rather than for a reader. */
  rejected?: boolean;
  body: string;
  addenda: string[];
  suggestion?: string;
  snippet: string;
  language: string;
  where: string;
  done: boolean;
  orphaned: boolean;
  /** The file the note points at is no longer on disk. */
  missing?: boolean;
  attachments: Array<{ src: string; path: string; name: string; caption: string; followUp: boolean }>;
  sent?: { outcome?: string; reply?: string; changed: boolean; seenTurns?: number };
  /** A reply is written but not sent: the card stays active and offers ➤. */
  pendingReply?: boolean;
  /** Sent, and Claude has not reported on it yet. */
  awaiting?: boolean;
}


interface SessionInfo {
  label: string;
  state: 'off' | 'idle' | 'working';
  changedFiles?: number;
  rangeLabel?: string;
  olderCount?: number;
  /** Everything changed since the base — what "All" opens. */
  totalFiles?: number;
  /** The file list could not be read — the panel must not render this as "nothing changed". */
  changesUnavailable?: boolean;
  /** Notes waiting for the agent to finish before they go. */
  queued?: number;
}

interface InboundMessage {
  type: string;
  id?: string;
  command?: string;
  kind?: string;
  text?: string;
  name?: string;
  data?: string;
  uris?: string;
}

/**
 * The Review Notes panel. Notes are posted immediately; session/git information is
 * gathered separately and best-effort, so a slow or failing lookup can never leave the
 * panel empty.
 */
export class CardsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private viewSubs: vscode.Disposable[] = [];
  private notesTimer: NodeJS.Timeout | undefined;
  private readonly sessionTimer: NodeJS.Timeout;
  private messageChain: Promise<unknown> = Promise.resolve();
  private shiftHintShown = false;
  private lastSessionLabel = '';
  /** Resolves the first time the webview script reports in — proves the panel booted. */
  private readyResolve: (() => void) | undefined;
  readonly whenReady = new Promise<void>((resolve) => (this.readyResolve = resolve));

  /** Wired after construction (these depend on the store/host being built first). */
  attachments: Attachments | undefined;
  /** Set after construction; the hook signals say whether a run is in flight. */
  signals: HookSignals | undefined;
  watcher: SessionWatcher | undefined;
  range: ReviewRange | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReviewStore,
    private readonly index: NoteIndex,
    private readonly logger: Logger,
  ) {
    this.subs.push(
      store.onDidChange(() => this.postNotesSoon()),
      index.onDidChange(() => this.postNotesSoon()),
    );
    this.sessionTimer = setInterval(() => void this.postSession(), SESSION_REFRESH_MS);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // A view can be resolved again (moved to another container); drop the old listeners.
    for (const s of this.viewSubs) s.dispose();
    this.viewSubs = [];
    this.view = view;
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    if (this.attachments) roots.push(this.attachments.dir);
    view.webview.options = { enableScripts: true, localResourceRoots: roots };
    view.webview.html = this.html(view.webview);
    this.viewSubs.push(
      view.webview.onDidReceiveMessage((m: InboundMessage) => {
        // Pasting several images posts several 'attach' messages whose read-modify-writes
        // of note.attachments would clobber each other, so those are serialized. Everything
        // else runs straight away: commands can open modal UI, and queueing behind them
        // would swallow later edits.
        if (m.type === 'attach' || m.type === 'attachPaths') {
          this.messageChain = this.messageChain
            .then(() => this.onMessage(m))
            .catch((err) => this.logger.warn('panel message failed', err));
        } else {
          void this.onMessage(m).catch((err) => this.logger.warn('panel message failed', err));
        }
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.postNotes();
          void this.postSession();
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
  }

  // ── outbound ─────────────────────────────────────────────────────────

  private postNotesSoon(): void {
    if (this.notesTimer) clearTimeout(this.notesTimer);
    this.notesTimer = setTimeout(() => {
      this.notesTimer = undefined;
      this.postNotes();
      void this.postSession();
      // Off the render path: it re-posts only if the answer moved.
      void this.refreshMissing();
    }, 60);
  }

  /** Cheap, synchronous, cannot fail: the notes themselves. */
  postNotes(): void {
    const view = this.view;
    if (!view) return;
    try {
      const open = this.store.notes.filter(isOpen).length;
      view.badge =
        open > 0 ? { value: open, tooltip: `${open} pending review note${open === 1 ? '' : 's'}` } : undefined;
      if (!view.visible) return;
      void view.webview.postMessage({
        type: 'notes',
        cards: this.cards(),
        sent: this.store.notes.filter((n) => n.sent).map((n) => this.card(n)),
        kinds: KINDS_BY_WEIGHT.map((k) => ({ kind: k, icon: KIND_META[k].themeIcon, label: KIND_META[k].label })),
      });
    } catch (err) {
      this.logger.error('failed to post notes to the panel', err);
    }
  }

  /** Best-effort: spawns git/ps. Never blocks or breaks the notes rendering. */
  /** What the session is doing right now, pushed as the hook reports it. */
  postActivity(activity: { running: boolean; file?: string; files?: number }): void {
    const view = this.view;
    if (!view?.visible) return;
    void view.webview.postMessage({ type: 'activity', activity });
  }

  async postSession(): Promise<void> {
    const view = this.view;
    if (!view?.visible) return;
    let info: SessionInfo = { label: this.lastSessionLabel, state: this.sessionState() };
    try {
      info = await this.sessionInfo();
    } catch (err) {
      this.logger.warn('session info failed', err);
    }
    try {
      await view.webview.postMessage({ type: 'session', session: info });
    } catch {
      // the view went away between the check and the post
    }
  }

  /** How many notes are waiting for Claude to be free, from whatever knows. */
  queuedCount: () => number = () => 0;

  private async sessionInfo(): Promise<SessionInfo> {
    let label = this.watcher?.label ?? '';
    const targets = await findTargets(this.logger);
    const here = targets.find((t) => t.inWorkspace && isReachable(t));
    if (here) this.range?.addCwdHint(here.cwd);
    if (!label) label = here?.label ?? '';
    // A session Redline can see but not reach — Claude Code in iTerm, tmux, or any terminal
    // outside this window. It still drives the change figures beside this label, and saying
    // nothing made the panel look disconnected while it was tracking the run perfectly well.
    if (!label) {
      const outside = targets.find((t) => t.inWorkspace);
      if (outside) label = `${outside.label} (outside VS Code)`;
      else if (await this.hookIsLive()) label = 'Claude Code (via the plugin)';
    }
    if (label) this.lastSessionLabel = label;
    const info: SessionInfo = {
      label: label || this.lastSessionLabel,
      state: this.sessionState(),
    };
    // A batch held until the agent is free is a state with no other sign of itself: the
    // status-bar message that announced it is gone within seconds, and the notes look unsent.
    const queued = this.queuedCount();
    if (queued > 0) info.queued = queued;
    const summary = await this.range?.summary();
    if (summary) {
      // The strip advertises the last run; everything else is behind "Review All Changes".
      info.changedFiles = summary.recentCount;
      info.rangeLabel = summary.recentLabel;
      info.olderCount = summary.olderCount;
      info.totalFiles = summary.fileCount;
      if (summary.unavailable) info.changesUnavailable = true;
    }
    return info;
  }

  /**
   * Whether the plugin has recorded a run in this repository. Enough to say Redline is
   * connected to *something*, even with no process to point at — the session may have exited.
   */
  /**
   * Files that notes point at and that are no longer there.
   *
   * Claude deleting a file leaves its notes pointing at nothing: opening one does nothing, the
   * snippet is stale and there is no sign of why. Kept as a set rather than checked during
   * render, because building the card model is synchronous and this is a disk call per path.
   */
  private missing = new Set<string>();

  private isMissing(n: ReviewNote): boolean {
    const p = uriForNote(n.path, n.workspaceFolder)?.fsPath;
    return p !== undefined && this.missing.has(p);
  }

  private async refreshMissing(): Promise<void> {
    // A note whose folder has left the workspace has no path to check; it is already
    // unreachable and saying "deleted" about it would be a guess.
    const paths = new Set(
      this.store.notes
        .map((n) => uriForNote(n.path, n.workspaceFolder)?.fsPath)
        .filter((p): p is string => p !== undefined),
    );
    const gone = new Set<string>();
    await Promise.all(
      [...paths].map(async (p) => {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(p));
        } catch {
          gone.add(p);
        }
      }),
    );
    const same = gone.size === this.missing.size && [...gone].every((p) => this.missing.has(p));
    if (same) return; // nothing to redraw, and re-posting would loop
    this.missing = gone;
    this.postNotes();
  }

  private async hookIsLive(): Promise<boolean> {
    const root = await this.range?.repoRoot();
    if (!root) return false;
    return (await readStopMarker(root)) !== undefined;
  }

  /**
   * The notes, in one list.
   *
   * Grouped by file until now, with a header above each group. The cards come from all over a
   * change, so the headers were mostly one card each — a row of chrome per note — and every
   * card names its own file anyway.
   */
  private cards(): CardData[] {
    return this.index.panelNotes().map((n) => this.card(n));
  }

  private card(n: ReviewNote): CardData {
    const meta = KIND_META[n.kind];
    const c: CardData = {
      id: n.id,
      seq: n.seq,
      kind: n.kind,
      // The panel uses the same codicons as the comment widget; the emoji stays for the
      // markdown prompt, where a font-based icon has nowhere to render.
      kindIcon: meta.themeIcon,
      kindLabel: meta.label,
      kindColor: meta.color,
      // Every card names its own file: they come from all over, and there is no group header
      // above them to say which.
      fileRef: `${n.path.split('/').pop() ?? n.path}:${n.range.startLine + 1}`,
      firstLine: n.range.startLine + 1,
      ...(n.rejected ? { rejected: true } : {}),
      body: n.body,
      addenda: n.addenda,
      snippet: n.anchor.snippet,
      language: n.languageId ?? '',
      where: formatLineRange(n.range),
      done: n.done,
      orphaned: !!n.anchor.orphaned,
      ...(this.isMissing(n) ? { missing: true } : {}),
      attachments: (n.attachments ?? []).map((p, i) => ({
        src: this.view ? this.view.webview.asWebviewUri(vscode.Uri.file(p)).toString() : '',
        path: p,
        name: path.basename(p),
        // What it is attached to, which is not recoverable from the path. The card puts the
        // two in different places: a picture attached to a follow-up is evidence for the
        // follow-up, not for the note.
        followUp: ((n.attachmentTurns ?? [])[i] ?? 0) > 0,
        caption: ((n.attachmentTurns ?? [])[i] ?? 0) > 0 ? 'attached to this follow-up' : 'attached screenshot',
      })),
    };
    if (n.suggestion !== undefined) c.suggestion = n.suggestion;
    if (hasUnsentReply(n)) c.pendingReply = true;
    else if (n.sent && !n.sent.outcome) c.awaiting = true;
    if (n.sent) {
      const changed = this.index.changedSinceSent(n.id);
      c.sent = { changed };
      // Turns written after this are yours and Claude has not seen them — the card marks
      // them, and they are what the send button on it would send.
      if (typeof n.sent.addendaAtSend === 'number') c.sent.seenTurns = n.sent.addendaAtSend;
      if (n.sent.outcome) c.sent.outcome = n.sent.outcome;
      if (n.sent.reply) c.sent.reply = n.sent.reply;
    }
    return c;
  }

  // ── inbound ──────────────────────────────────────────────────────────

  /**
   * Handle a panel message, then tell the panel the action is over.
   *
   * The panel spins the clicked button the moment it is pressed, so something must clear
   * it. A state refresh cannot be relied on: opening a diff changes no notes and would
   * leave the button spinning until its safety timeout.
   */
  private async onMessage(m: InboundMessage): Promise<void> {
    try {
      await this.dispatch(m);
    } finally {
      void this.view?.webview.postMessage({ type: 'idle' });
    }
  }

  private async dispatch(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.readyResolve?.();
        this.postNotes();
        void this.postSession();
        break;
      case 'command':
        if (m.command) await vscode.commands.executeCommand(m.command, m.id);
        break;
      case 'setKind':
        if (m.id && m.kind) this.store.update(m.id, { kind: m.kind as NoteKind });
        break;
      case 'addAddendum': {
        const n = m.id ? this.store.getById(m.id) : undefined;
        if (!n || !m.text?.trim()) break;
        // Recorded, not sent. A reply often wants a screenshot attached before it goes, so
        // the send is always an explicit act — the card shows ➤ once there is something to
        // send.
        this.store.update(n.id, { addenda: [...n.addenda, m.text.trim()] });
        break;
      }
      case 'attach': {
        // `data` is '' for a zero-byte file: pass it through so the size check reports it.
        if (!m.name || m.data === undefined || !this.attachments) break;
        const id = await this.resolveAttachTarget(m.id);
        if (id) await this.attachments.add(id, m.name, Buffer.from(m.data, 'base64'));
        break;
      }
      case 'attachPaths': {
        if (!m.uris || !this.attachments) break;
        const paths = parseDroppedPaths(m.uris);
        const id = await this.resolveAttachTarget(m.id);
        if (!id) break;
        if (paths.length === 0) {
          void vscode.window.showWarningMessage(
            'Redline: that drop carried no local file — save the image first, then drop it (or paste it with ⌘V).',
          );
          break;
        }
        await this.attachments.addFromPaths(id, paths);
        break;
      }
      case 'dragNeedsShift':
        // The panel only receives drag events while Shift is held; without it the
        // workbench disables pointer events over the whole webview and the drop is lost.
        // Say it once per session, at the moment it actually matters.
        if (!this.shiftHintShown) {
          this.shiftHintShown = true;
          void vscode.window.showInformationMessage('Redline: hold ⇧ while dragging to drop an image on a note.');
        }
        break;
      case 'dropRejected':
        void vscode.window.showWarningMessage(
          'Redline: nothing to attach from that drop — drop an image file, or paste it with ⌘V.',
        );
        break;
      case 'panelError':
        // The webview is a separate runtime; without this a thrown handler is invisible.
        this.logger.error(`panel: ${m.text ?? 'unknown error'}`);
        break;
      case 'attachPick':
        if (m.id && this.attachments) await this.attachments.pick(m.id);
        break;
      case 'removeAttachment':
        if (m.id && m.text && this.attachments) await this.attachments.remove(m.id, m.text);
        break;
      case 'openPath': {
        // A reference out of Claude's own sentence, so the target is text it wrote: resolved
        // against the workspace and opened only if it lands inside one. `file.ts:17` jumps to
        // the line.
        if (m.text) await this.openReference(m.text);
        break;
      }
      case 'openAttachment': {
        // Only a path some note actually holds. The message is data from a webview, not an
        // instruction to open an arbitrary file, and `remove` already applies the same rule.
        if (!m.text) break;
        const owned = this.store.notes.some((n) => n.attachments?.includes(m.text as string));
        if (!owned) {
          this.logger.warn(`ignored a request to open ${m.text}: no note holds it`);
          break;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.text));
        break;
      }
    }
  }

  /**
   * Open a file Claude referred to, at its line if it gave one.
   *
   * Paths come from the agent's prose, so they are treated as untrusted: relative ones are
   * resolved against each workspace folder and anything that escapes them is refused.
   */
  private async openReference(target: string): Promise<void> {
    const match = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(target.trim());
    const rawPath = match?.[1] ?? target.trim();
    const line = match?.[2] ? Math.max(0, Number(match[2]) - 1) : undefined;
    if (!rawPath || /^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
      this.logger.warn(`ignored a reference that is not a workspace path: ${target}`);
      return;
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      const resolved = path.resolve(root, rawPath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        if (line !== undefined) {
          const at = new vscode.Position(Math.min(line, Math.max(0, doc.lineCount - 1)), 0);
          editor.selection = new vscode.Selection(at, at);
          editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
        }
        return;
      } catch {
        // not in this folder; try the next
      }
    }
    void vscode.window.showInformationMessage(`Redline: could not find ${rawPath} in this workspace.`);
  }

  /**
   * Which note a dropped image belongs to. The panel resolves the card under (or nearest
   * to) the pointer; when it cannot — the drop landed on an empty panel — fall back to the
   * only note, or ask.
   */
  /**
   * Whether to show the session as working. The hook knows first and knows anywhere; the
   * idle monitor is the fallback and only sees Orca terminals.
   */
  private sessionState(): SessionInfo['state'] {
    if (this.signals?.running) return 'working';
    return this.watcher?.state ?? 'off';
  }

  private async resolveAttachTarget(id: string | undefined): Promise<string | undefined> {
    if (id && this.store.getById(id)) return id;
    const candidates = this.index.panelNotes();
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('Redline: add a note first, then drop the screenshot on it.');
      return undefined;
    }
    if (candidates.length === 1) return candidates[0]?.id;
    const picked = await vscode.window.showQuickPick(
      candidates.map((n) => ({
        label: `#${n.seq} ${firstLine(n.body, 60)}`,
        description: `${n.path} · ${formatLineRange(n.range)}`,
        id: n.id,
      })),
      { placeHolder: 'Attach the screenshot to which note?' },
    );
    return picked?.id;
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'cards.css'));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'cards.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.notesTimer) clearTimeout(this.notesTimer);
    clearInterval(this.sessionTimer);
    for (const s of [...this.subs, ...this.viewSubs]) s.dispose();
  }
}
