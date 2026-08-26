/**
 * Parsing of a dropped payload. Free of `vscode` so it can be unit-tested: the webview
 * hands over the raw `text/uri-list` (or `text/plain`) string and the extension decides
 * what it means.
 */

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'heic',
  'tif',
  'tiff',
]);

export function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}

/** Absolute local paths from a `text/uri-list` payload, in order, without duplicates. */
export function parseDroppedPaths(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let candidate = trimmed;
    if (/^file:\/\//i.test(candidate)) {
      candidate = candidate.replace(/^file:\/\/(localhost)?/i, '');
      try {
        candidate = decodeURIComponent(candidate);
      } catch {
        continue; // malformed encoding: skip rather than throw
      }
    }
    if (!candidate.startsWith('/')) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}
