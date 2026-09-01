import { NoteKind } from '../../model/note';
import { fenceFor, RenderedNote, RenderModel, shortSha } from '../renderBatch';

export function gitLine(m: RenderModel): string | undefined {
  if (!m.config.includeGitContext || !m.git) return undefined;
  const parts: string[] = [];
  if (m.git.repoName) parts.push(`**Repo:** ${m.git.repoName}`);
  if (m.git.branch) parts.push(`**Branch:** ${m.git.branch}`);
  if (m.git.sha) parts.push(`**HEAD:** ${shortSha(m.git.sha)}${m.git.dirty ? ' (uncommitted changes present)' : ''}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * What each kind allows, said next to the note rather than only in a section header.
 *
 * A note is read where it sits. A rule three screens up in the preamble is a rule that is not
 * in front of you when you decide what to do with note #14.
 *
 * Typed against the kinds themselves rather than `string`, so adding one to `NOTE_KINDS` and
 * forgetting it here is a compile error and not a note that reaches the agent with a bare
 * `Kind: whatever —` and no instruction after it. `comment` is the exception by design: it is
 * the kind you pick when the note says what it wants in its own words.
 */
const KIND_RULE: Record<Exclude<NoteKind, 'comment'>, string> = {
  bug: 'something is wrong here. Fix it.',
  security: 'a vulnerability or unsafe handling of data. Fix it.',
  perf: 'too slow or too costly. Change it, and say what the cost was.',
  idea: 'a suggestion, not an instruction. If it is straightforward, do it; otherwise sketch the approach and ask first.',
  refactor: 'same behaviour, better structure. Do not change what it does.',
  question: '**answer only. Change nothing** — not the code, not the tests, not a comment. If answering makes you want to change something, say what and why, and stop.',
  todo: 'later work, not now. Note it and move on; do not start it.',
  nit: 'a small thing — naming, formatting, style. Fix it if it is genuinely trivial, otherwise leave it.',
  praise: 'no action. Nothing to do here.',
};

function quote(text: string): string {
  return text.includes('\n') ? `\n"""\n${text}\n"""` : `"${text}"`;
}

function noteBlock(n: RenderedNote): string[] {
  const out: string[] = [];
  const where = n.startLine === n.endLine ? `Line ${n.startLine}` : `Lines ${n.startLine}-${n.endLine}`;
  // Three different things, and the agent acts on them differently: the file is gone, the
  // lines have moved, or this is the code as it stands. Saying "Code:" for a file you deleted
  // an hour ago invites you to go and edit it again.
  const stale = n.missing
    ? ' (this file is no longer on disk)'
    : n.orphaned
      ? ' (may be stale — the code has changed since the note was written)'
      : '';
  out.push(`### #${n.seq} — ${n.path} · ${where}${stale}`);
  // The kind said what it was called and nothing about what it permits. `Kind: question`
  // left the door open, and questions came back with the code changed.
  if (n.kind !== 'comment') out.push(`Kind: ${n.kind} — ${KIND_RULE[n.kind]}`);
  if (n.snippet !== undefined) {
    const f = fenceFor(n.snippet);
    out.push(n.missing || n.orphaned ? 'Original code:' : 'Code:', `${f}${n.language ?? ''}`, n.snippet, f);
  }
  /*
   * The note, then what has been said about it, then what is being asked now.
   *
   * All three used to be one block under "User comment:" — including the agent's own replies,
   * so it read its own words back as the user's, with the same `↳` in front of both and
   * nothing marking which part was new. On a note that had been round twice, the thing
   * actually being asked for was the last line of a quote with no label on it.
   */
  out.push(`User comment: ${quote(n.body.trimEnd())}`);
  if (n.thread?.length) {
    out.push('Already said about this note, oldest first:');
    for (const turn of n.thread) out.push(`  - ${turn.mine ? 'me' : 'you'}: ${turn.text}`);
  }
  if (n.followUp) {
    out.push(`Follow-up — this is what to do now: ${quote(n.followUp)}`);
  }
  for (const a of n.attachments) {
    out.push(`Screenshot: ${a} (read this image file — it is part of the feedback)`);
  }
  return out;
}

/**
 * The prompt pasted into a Claude Code session: a short hand-off grouped by intent, so
 * change requests, ideas and questions each get the treatment they need.
 */
export function claudePrompt(m: RenderModel): string {
  if (m.count === 0) return 'I reviewed the generated code — no feedback this time.\n';
  const all = [...m.files.flatMap((f) => f.notes), ...m.orphans];
  const changes = all.filter((n) => n.intent === 'change');
  const ideas = all.filter((n) => n.intent === 'idea');
  const questions = all.filter((n) => n.intent === 'question');
  const fyi = all.filter((n) => n.intent === 'fyi');

  const out: string[] = [];
  const parts: string[] = [];
  if (changes.length) parts.push(`${changes.length} change request${changes.length === 1 ? '' : 's'}`);
  if (ideas.length) parts.push(`${ideas.length} idea${ideas.length === 1 ? '' : 's'}`);
  if (questions.length) parts.push(`${questions.length} question${questions.length === 1 ? '' : 's'}`);
  // `fyi` is where both `todo` and `praise` land, and calling three todos "3 FYI" loses the
  // word the reader actually typed — the one that says this is later work, not a remark.
  const todos = fyi.filter((n) => n.kind === 'todo').length;
  const remarks = fyi.length - todos;
  if (todos) parts.push(`${todos} todo${todos === 1 ? '' : 's'}`);
  if (remarks) parts.push(`${remarks} FYI`);
  const exchange = 'The exchange so far is under each note, newest last.';
  out.push(
    m.followUp
      ? `Following up on feedback you have already worked on: ${parts.join(', ')}. ${exchange}`
      : m.threads
        ? // A mixed batch: new notes alongside replies to ones already answered. Without this
          // the threads arrive with nothing to say what they are.
          `I reviewed the generated code and have some feedback: ${parts.join(', ')}. Some of these continue notes you have already worked on. ${exchange}`
        : `I reviewed the generated code and have some feedback: ${parts.join(', ')}.`,
  );

  const rules: string[] = [];
  if (changes.length) {
    // Defers to the note. "Work through them in order" on its own overrode the line on each
    // note — a nit says to fix it only if it is genuinely trivial and otherwise leave it, and
    // a section telling you to do them all is read as permission to ignore that.
    rules.push(
      'Work through the change requests in order, following the rule on each note — where a ' +
        'note says you may leave something, leaving it is an answer. If one is unclear or you ' +
        'disagree, say so and ask before changing it.',
    );
  }
  if (ideas.length) {
    rules.push('The ideas are enhancements on top of the current code: implement them if they are straightforward, otherwise sketch the approach and ask first.');
  }
  if (questions.length) {
    // Absolute, and it was not before: "answer first" and "before changing anything" both read
    // as *when* to change rather than *whether*, and questions came back with edits attached.
    rules.push(
      '**Questions are answer-only. Do not change any code for a question** — not even ' +
        'something you are confident about, and not a comment or a test. If a question makes ' +
        'you want to change something, say what you would change and why, and leave it.',
    );
  }
  if (fyi.length) rules.push('The FYI notes need no action — do not change anything for them.');
  // Only where something may be changed at all, and named the way the prompt actually names
  // them. There is no file list below — each note carries its own path — and on a
  // questions-only or FYI-only batch this granted permission to touch files one line after
  // saying to change nothing.
  if (m.config.scopeGuard && (changes.length > 0 || ideas.length > 0)) {
    rules.push("Only touch the files these notes point at; don't make unrelated changes.");
  }
  out.push(rules.join(' '), '');

  const git = gitLine(m);
  if (git) out.push(git, '');

  const section = (title: string, notes: RenderedNote[]): void => {
    if (!notes.length) return;
    out.push(`## ${title}`, '');
    for (const n of notes) out.push(...noteBlock(n), '');
  };
  section('Change requests', changes);
  section('Ideas', ideas);
  section('Questions — answer only, change nothing', questions);
  section('FYI', fyi);

  if (m.config.requestReport && m.reportPath) {
    // A file, not prose. Scanning the transcript for `#12 done` lines worked until a model
    // wrote `#12 — done`, or put the line in a code fence, or covered three notes in one
    // sentence — and then the panel said nothing had been addressed when everything had.
    out.push(
      '## Reporting back',
      '',
      `Write this JSON to \`${m.reportPath}\` (create the file; overwrite it if it exists):`,
      '',
      '```json',
      '{ "notes": [',
      '    { "seq": 12, "outcome": "done", "text": "one sentence about what changed" },',
      '    { "seq": 13, "outcome": "skipped", "text": "why not" },',
      '    { "seq": 14, "outcome": "answered", "text": "your answer" }',
      '] }',
      '```',
      '',
      // The reader is watching a panel while this runs. Reporting once at the end means a card
      // whose code has visibly changed sits saying nothing until the whole turn finishes,
      // which on a batch of a dozen notes is a long time to watch nothing happen.
      '**Write it as you go, not once at the end.** Each time you finish a note, write the ' +
        'file again with every note you have settled so far, that one included. It is read ' +
        'while you work, and rewriting the whole list each time is what keeps it consistent ' +
        'if a write is caught halfway.',
      '',
      '`outcome` is `done`, `skipped` or `answered`. Keep `text` to one sentence: it is shown ' +
        'beside the note in a narrow panel, so say what changed and stop. Point at code as ' +
        '`[file.ts:12](path/to/file.ts)`, which is rendered as a short link.',
      '',
      // One per line, and shown one per line. Three of them joined by `·` taught the shape
      // `#12 done — fixed it. #13 skipped — not now`, and a line holding two notes reported
      // one: #13 said nothing and #12's card showed #13's words.
      'Then say the same thing in your reply, one note per line — never two on one line — so it is readable here too:',
      '`#<number> done — <what you changed>`',
      '`#<number> skipped — <why>`',
      '`#<number> answer: <your answer>`',
      '',
    );
  } else if (m.config.requestReport) {
    out.push(
      '## When you are done',
      '',
      'Reply with one line per note so I can track it, one note per line — never two on one line — using exactly this format:',
      '`#<number> done — <what you changed>`',
      '`#<number> skipped — <why>`',
      '`#<number> answer: <your answer>`',
      '',
      'Keep each line to one sentence. It is shown beside the note in a narrow panel, so say ' +
        'what changed and stop — "done" alone leaves nothing to read next to code that moved, ' +
        'and three paragraphs are worse than one line. Point at code as ' +
        '`[file.ts:12](path/to/file.ts)`, which is rendered as a short link.',
      '',
    );
  }
  return out.join('\n');
}
