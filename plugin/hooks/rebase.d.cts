export function captureRebaseCursor(root: string): Promise<string>;
export function adjustForRebases(
  root: string,
  before: { tree: string; at: string; rebaseCursor?: string },
  until: { at: string; rebaseCursor?: string },
  git: (args: string[]) => Promise<string>,
): Promise<{ tree: string; rebaseCursor: string; rebased: boolean }>;
