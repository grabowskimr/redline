import { gitIn } from './savedComparison';
import { nulFields } from './snapshotTree';

export interface FileDiffStats { added: number; deleted: number; binary: boolean }

/** NUL records preserve tabs/newlines in filenames and Git's two-path rename form. */
export function parseDiffStats(output: string): Map<string, FileDiffStats> {
  const fields = nulFields(output), result = new Map<string, FileDiffStats>();
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]!, first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first), deleted = record.slice(first + 1, second);
    let name = record.slice(second + 1);
    if (!name) { i++; name = fields[++i] ?? ''; }
    const binary = added === '-' && deleted === '-';
    if (!name || (!binary && (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)))) continue;
    result.set(name, { added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary });
  }
  return result;
}

export async function diffStats(root: string, before: string, after: string): Promise<Map<string, FileDiffStats>> {
  return parseDiffStats(await gitIn(root)(['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', before, after, '--']));
}
