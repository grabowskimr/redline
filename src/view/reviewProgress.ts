import { createHash } from 'node:crypto';

export interface FileFingerprint { path: string; before: string; after: string }

/** Review marks describe file contents on both sides, independently of other files. */
export class ReviewProgress {
  private readonly marks = new Set<string>();

  constructor(saved?: unknown) {
    if (Array.isArray(saved)) {
      for (const key of saved.slice(-2000)) if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) this.marks.add(key);
    }
  }

  private key(root: string, scope: string, file: FileFingerprint): string {
    return createHash('sha256').update(JSON.stringify([root, scope, file.path, file.before, file.after])).digest('hex');
  }

  isReviewed(root: string, scope: string, file: FileFingerprint): boolean {
    return this.marks.has(this.key(root, scope, file));
  }

  mark(root: string, scope: string, file: FileFingerprint, reviewed: boolean): void {
    const key = this.key(root, scope, file);
    this.marks.delete(key);
    if (reviewed) this.marks.add(key);
    while (this.marks.size > 2000) this.marks.delete(this.marks.values().next().value!);
  }

  snapshot(): string[] { return [...this.marks]; }
}
