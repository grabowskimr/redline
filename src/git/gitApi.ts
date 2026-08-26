import * as vscode from 'vscode';
import { GitSnapshot } from '../model/note';
import { Logger } from '../logger';

// Minimal subset of the built-in `vscode.git` extension API (see extensions/git/src/api/git.d.ts).
export interface GitRef {
  name?: string;
  commit?: string;
}
export interface GitChange {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
  status: number;
}
export interface GitRepositoryState {
  HEAD: GitRef | undefined;
  workingTreeChanges: GitChange[];
  indexChanges: GitChange[];
  mergeChanges: GitChange[];
  readonly onDidChange: vscode.Event<void>;
}
export interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
  diffWithHEAD(path: string): Promise<string>;
  diffWith(ref: string, path: string): Promise<string>;
  diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
}
export interface GitAPI {
  repositories: GitRepository[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): GitRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}
export interface GitExtension {
  getAPI(version: 1): GitAPI;
}

/**
 * Best-effort access to the built-in git extension. Never throws, never blocks activation.
 */
export class GitService {
  private api: GitAPI | undefined;
  private ready: Promise<void>;

  constructor(private readonly logger: Logger) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!ext) {
        this.logger.info('vscode.git extension not available; git features disabled');
        return;
      }
      const exports = ext.isActive ? ext.exports : await ext.activate();
      this.api = exports.getAPI(1);
      this.logger.trace('git API ready');
    } catch (err) {
      this.logger.warn('failed to initialise git API', err);
    }
  }

  async getApi(): Promise<GitAPI | undefined> {
    await this.ready;
    return this.api;
  }

  async repositoryFor(uri: vscode.Uri): Promise<GitRepository | undefined> {
    const api = await this.getApi();
    if (!api) return undefined;
    try {
      return api.getRepository(uri) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Snapshot of branch / sha / dirty for the repo containing `uri`. */
  async snapshot(uri: vscode.Uri): Promise<GitSnapshot | undefined> {
    const repo = await this.repositoryFor(uri);
    if (!repo) return undefined;
    const head = repo.state.HEAD;
    const out: GitSnapshot = {};
    if (head?.name) out.branch = head.name;
    if (head?.commit) out.sha = head.commit;
    out.dirty =
      repo.state.workingTreeChanges.length > 0 ||
      repo.state.indexChanges.length > 0 ||
      repo.state.mergeChanges.length > 0;
    return out;
  }

  /** Repo name + snapshot for the batch header. */
  async context(uri: vscode.Uri | undefined): Promise<(GitSnapshot & { repoName?: string }) | undefined> {
    const api = await this.getApi();
    if (!api) return undefined;
    let repo: GitRepository | undefined;
    if (uri) repo = (api.getRepository(uri) ?? undefined) as GitRepository | undefined;
    repo ??= api.repositories[0];
    if (!repo) return undefined;
    const snap = (await this.snapshot(repo.rootUri)) ?? {};
    return { ...snap, repoName: repo.rootUri.path.split('/').filter(Boolean).pop() };
  }
}
