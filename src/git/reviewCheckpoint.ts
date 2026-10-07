import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { gitIn, DiffPair } from './savedComparison';
import { snapshotWorkingTree, treeChanges, nulFields, GitRunner } from './snapshotTree';
import { treeSide } from './treeSide';
import { diffStats, FileDiffStats } from './diffStats';
import { emptySide } from './emptySide';

interface TreeEntry { mode: string; object: string }
export interface CheckpointFile {
  path: string; from?: string; before: string; after: string;
  pair: DiffPair; available: boolean; stats?: FileDiffStats;
}
export interface CheckpointComparison {
  root: string; base: string; before: string; after: string; ref: string; previous?: string;
  files: CheckpointFile[]; acceptedCount: number;
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const validTree = (value: string): boolean => /^[a-f0-9]{40,64}$/.test(value);
const validPath = (value: string): boolean => !!value && !path.isAbsolute(value) && !value.split('/').includes('..') && !value.includes('\0');

async function entriesAt(run: GitRunner, tree: string, paths: string[]): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  for (let i = 0; i < paths.length; i += 128) {
    const records = nulFields(await run(['ls-tree', '-r', '-z', tree, '--', ...paths.slice(i, i + 128)], { GIT_LITERAL_PATHSPECS: '1' }));
    for (const record of records) {
      const tab = record.indexOf('\t');
      const [mode, , object] = record.slice(0, tab).split(' ');
      if (tab >= 0 && mode && object) entries.set(record.slice(tab + 1), { mode, object });
    }
  }
  return entries;
}

/** Change only named paths in a private index. Git retains binary bytes and file modes. */
async function replaceEntries(root: string, run: GitRunner, before: string, replacements: Map<string, TreeEntry | undefined>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-accepted-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  try {
    await run(['read-tree', before], env);
    const records: string[] = [];
    for (const name of replacements.keys()) {
      if (!validPath(name)) throw new Error('Invalid review path.');
      records.push(`0 ${'0'.repeat(before.length)}\t${name}\0`);
    }
    for (const [name, entry] of replacements) if (entry) records.push(`${entry.mode} ${entry.object}\t${name}\0`);
    // One NUL-delimited update handles a burst of checkboxes and unusual filenames.
    await new Promise<void>((resolve, reject) => {
      const child = execFile('git', ['-C', root, 'update-index', '-z', '--index-info'], { env: { ...process.env, ...env }, timeout: 15000 }, (error) => error ? reject(error) : resolve());
      child.stdin?.on('error', reject); child.stdin?.end(records.join(''));
    });
    const tree = (await run(['write-tree'], env)).trim();
    if (!validTree(tree)) throw new Error('Could not save the accepted version.');
    return tree;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function textObject(root: string, name: string, content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', root, 'hash-object', '-w', '--path=' + name, '--stdin'], { timeout: 15000, encoding: 'utf8' }, (error, out) => {
      if (error) reject(error);
      else if (!validTree(out.trim())) reject(new Error('Could not snapshot unsaved text.'));
      else resolve(out.trim());
    });
    child.stdin?.on('error', reject);
    child.stdin?.end(content);
  });
}

/** Snapshot dirty editors without saving them, using the same Git filters as disk files. */
async function withDirtyEditors(root: string, tree: string, run: GitRunner, paths?: ReadonlySet<string>): Promise<string> {
  const buffers = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file')
    .map((d) => ({ filename: d.uri.fsPath, text: d.getText() }));
  const dirty = (await Promise.all(buffers.map(async ({ filename, text }) => {
    // Editors may use a workspace symlink spelling. A deleted file can still have a dirty buffer.
    const canonical = await fs.realpath(filename).catch(async () =>
      path.join(await fs.realpath(path.dirname(filename)), path.basename(filename))).catch(() => filename);
    return { name: path.relative(root, canonical).split(path.sep).join('/'), text };
  }))).filter((d) => validPath(d.name) && (!paths || paths.has(d.name)));
  if (!dirty.length) return tree;
  const existing = await entriesAt(run, tree, dirty.map((d) => d.name));
  const replacements = new Map<string, TreeEntry>();
  for (const { name, text } of dirty) {
    const entry = existing.get(name);
    if (entry && !['100644', '100755'].includes(entry.mode)) continue;
    if (!entry) {
      try { await run(['check-ignore', '-q', '--', name]); continue; }
      catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    }
    replacements.set(name, { mode: entry?.mode ?? '100644', object: await textObject(root, name, text) });
  }
  return replacements.size ? replaceEntries(root, run, tree, replacements) : tree;
}

/** Validate clicked paths against disk/buffers without scanning unrelated worktree files. */
async function snapshotPaths(comparison: CheckpointComparison, paths: string[]): Promise<string> {
  const { root, after } = comparison, run = gitIn(root);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-review-paths-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  try {
    await run(['read-tree', after], env);
    const entries = await entriesAt(run, after, paths);
    const stage: string[] = [];
    for (const name of paths) {
      if (!validPath(name)) throw new Error('Invalid review path.');
      const exists = await fs.lstat(path.join(root, name)).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      });
      // An already deleted path may be absent from both index and disk. Passing it
      // to git add would fail with "pathspec did not match" instead of validating it.
      if (exists || [...entries.keys()].some((p) => p === name || p.startsWith(name + '/'))) stage.push(name);
    }
    for (let i = 0; i < stage.length; i += 128) await run(['add', '-A', '--', ...stage.slice(i, i + 128)], env);
    const tree = (await run(['write-tree'], env)).trim();
    if (!validTree(tree)) throw new Error('Could not validate reviewed files.');
    return await withDirtyEditors(root, tree, run, new Set(paths));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** A composite baseline: each accepted file advances independently of every other file. */
export class ReviewCheckpoint {
  async compare(root: string, base: string): Promise<CheckpointComparison> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before reviewing changes.');
    if (!validTree(base)) throw new Error('The review base is unavailable. Refresh the review.');
    root = await fs.realpath(root);
    const run = gitIn(root), ref = `refs/redline/accepted/${digest(JSON.stringify([root, base]))}`;
    let previous: string | undefined;
    try { previous = (await run(['rev-parse', '--verify', '--quiet', ref])).trim(); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if (previous && !validTree(previous)) throw new Error('The saved review baseline is unavailable.');
    const before = previous ?? base;
    let failure = '';
    const disk = await snapshotWorkingTree(root, run, (reason) => { failure = reason; });
    if (!disk) throw new Error(`Could not read current changes. ${failure}`);
    const after = await withDirtyEditors(root, disk, run);
    // Keep open diff editors readable even if Git prunes while this review is open.
    await run(['update-ref', `${ref}-current`, after]);
    return this.describe({ root, base, before, after, ref, previous });
  }

  private async describe(value: Omit<CheckpointComparison, 'files' | 'acceptedCount'>): Promise<CheckpointComparison> {
    const { root, base, before, after, previous } = value, run = gitIn(root);
    const [changes, stats, accepted] = await Promise.all([treeChanges(before, after, run), diffStats(root, before, after).catch(() => new Map<string, FileDiffStats>()), previous ? treeChanges(base, before, run) : new Map()]);
    const paths = [...new Set([...changes].flatMap(([name, change]) => change.kind === 'renamed' ? [change.from, name] : [name]))];
    const [left, right] = await Promise.all([entriesAt(run, before, paths), entriesAt(run, after, paths)]);
    const files = [...changes].map(([name, change]): CheckpointFile => {
      const from = change.kind === 'renamed' ? change.from : name, a = left.get(from), b = right.get(name);
      const uri = vscode.Uri.file(path.join(root, name));
      return { path: name, from: from === name ? undefined : from,
        before: JSON.stringify([from, a?.mode, a?.object]), after: JSON.stringify([name, b?.mode, b?.object]),
        stats: stats.get(name),
        available: a?.mode !== '160000' && b?.mode !== '160000',
        pair: [uri, a ? treeSide(root, before, from) : emptySide(uri, 'new file'), b ? treeSide(root, after, name) : emptySide(uri, 'deleted')] };
    });
    const pending = new Set(files.flatMap((file) => [file.path, ...(file.from ? [file.from] : [])]));
    const acceptedCount = [...accepted.keys()].filter((name) => !pending.has(name)).length;
    return { ...value, files, acceptedCount };
  }

  async accept(comparison: CheckpointComparison, file: CheckpointFile): Promise<void> {
    const result = await this.acceptMany(comparison, [file]);
    if (!result.accepted.length) throw new Error('This file changed after it was displayed.');
  }

  async acceptMany(comparison: CheckpointComparison, files: readonly CheckpointFile[]): Promise<{ comparison: CheckpointComparison; accepted: string[] }> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before accepting changes.');
    const run = gitIn(comparison.root), paths = [...new Set(files.flatMap((file) => [file.path, ...(file.from ? [file.from] : [])]))];
    const after = await snapshotPaths(comparison, paths);
    const [expected, current] = await Promise.all([entriesAt(run, comparison.after, paths), entriesAt(run, after, paths)]);
    const accepted = files.filter((file) => file.available && [file.path, ...(file.from ? [file.from] : [])].every((name) => {
      const a = expected.get(name), b = current.get(name);
      return a?.mode === b?.mode && a?.object === b?.object;
    }));
    const replacements = new Map<string, TreeEntry | undefined>();
    for (const file of accepted) {
      if (file.from) replacements.set(file.from, undefined);
      replacements.set(file.path, expected.get(file.path));
    }
    const tree = replacements.size ? await replaceEntries(comparison.root, run, comparison.before, replacements) : comparison.before;
    const next = await this.describe({ ...comparison, before: tree, after, previous: replacements.size ? tree : comparison.previous });
    // Finish retention before committing acceptance, so a failed save cannot
    // leave a file accepted while its checkbox reports failure.
    await run(['update-ref', `${comparison.ref}-current`, after]);
    // Another window may accept something while this operation runs. Never overwrite it.
    if (replacements.size) await run(['update-ref', comparison.ref, tree, comparison.previous ?? '0'.repeat(tree.length)]);
    return { comparison: next, accepted: accepted.map((file) => file.path) };
  }

  async retain(comparison: Pick<CheckpointComparison, 'root' | 'before' | 'after'>): Promise<void> {
    const run = gitIn(comparison.root), key = digest(JSON.stringify([comparison.root, comparison.before, comparison.after]));
    for (const [side, tree] of [['before', comparison.before], ['after', comparison.after]]) {
      await run(['update-ref', `refs/redline/review-requests/${key}/${side}`, tree!]);
    }
  }
}
