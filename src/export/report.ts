/**
 * Parse an agent's report-back: lines like
 *   #12 done
 *   #13 skipped — reason
 *   #14 answer: text
 * Tolerant to surrounding prose, numbered or bulleted lists, markdown emphasis/backticks and
 * `—`/`-`/`:` separators, and to more than one note on a line.
 * Pure module — no `vscode` imports.
 */
export interface ReportItem {
  seq: number;
  outcome: 'done' | 'skipped' | 'answered';
  text?: string;
}

/*
 * Every marker in a line, wherever it falls — not one anchored to the start of it.
 *
 * Three failures, each of which reports a note as unanswered while the work was done, which is
 * the failure this whole protocol exists to avoid.
 *
 *   - The anchored pattern admitted `-`, `*` and `>` in front of the `#` and nothing else, so
 *     a numbered list — the most likely shape for "one line per note" — did not match at all:
 *     neither `1. #12 done — renamed the prop` nor `2) #13 skipped — no`, and neither did a
 *     line that opens with a word, `Note #12 done — …`.
 *   - A line holding two notes matched once. `#12 done — fixed it. #13 skipped — not now`
 *     yielded #12 alone, with #13's words swallowed into #12's answer: #13 reported nothing
 *     *and* #12's card showed the wrong sentence.
 *   - Markdown falls anywhere inside the marker, because models write this line as prose and
 *     format it like prose: `**#1 done** — …`, `#1 **done** — …`, `- *#1 answered*: …`.
 *
 * The trailing run is part of the marker so the emphasis closing it, and the separator behind
 * that, do not end up at the front of the text.
 */
const MARKER_RE =
  /#\s*(\d+)[`*_\s]*[:\-—]?[\s`*_]*(done|skipped|skip|answer(?:ed)?|fixed|declined)\b[`*_\s]*[:\-—]?/gi;

/** A fence opening or closing, whatever its length. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Emphasis left over in front of the text, and the separator behind it.
 *
 * Only where a separator follows, so `*Renamed* the prop` keeps the word it is emphasising:
 * the run is stripped when it is punctuation about the marker, not when it is part of the
 * sentence.
 */
function unwrap(text: string): string {
  const led = text
    .trim()
    .replace(/^[*_`]+\s*(?=[:\-—])/, '')
    .replace(/^[:\-—]+\s*/, '')
    .trim();
  // A wrapper is only a wrapper if it closes what it opened *and nothing else*. Stripping the
  // outermost pair on its own ate the backticks off ``#12 done — `foo.ts:12` now guards `bar` ``
  // — leaving two orphans in the middle — and turned `*a* b *c*` into `a* b *c`. A file
  // reference is the one thing in these lines worth keeping intact, since the panel renders it
  // as a link.
  const wrapped = /^([*_`]+)([\s\S]+?)\1$/.exec(led);
  const inner = wrapped?.[2];
  const body = inner !== undefined && !inner.includes(wrapped?.[1]?.[0] ?? '') ? inner.trim() : led;
  // Nothing but punctuation is nothing: what is left of `- \`#12 done\`` is a stray backtick,
  // and what is left of `#12 done. #13 …` once #13's span is taken away is a full stop.
  return /[\p{L}\p{N}]/u.test(body) ? body : '';
}

function itemsIn(line: string): ReportItem[] {
  const hits = [...line.matchAll(MARKER_RE)];
  const out: ReportItem[] = [];
  for (let at = 0; at < hits.length; at += 1) {
    const m = hits[at];
    if (!m) continue;
    // A marker's text stops where the next marker starts. Reading to the end of the line is
    // what let one note's answer swallow the note after it.
    const start = (m.index ?? 0) + m[0].length;
    const end = hits[at + 1]?.index ?? line.length;
    const word = (m[2] ?? '').toLowerCase();
    const item: ReportItem = {
      seq: Number(m[1]),
      outcome:
        word === 'done' || word === 'fixed'
          ? 'done'
          : word.startsWith('skip') || word === 'declined'
            ? 'skipped'
            : 'answered',
    };
    const rest = unwrap(line.slice(start, end));
    if (rest) item.text = rest;
    out.push(item);
  }
  return out;
}

function scan(lines: readonly string[], skipFenced: boolean): ReportItem[] {
  const out = new Map<number, ReportItem>();
  let fence: string | undefined;
  for (const raw of lines) {
    const marker = FENCE_RE.exec(raw)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (skipFenced && fence !== undefined) continue;
    for (const item of itemsIn(raw)) out.set(item.seq, item); // later markers win
  }
  return [...out.values()];
}

export function parseReport(text: string): ReportItem[] {
  const lines = text.split(/\r?\n/);
  const loose = scan(lines, true);
  // A fenced block is where these lines used to get lost, and it is also where a model quotes
  // the template or shows an example — so what is inside one is not a result. Read anyway when
  // skipping means reporting nothing at all: a model that puts its whole list in a fence is
  // still answering, and silence there is the failure this exists to prevent.
  return loose.length > 0 ? loose : scan(lines, false);
}
