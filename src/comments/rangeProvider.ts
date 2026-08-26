import * as vscode from 'vscode';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import { Config } from '../config';
import { locationForUri } from './uriMapping';

const ALLOWED_SCHEMES = new Set(['file', 'git', 'vscode-vfs']);

export class RangeProvider implements vscode.CommentingRangeProvider {
  constructor(private readonly config: Config) {}

  isSupported(document: vscode.TextDocument): boolean {
    if (!ALLOWED_SCHEMES.has(document.uri.scheme)) return false;
    if (document.lineCount > this.config.maxFileLines) return false;
    const loc = locationForUri(document.uri);
    if (!loc) return false;
    if (loc.side === 'base') return false; // the left side of a diff is read-only history
    const rel = loc.path;
    const base = path.posix.basename(rel);
    for (const glob of this.config.excludeGlobs) {
      if (minimatch(rel, glob, { dot: true }) || minimatch(base, glob, { dot: true, matchBase: true })) {
        return false;
      }
    }
    return true;
  }

  provideCommentingRanges(document: vscode.TextDocument): vscode.ProviderResult<vscode.Range[]> {
    if (!this.isSupported(document)) return undefined;
    return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
  }
}
