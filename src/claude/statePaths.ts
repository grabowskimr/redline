import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const roots = new Map<string, string>();

/** Worktrees have a .git file; ordinary repositories have a .git directory. */
export function repositoryRoot(cwd: string): string {
  let absolute: string;
  try { absolute = fs.realpathSync(cwd); } catch { absolute = path.resolve(cwd); }
  let candidate = absolute;
  for (;;) {
    if (fs.existsSync(path.join(candidate, '.git'))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return absolute;
    candidate = parent;
  }
}

/** Redline owns this namespace. Claude's transcript slug remains unchanged. */
export function stateKey(cwd: string): string {
  const root = repositoryRoot(cwd);
  const key = `repo-${createHash('sha256').update(root).digest('hex')}`;
  roots.set(key, root);
  return key;
}

export function stateDirectory(cwd: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'redline', stateKey(cwd));
}

export function registeredRoot(key: string): string | undefined {
  return roots.get(key);
}

export function registerStateRoot(key: string, root: string): boolean {
  return stateKey(root) === key;
}
