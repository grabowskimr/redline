/**
 * Which files are images, by name.
 *
 * Used by the attachment store, and kept out of it: `store/attachments.ts` imports `vscode`,
 * and a predicate this small should be testable without an editor. It lived beside the drop
 * parsing in `view/` for a while, which made `store/` and `view/` point at each other for nine
 * lines — the shape of mistake `model/` exists to absorb.
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
