import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { repositoryRoot, stateDirectory } from '../claude/statePaths';
import { readRunTrees, RunTrees } from '../claude/runTrees';
import { gitIn, savedDiff, DiffPair } from '../git/savedComparison';
import { treeChanges } from '../git/snapshotTree';

export interface ViewerSession {
  root: string;
  id: string;
  label: string;
  at: string;
}
export interface ViewerSummary {
  base: string;
  label: string;
  recentLabel: string;
  recent: string[];
  unavailable?: boolean;
  recentUnavailable?: string;
}
export interface ReviewRangeSource {
  onDidChange?: vscode.Event<void>;
  onDidPublish?: vscode.Event<void>;
  repoRoot(): Promise<string | undefined>;
  summary(): Promise<ViewerSummary | undefined>;
  diffResources(): Promise<DiffPair[]>;
  runComparison(): { root: string; before: string; after: string; completed: boolean } | undefined;
  savedFileFingerprint?(uri: vscode.Uri): string;
}

/** Hook records are the only source of run boundaries. No transcript or terminal scans. */
export class ViewerRange implements ReviewRangeSource, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private generation = 0;
  private selected?: { root: string; session?: string };
  private cached?: Promise<ViewerSummary | undefined>;
  private pair?: { root: string; before: string; after: string; completed: boolean };
  private disposed = false;
  private fingerprints = new Map<string, string>();
  session?: ViewerSession;
  pendingAt?: string;
  captureError?: string;

  constructor(
    private readonly roots: () => string[],
    private readonly memory: vscode.Memento,
    private readonly home?: string,
  ) {
    const saved = memory.get<{ root?: string; session?: string }>('redline.viewer.session');
    if (
      typeof saved?.root === 'string' &&
      this.allowedRoots().includes(repositoryRoot(saved.root))
    ) {
      this.selected = {
        root: repositoryRoot(saved.root),
        session: typeof saved.session === 'string' ? saved.session : undefined,
      };
    }
  }
  private allowedRoots(): string[] {
    return [...new Set(this.roots().map(repositoryRoot))];
  }
  repositories(): string[] {
    return this.allowedRoots();
  }
  async repoRoot(): Promise<string | undefined> {
    const roots = this.allowedRoots();
    return this.selected ? roots.find((root) => root === this.selected!.root) : roots[0];
  }
  selectRepository(root: string, session?: string): void {
    root = repositoryRoot(root);
    if (!this.allowedRoots().includes(root)) {
      throw new Error('This repository is outside the current workspace.');
    }
    this.selected = { root, session };
    void this.memory.update('redline.viewer.session', this.selected);
    this.invalidate();
  }
  invalidate(): void {
    this.generation++;
    this.cached = undefined;
    this.pair = undefined;
    this.changed.fire();
  }
  async sessions(): Promise<ViewerSession[]> {
    const result: ViewerSession[] = [];
    for (const root of this.allowedRoots()) {
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(stateDirectory(root, this.home), 'runs.json'), 'utf8'),
        );
        if (raw.root && raw.root !== root) continue;
        const records: Array<Record<string, unknown>> =
          raw.sessions && typeof raw.sessions === 'object' ? Object.values(raw.sessions) : [raw];
        for (const record of records) {
          if (!record || typeof record !== 'object') continue;
          const markers = [record.pending, record.stopped, record.after, record.before] as Array<
            { session?: unknown; at?: unknown } | undefined
          >;
          const id = markers.find((m) => typeof m?.session === 'string' && m.session)?.session;
          if (typeof id !== 'string') continue;
          const at =
            typeof record.observedAt === 'string'
              ? record.observedAt
              : markers.find((m) => typeof m?.at === 'string')?.at;
          result.push({
            root,
            id,
            label: `Session ${id.slice(0, 8)}`,
            at: typeof at === 'string' ? at : '',
          });
        }
      } catch {
        /* No plugin record in this worktree yet. */
      }
    }
    return result.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  }
  summary(): Promise<ViewerSummary | undefined> {
    const generation = this.generation;
    return (this.cached ??= this.load(generation).catch((error) => {
      if (generation === this.generation) this.cached = undefined;
      throw error;
    }));
  }
  private async base(root: string, initialHead?: string): Promise<{ base: string; label: string }> {
    const run = gitIn(root);
    const configured = vscode.workspace
      .getConfiguration('redline', vscode.Uri.file(root))
      .get<string>('reviewBase', 'auto');
    let head: string;
    try {
      head = (await run(['rev-parse', '--verify', 'HEAD'])).trim();
    } catch {
      return {
        base: (await run(['hash-object', '-w', '-t', 'tree', '--stdin'])).trim(),
        label: 'Empty repository',
      };
    }
    if (configured !== 'auto') {
      const ref = (
        await run(['rev-parse', '--verify', '--end-of-options', `${configured}^{commit}`])
      ).trim();
      const base = (await run(['merge-base', 'HEAD', ref])).trim();
      return { base, label: `${configured} (merge-base)` };
    }
    let branch = '';
    try {
      branch = (await run(['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      /* detached HEAD */
    }
    for (const ref of [
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'refs/heads/main',
      'refs/heads/master',
    ]) {
      if (ref === `refs/heads/${branch}`) continue;
      try {
        const base = (await run(['merge-base', 'HEAD', ref])).trim();
        return { base, label: `${ref.replace(/^refs\/(heads|remotes)\//, '')} (merge-base)` };
      } catch {
        /* Try the next conventional review base. */
      }
    }
    // On main or in a local-only repository, keep the original floor as Claude commits.
    const key = `redline.viewer.base.${createHash('sha256').update(`${root}\0${branch}`).digest('hex')}`;
    const saved = this.memory.get<string>(key);
    if (saved && /^[a-f0-9]{40,64}$/.test(saved)) {
      try {
        await run(['cat-file', '-e', `${saved}^{tree}`]);
        return { base: saved, label: 'Saved review base' };
      } catch {
        /* missing after rewritten history */
      }
    }
    if (initialHead && /^[a-f0-9]{40,64}$/.test(initialHead)) {
      try {
        await run(['cat-file', '-e', `${initialHead}^{commit}`]);
        head = initialHead;
      } catch {
        /* legacy or expired initial HEAD */
      }
    }
    await run([
      'update-ref',
      `refs/redline/viewer-bases/${key.slice('redline.viewer.base.'.length)}`,
      head,
    ]);
    await this.memory.update(key, head);
    return { base: head, label: 'Saved review base' };
  }
  private async load(generation: number): Promise<ViewerSummary | undefined> {
    const root = await this.repoRoot();
    if (!root) return undefined;
    if (!vscode.workspace.isTrusted) {
      return { base: '', label: '', recentLabel: '', recent: [], unavailable: true };
    }
    const sessions = (await this.sessions()).filter((s) => s.root === root);
    const session = this.selected?.session
      ? (sessions.find((s) => s.id === this.selected!.session) ?? {
          root,
          id: this.selected.session,
          label: `Session ${this.selected.session.slice(0, 8)}`,
          at: '',
        })
      : sessions[0];
    const trees: RunTrees | undefined = session
      ? await readRunTrees(root, this.home, session.id)
      : undefined;
    const initialHead =
      trees?.history?.filter((run) => !run.approx).at(-1)?.head ??
      trees?.before?.head ??
      trees?.pending?.head;
    const { base, label } = await this.base(root, initialHead);
    const before = trees?.before,
      after = trees?.after;
    let reason = trees?.snapshotError;
    if (
      !reason &&
      (!before ||
        !after ||
        !before.id ||
        before.id !== after.id ||
        before.session !== session?.id ||
        after.session !== session?.id)
    ) {
      reason = trees?.pending
        ? 'The current prompt has not produced a completed snapshot yet.'
        : 'No completed run for this session. Run a prompt in Claude Code with the Redline plugin enabled.';
    }
    const pair =
      !reason && before && after
        ? { root, before: before.tree, after: after.tree, completed: true }
        : undefined;
    const changes = pair ? await treeChanges(pair.before, pair.after, gitIn(root)) : new Map();
    const recent = [...changes.keys()];
    // Two tree listings replace two content reads per file. Blob IDs include content,
    // and modes preserve permission-only changes; submodules are not regular files.
    const fingerprints = new Map<string, string>();
    if (pair) {
      const names = new Set(recent);
      for (const change of changes.values()) if (change.kind === 'renamed') names.add(change.from);
      await Promise.all(
        [pair.before, pair.after].map(async (tree) => {
          const entries = await gitIn(root)(['ls-tree', '-r', '-z', tree]);
          for (const record of entries.split('\0')) {
            const tab = record.indexOf('\t');
            if (tab < 0) continue;
            const name = record.slice(tab + 1),
              meta = record.slice(0, tab);
            if (names.has(name) && /^\d+ blob [a-f0-9]+$/.test(meta)) {
              fingerprints.set(`${tree}\0${name}`, meta);
            }
          }
        }),
      );
    }
    if (generation !== this.generation || this.disposed) return undefined;
    this.fingerprints = fingerprints;
    this.session = session;
    this.pendingAt = trees?.pending?.at;
    this.captureError = trees?.snapshotError;
    this.pair = pair;
    return {
      base,
      label,
      recent,
      recentLabel: before
        ? `last code-changing run · ${new Date(before.at).toLocaleString()}`
        : 'No completed run',
      recentUnavailable: reason,
    };
  }
  savedFileFingerprint(uri: vscode.Uri): string {
    if (uri.scheme === 'redline-empty') return 'empty';
    const params = new URLSearchParams(uri.query);
    const value =
      params.get('root') === this.pair?.root
        ? this.fingerprints.get(`${params.get('tree')}\0${uri.path.slice(1)}`)
        : undefined;
    if (!value) throw new Error('This snapshot path is not a regular file.');
    return value;
  }
  async diffResources(): Promise<DiffPair[]> {
    await this.summary();
    const pair = this.pair;
    return pair ? savedDiff(pair.root, pair.before, pair.after) : [];
  }
  runComparison(): { root: string; before: string; after: string; completed: boolean } | undefined {
    return this.pair;
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.changed.dispose();
  }
}
