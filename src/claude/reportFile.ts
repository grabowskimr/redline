import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { touchedLogPath } from './touched';

/**
 * The report a run leaves behind, as a file rather than as prose.
 *
 * Outcomes used to be recovered by scanning the transcript for lines shaped like
 * `#12 done — …`. That works until it does not: a model that writes `#12 — done`, or puts the
 * line inside a code fence, or summarises three notes in one sentence, produces "0 of 3
 * addressed" with everything actually addressed. The prompt now names a path and asks for
 * JSON, which is either there and unambiguous or absent — and prose parsing stays as the
 * fallback for when it is absent.
 *
 * Consumed on read: renamed aside so the same report cannot be applied to a later round.
 */

export interface ReportEntry {
  /** The note's number, as shown in the panel and the prompt. */
  seq: number;
  outcome: 'done' | 'skipped' | 'answered';
  /** One line about what happened, shown beside the note. */
  text?: string;
}

export function reportPath(root: string, home?: string): string {
  return path.join(path.dirname(touchedLogPath(root, home)), 'report.json');
}

function entriesFrom(value: unknown): ReportEntry[] {
  const raw = (value as { notes?: unknown })?.notes ?? value;
  if (!Array.isArray(raw)) return [];
  const out: ReportEntry[] = [];
  for (const item of raw) {
    const e = item as Partial<ReportEntry> & { note?: unknown; id?: unknown };
    // `seq` is what the prompt asks for; `note` and `id` are what a model reaches for anyway.
    const seq = Number(e.seq ?? e.note ?? e.id);
    if (!Number.isInteger(seq) || seq <= 0) continue;
    const word = String(e.outcome ?? '').toLowerCase();
    const outcome: ReportEntry['outcome'] =
      word === 'done' || word === 'fixed'
        ? 'done'
        : word.startsWith('skip') || word === 'declined'
          ? 'skipped'
          : 'answered';
    const entry: ReportEntry = { seq, outcome };
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (text) entry.text = text;
    out.push(entry);
  }
  return out;
}

/**
 * Read and consume the report, if a run left one.
 *
 * Renamed rather than deleted: if anything goes wrong applying it, the file still exists to be
 * looked at instead of being gone with no trace.
 */
export async function takeReport(root: string, home?: string): Promise<ReportEntry[] | undefined> {
  const file = reportPath(root, home);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined; // no report: the prose fallback answers
  }
  let entries: ReportEntry[];
  try {
    entries = entriesFrom(JSON.parse(raw));
  } catch {
    entries = [];
  }
  try {
    await fs.rename(file, `${file}.applied`);
  } catch {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
  return entries.length > 0 ? entries : undefined;
}

/** Throw away a report nobody is going to apply — a new round is starting. */
export async function discardReport(root: string, home?: string): Promise<void> {
  await fs.rm(reportPath(root, home), { force: true }).catch(() => undefined);
}
