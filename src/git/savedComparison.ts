import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRunner, treeChanges } from './snapshotTree';
import { treeSide } from './treeSide';
import { emptySide } from './emptySide';

export type DiffPair = [vscode.Uri, vscode.Uri, vscode.Uri];

export function gitIn(root: string): GitRunner {
  return (args, env) => new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { env: { ...process.env, ...env }, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)).stdin?.end();
  });
}

export async function savedDiff(root: string, before: string, after: string): Promise<DiffPair[]> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before opening saved changes.');
  if (![before, after].every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Invalid saved comparison.');
  const changes = await treeChanges(before, after, gitIn(root));
  return [...changes].map(([rel, status]) => {
    const file = vscode.Uri.file(path.join(root, rel));
    return [file,
      status.kind === 'added' ? emptySide(file, 'new file') : treeSide(root, before, status.kind === 'renamed' ? status.from : rel),
      status.kind === 'deleted' ? emptySide(file, 'deleted') : treeSide(root, after, rel),
    ];
  });
}

