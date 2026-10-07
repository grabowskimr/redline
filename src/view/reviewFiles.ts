import * as vscode from 'vscode';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ReviewRangeSource } from '../viewer/range';
import { DiffPair } from '../git/savedComparison';
import { FileFingerprint, ReviewProgress } from './reviewProgress';
import { CheckpointComparison, CheckpointFile, ReviewCheckpoint } from '../git/reviewCheckpoint';
import { diffStats, FileDiffStats } from '../git/diffStats';
import { ReviewContext, ReviewScope } from '../model/review';

interface Entry extends FileFingerprint { id: string; pair: DiffPair; available: boolean; checkpoint?: CheckpointFile; stats?: FileDiffStats; unsaved?: boolean }
interface MarkRequest { ids: string[]; reviewed: boolean; root: string; scope: ReviewScope; base?: string; resolve: (accepted: boolean) => void }
export interface ReviewFilesState {
  scope: ReviewScope;
  label: string;
  root?: string;
  baseLabel?: string;
  acceptedCount?: number;
  files: Array<{ id: string; path: string; reviewed: boolean; available: boolean; stats?: FileDiffStats; unsaved?: boolean; notes?: number }>;
  selectedId?: string;
  selectionVersion?: number;
  error?: string;
  loading?: boolean;
  pendingIds?: string[];
  markError?: string;
}

const PROGRESS_KEY = 'redline.reviewedFiles';
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Match the panel tree: folders before files, then natural name order at each level. */
function compareTreePaths(a: Entry, b: Entry): number {
  const left = a.path.split('/'), right = b.path.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const leftFolder = i < left.length - 1, rightFolder = i < right.length - 1;
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
    const order = left[i]!.localeCompare(right[i]!, undefined, { numeric: true, sensitivity: 'base' });
    if (order) return order;
  }
  return left.length - right.length;
}

/** The file list is loaded on demand. Hook refreshes reuse immutable content fingerprints. */
export class ReviewFiles implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private progress: ReviewProgress;
  private readonly checkpoints = new ReviewCheckpoint();
  private checkpoint: CheckpointComparison | undefined;
  private navigationPath: string | undefined;
  private readonly immutable = new Map<string, string>();
  private entries: Entry[] = [];
  private lastOpenedId: string | undefined;
  private selectionVersion = 0;
  private openVersion = 0;
  private readonly retained = new Map<string, Promise<void>>();
  private root = '';
  private context: ReviewContext | undefined;
  private rangeVersion = 0;
  private loadedVersion = -1;
  private readonly marks: MarkRequest[] = [];
  private readonly pendingMarks = new Map<string, number>();
  private marking: Promise<void> | undefined;
  private refreshAfterMarks: Promise<void> | undefined;
  private nextRefreshScope: ReviewScope | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private generation = 0;
  private inFlight: Promise<void> | undefined;
  private active = false;
  private disposed = false;
  state: ReviewFilesState = { scope: 'recent', label: 'Last run', files: [] };

  constructor(private readonly range: ReviewRangeSource, private readonly memory: vscode.Memento) {
    this.progress = new ReviewProgress(memory.get(PROGRESS_KEY));
    const invalidate = () => { this.rangeVersion++; this.context = undefined; };
    if (range.onDidChange) this.subscriptions.push(range.onDidChange(invalidate));
    if (range.onDidPublish) this.subscriptions.push(range.onDidPublish(invalidate));
  }

  private async fingerprint(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === 'redline-empty') return hash('');
    const key = uri.toString();
    const immutable = uri.scheme === 'redline-tree';
    const cached = immutable ? this.immutable.get(key) : undefined;
    if (cached) return cached;
    // Unsaved edits are part of the working-side review, but never replace a saved side.
    const open = uri.scheme === 'file' ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === key) : undefined;
    let value: string;
    if (open) value = hash(open.getText());
    else if (uri.scheme === 'git' || uri.scheme === 'review') value = hash((await vscode.workspace.openTextDocument(uri)).getText());
    else value = hash(await vscode.workspace.fs.readFile(uri));
    if (immutable) {
      this.immutable.set(key, value);
      while (this.immutable.size > 2000) this.immutable.delete(this.immutable.keys().next().value!);
    }
    return value;
  }

  refresh(scope: ReviewScope = this.state.scope): Promise<void> {
    if (this.marking) {
      this.nextRefreshScope = scope;
      return this.refreshAfterMarks ??= this.marking.then(() => {
        const next = this.nextRefreshScope ?? this.state.scope;
        this.refreshAfterMarks = undefined; this.nextRefreshScope = undefined;
        return this.refresh(next);
      });
    }
    return this.refreshNow(scope);
  }

  private refreshNow(scope: ReviewScope = this.state.scope): Promise<void> {
    this.active = true;
    if (this.inFlight && scope === this.state.scope) return this.inFlight;
    if (scope !== this.state.scope) this.state = { scope, label: scope === 'recent' ? 'Last run' : 'Unreviewed', files: [], loading: true };
    this.context = undefined;
    const generation = ++this.generation;
    const operation = this.load(scope, generation);
    this.inFlight = operation;
    return operation.finally(() => { if (this.inFlight === operation) this.inFlight = undefined; });
  }

  refreshIfActive(): Promise<void> { return this.active ? this.refresh() : Promise.resolve(); }

  private async load(scope: ReviewScope, generation: number): Promise<void> {
    try {
      // A hook can publish another run while Git or content reads are pending. Keep
      // the file list, label and revisions from one version of the review range.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.disposed || generation !== this.generation) return;
        const version = this.rangeVersion;
        const summary = await this.range.summary();
        const root = await this.range.repoRoot();
        if (version !== this.rangeVersion) continue;
        if (!root || !summary || summary.unavailable) throw new Error('Open and trust a Git workspace to review changes.');
        if (scope === 'recent' && summary.recentUnavailable) throw new Error(summary.recentUnavailable);
        const checkpoint = scope === 'unreviewed' ? await this.checkpoints.compare(root, summary.base) : undefined;
        const pairs = checkpoint ? [] : await this.range.diffResources();
        if (version !== this.rangeVersion) continue;
        const snapshot = this.range.runComparison();
        const stats = !checkpoint && snapshot ? await diffStats(root, snapshot.before, snapshot.after).catch(() => new Map<string, FileDiffStats>()) : undefined;
        const entries: Entry[] = (checkpoint?.files ?? []).map((file) => ({ ...file, checkpoint: file, id: hash(JSON.stringify([root, scope, file.path, file.before, file.after])) }));
        // Four reads at a time rather than one process/read per file launched all at once.
        for (let i = 0; i < pairs.length; i += 4) {
          entries.push(...await Promise.all(pairs.slice(i, i + 4).map(async (pair): Promise<Entry> => {
            const rel = path.relative(root, pair[0].fsPath).split(path.sep).join('/');
            let before = '', after = '', available = true;
            try {
              if (scope === 'recent' && this.range.savedFileFingerprint) {
                before = this.range.savedFileFingerprint(pair[1]); after = this.range.savedFileFingerprint(pair[2]);
              } else [before, after] = await Promise.all([this.fingerprint(pair[1]), this.fingerprint(pair[2])]);
            }
            catch { available = false; }
            // Disk numstat cannot describe a live dirty editor. Keep its diff reviewable,
            // but show an Unsaved badge instead of misleading saved-line counts.
            const unsaved = pair[2].scheme === 'file' && vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === pair[2].toString() && doc.isDirty);
            return { id: hash(JSON.stringify([root, scope, rel, before, after])), path: rel, before, after, pair, available, unsaved, stats: unsaved ? undefined : stats?.get(rel) };
          })));
        }
        if (this.disposed || generation !== this.generation) return;
        const currentRoot = await this.range.repoRoot();
        if (this.disposed || generation !== this.generation) return;
        if (version !== this.rangeVersion) continue;
        if (root !== currentRoot) throw new Error('The repository changed. Refresh this review.');
        entries.sort(compareTreePaths);
        if (this.root !== root) this.navigationPath = undefined;
        this.root = root; this.entries = entries; this.checkpoint = checkpoint; this.loadedVersion = version;
        const comparison = this.range.runComparison();
        this.context = { root, scope, label: scope === 'recent' ? `Last run · ${summary.recentLabel}` : 'Unreviewed · Since each file’s last acceptance', files: entries.map((f) => f.path),
          before: checkpoint?.before ?? (scope === 'recent' ? comparison?.before : summary.base),
          after: checkpoint?.after ?? (scope === 'recent' && comparison?.completed ? comparison.after : undefined) };
        this.state = { scope, root, baseLabel: summary.label, acceptedCount: checkpoint?.acceptedCount, label: this.context.label, files: [] };
        this.publish();
        return;
      }
      throw new Error('The review changed while loading. Refresh it when the current run settles.');
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.context = undefined; this.checkpoint = undefined; this.entries = [];
      this.state = { scope, label: scope === 'recent' ? 'Last run' : 'Unreviewed', files: [], error: error instanceof Error ? error.message : String(error) };
      this.changes.fire();
    }
  }

  private publish(): void {
    if (!this.entries.some((entry) => entry.id === this.lastOpenedId)) this.lastOpenedId = undefined;
    this.state = { ...this.state, pendingIds: [...this.pendingMarks.keys()], selectedId: this.lastOpenedId, selectionVersion: this.selectionVersion, files: this.state.loading ? [] : this.entries.map((entry) => ({ id: entry.id, path: entry.path, available: entry.available, stats: entry.stats, unsaved: entry.unsaved, reviewed: this.state.scope !== 'unreviewed' && entry.available && this.progress.isReviewed(this.root, this.state.scope, entry) })) };
    this.changes.fire();
  }

  async capture(scope: ReviewScope, options?: { publish: boolean }): Promise<ReviewContext | undefined> {
    if (options?.publish === false) {
      const request = new ReviewFiles(this.range, this.memory);
      try { return await request.capture(scope); } finally { request.dispose(); }
    }
    await this.refresh(scope);
    if (this.context?.scope !== scope) return undefined;
    const context = structuredClone(this.context);
    if (scope === 'unreviewed' && this.checkpoint) await this.checkpoints.retain(this.checkpoint);
    return context;
  }

  mark(id: string, reviewed: boolean): Promise<boolean> { return this.queueMarks([id], reviewed); }

  /** IDs belong to the list the user saw, never to files discovered during saving. */
  markAll(ids: readonly string[] = this.state.files.filter((file) => file.available && !file.reviewed && !this.pendingMarks.has(file.id)).map((file) => file.id)): Promise<boolean> {
    return this.queueMarks([...new Set(ids)], true);
  }

  private queueMarks(ids: string[], reviewed: boolean): Promise<boolean> {
    if (this.disposed || this.state.loading || !ids.length || (this.state.scope === 'unreviewed' && !reviewed)) return Promise.resolve(false);
    const result = new Promise<boolean>((resolve) => {
      this.marks.push({ ids, reviewed, root: this.root, scope: this.state.scope, base: this.checkpoint?.base, resolve });
      for (const id of ids) this.pendingMarks.set(id, (this.pendingMarks.get(id) ?? 0) + 1);
    });
    this.state = { ...this.state, markError: undefined }; this.publish();
    this.startMarks();
    return result;
  }

  private startMarks(): void {
    if (this.marking || !this.marks.length) return;
    // Collect a rapid click burst; later bursts join the same serialized drain.
    const operation = new Promise<void>((resolve) => setTimeout(resolve, 30)).then(() => this.flushMarks());
    this.marking = operation;
    void operation.finally(() => {
      if (this.marking === operation) this.marking = undefined;
      // Resolving the last mark can synchronously queue the next one before this
      // promise's cleanup runs. It must still get its own drain.
      this.startMarks();
    });
  }

  private async flushMarks(): Promise<void> {
    while (this.marks.length) {
      const requests = this.marks.splice(0);
      const accepted = new Set<string>();
      try {
        await this.inFlight;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (this.disposed) break;
          if (this.loadedVersion !== this.rangeVersion || attempt) await this.refreshNow();
          const compatible = requests.filter((request) => request.root === this.root && request.scope === this.state.scope && (request.scope !== 'unreviewed' || request.base === this.checkpoint?.base));
          const wanted = new Map(compatible.flatMap((request) => request.ids.map((id) => [id, request.reviewed] as const)));
          const entries = this.entries.filter((entry) => wanted.has(entry.id) && entry.available);
          if (!entries.length) break;
          try {
            if (this.state.scope === 'unreviewed' && this.checkpoint) {
              const result = await this.checkpoints.acceptMany(this.checkpoint, entries.map((entry) => entry.checkpoint!));
              for (const entry of entries) if (result.accepted.includes(entry.path)) { accepted.add(entry.id); this.navigationPath = entry.path; }
              this.checkpoint = result.comparison;
              this.entries = result.comparison.files.map((file) => ({ ...file, checkpoint: file, id: hash(JSON.stringify([this.root, 'unreviewed', file.path, file.before, file.after])) })).sort(compareTreePaths);
              if (this.context) this.context = { ...this.context, before: result.comparison.before, after: result.comparison.after, files: this.entries.map((entry) => entry.path) };
              this.state = { ...this.state, acceptedCount: result.comparison.acceptedCount };
            } else {
              // Checklist marks need only the chosen file fingerprints, not a repository scan.
              const progress = new ReviewProgress(this.progress.snapshot()), checked: string[] = [];
              for (const entry of entries) {
                try {
                  const [before, after] = await Promise.all([this.fingerprint(entry.pair[1]), this.fingerprint(entry.pair[2])]);
                  if (before === entry.before && after === entry.after) { progress.mark(this.root, this.state.scope, entry, wanted.get(entry.id)!); checked.push(entry.id); }
                } catch { /* Unavailable files remain unreviewed; the others can still be saved. */ }
              }
              await this.memory.update(PROGRESS_KEY, progress.snapshot());
              this.progress = progress; for (const id of checked) accepted.add(id);
              if (accepted.size !== wanted.size) await this.refreshNow();
            }
            break;
          } catch (error) {
            // A different window may win a ref update. Reload once and replay only
            // IDs whose file versions still match, preserving the other acceptance.
            if (!attempt && /cannot lock ref|is at .* but expected|reference already exists/i.test(String(error))) continue;
            throw error;
          }
        }
        if (requests.some((request) => request.ids.some((id) => !accepted.has(id)))) this.state = { ...this.state, markError: 'Some files changed or are no longer available. Review their latest changes before accepting them.' };
      } catch (error) {
        this.state = { ...this.state, markError: `Could not save review progress. ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        for (const request of requests) {
          for (const id of request.ids) {
            const remaining = (this.pendingMarks.get(id) ?? 1) - 1;
            if (remaining) this.pendingMarks.set(id, remaining); else this.pendingMarks.delete(id);
          }
          request.resolve(request.ids.every((id) => accepted.has(id)));
        }
        if (!this.disposed) this.publish();
      }
    }
  }

  /** IDs identify displayed entries. Opening an editor needs no new Git snapshot. */
  workingFile(id: string): vscode.Uri | undefined {
    return this.entries.find((entry) => entry.id === id)?.pair[0];
  }

  async open(id: string): Promise<boolean> {
    const version = ++this.openVersion;
    if (this.disposed || this.state.loading || !vscode.workspace.isTrusted) return false;
    const entry = this.entries.find((f) => f.id === id);
    if (!entry?.available) return false;
    // A click refers to the version already displayed. Rebuilding the entire list
    // here both delayed opening and replaced that version with newer working edits.
    const root = this.root, scope = this.state.scope, label = this.state.label;
    const checkpoint = entry.checkpoint ? this.checkpoint : this.context?.before && this.context.after
      ? { root: this.context.root, before: this.context.before, after: this.context.after } : undefined;
    if (checkpoint) await this.retain(checkpoint);
    const currentRoot = await this.range.repoRoot();
    // A newer click owns navigation now; do not report a stale-diff error for the
    // intentionally superseded request.
    if (version !== this.openVersion) return true;
    if (this.disposed || this.state.loading ||
        this.root !== root || this.state.scope !== scope || root !== currentRoot) return false;
    await vscode.commands.executeCommand('vscode.diff', entry.pair[1], entry.pair[2], `${entry.path} · ${label}`);
    if (this.disposed || version !== this.openVersion || this.root !== root || this.state.scope !== scope) return true;
    this.lastOpenedId = entry.id;
    this.navigationPath = entry.path;
    this.selectionVersion++;
    this.publish();
    return true;
  }

  async nextUnreviewed(): Promise<boolean> {
    // Load only for first use or a scope switch. Background refresh owns freshness;
    // navigation must not scan the repository or wait for unrelated checkbox saves.
    if (this.loadedVersion < 0 || this.state.loading) await this.refresh();
    if (this.state.scope === 'unreviewed') {
      const available = this.entries.filter((entry) => entry.available && !this.pendingMarks.has(entry.id));
      const next = available.find((entry) => this.navigationPath && compareTreePaths(entry, { path: this.navigationPath } as Entry) > 0) ?? available[0];
      return next ? this.open(next.id) : false;
    }
    const current = this.state.files.findIndex((f) => f.id === this.lastOpenedId);
    const ordered = [...this.state.files.slice(current + 1), ...this.state.files.slice(0, current + 1)];
    const next = ordered.find((f) => !f.reviewed && f.available && !this.pendingMarks.has(f.id));
    return next ? this.open(next.id) : false;
  }

  /** Coalesce rapid clicks and retain each immutable comparison once per instance. */
  private retain(checkpoint: Pick<CheckpointComparison, 'root' | 'before' | 'after'>): Promise<void> {
    const key = JSON.stringify([checkpoint.root, checkpoint.before, checkpoint.after]);
    let operation = this.retained.get(key);
    if (!operation) {
      operation = this.checkpoints.retain(checkpoint).catch((error) => { this.retained.delete(key); throw error; });
      this.retained.set(key, operation);
      while (this.retained.size > 64) this.retained.delete(this.retained.keys().next().value!);
    }
    return operation;
  }

  dispose(): void {
    this.disposed = true; this.generation++;
    this.retained.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changes.dispose();
  }
}
