/**
 * Parse an agent's report-back: lines like
 *   #12 done
 *   #13 skipped — reason
 *   #14 answer: text
 * Tolerant to surrounding prose, markdown bullets/backticks and `—`/`-`/`:` separators.
 * Pure module — no `vscode` imports.
 */
export interface ReportItem {
  seq: number;
  outcome: 'done' | 'skipped' | 'answered';
  text?: string;
}

const LINE_RE = /^[\s*\->`]*#(\d+)[`\s]*[:\-—]?\s*(done|skipped|skip|answer(?:ed)?|fixed|declined)\b[`\s]*[:\-—]?\s*(.*?)[`\s]*$/i;

export function parseReport(text: string): ReportItem[] {
  const out = new Map<number, ReportItem>();
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const seq = Number(m[1]);
    const word = (m[2] ?? '').toLowerCase();
    const rest = (m[3] ?? '').trim();
    const outcome: ReportItem['outcome'] =
      word === 'done' || word === 'fixed' ? 'done' : word.startsWith('skip') || word === 'declined' ? 'skipped' : 'answered';
    const item: ReportItem = { seq, outcome };
    if (rest) item.text = rest;
    out.set(seq, item); // later lines win
  }
  return [...out.values()];
}
