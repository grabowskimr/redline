/**
 * Parse unified-diff hunk headers into 0-based inclusive line ranges on the *new* side.
 * `@@ -a,b +c,d @@` → lines c-1 .. c-1+d-1. A hunk with d=0 (pure deletion) yields nothing.
 * Pure module — no `vscode` imports.
 */
export function parseHunks(diff: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    out.push({ start: start - 1, end: start - 1 + count - 1 });
  }
  return out;
}

export interface FileHunks {
  /** Path on the new side (b/…), repo-relative. */
  path: string;
  /** 0-based inclusive ranges on the new side. `deletion` marks a pure removal point. */
  hunks: Array<{ start: number; end: number; deletion?: boolean }>;
}

/**
 * Parse a whole `git diff -U0` document into per-file hunks, *including* pure deletions
 * (`+c,0`), which are represented as a single-line marker at the join point — without
 * this, a file where only lines were removed would disappear from "what changed".
 */
export function parseDiffByFile(diff: string): FileHunks[] {
  const out: FileHunks[] = [];
  let current: FileHunks | undefined;
  let oldPath: string | undefined;
  for (const line of diff.split('\n')) {
    const o = /^--- a\/(.*)$/.exec(line);
    if (o) {
      oldPath = o[1];
      continue;
    }
    if (line.startsWith('--- /dev/null')) {
      oldPath = undefined;
      continue;
    }
    const f = /^\+\+\+ b\/(.*)$/.exec(line);
    if (f) {
      current = { path: f[1] ?? '', hunks: [] };
      out.push(current);
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      // The whole file is gone. Keep it under its old name with one marker at line 0 so
      // it stays reachable when walking the changes, and skip its (new-side-empty) hunks.
      if (oldPath) out.push({ path: oldPath, hunks: [{ start: 0, end: 0, deletion: true }] });
      current = undefined;
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && current) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0) {
        // `+c,0`: lines were removed between c and c+1 (1-based) → mark the join line.
        const at = Math.max(start - 1, 0);
        current.hunks.push({ start: at, end: at, deletion: true });
      } else {
        current.hunks.push({ start: start - 1, end: start - 1 + count - 1 });
      }
    }
  }
  return out.filter((f) => f.hunks.length > 0);
}

