import { fenceFor, RenderedNote, RenderModel, shortSha } from '../renderBatch';

export function gitLine(m: RenderModel): string | undefined {
  if (!m.config.includeGitContext || !m.git) return undefined;
  const parts: string[] = [];
  if (m.git.repoName) parts.push(`**Repo:** ${m.git.repoName}`);
  if (m.git.branch) parts.push(`**Branch:** ${m.git.branch}`);
  if (m.git.sha) parts.push(`**HEAD:** ${shortSha(m.git.sha)}${m.git.dirty ? ' (uncommitted changes present)' : ''}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function quote(text: string): string {
  return text.includes('\n') ? `\n"""\n${text}\n"""` : `"${text}"`;
}

function noteBlock(n: RenderedNote): string[] {
  const out: string[] = [];
  const where = n.startLine === n.endLine ? `Line ${n.startLine}` : `Lines ${n.startLine}-${n.endLine}`;
  const stale = n.orphaned ? ' (may be stale — the code has changed since the note was written)' : '';
  out.push(`### #${n.seq} — ${n.path} · ${where}${stale}`);
  if (n.kind !== 'comment') out.push(`Kind: ${n.kind}`);
  if (n.snippet !== undefined) {
    const f = fenceFor(n.snippet);
    out.push(n.orphaned ? 'Original code:' : 'Code:', `${f}${n.language ?? ''}`, n.snippet, f);
  }
  out.push(`User comment: ${quote(n.bodyWithAddenda)}`);
  for (const a of n.attachments) {
    out.push(`Screenshot: ${a} (read this image file — it is part of the feedback)`);
  }
  if (n.suggestion !== undefined) {
    const f = fenceFor(n.suggestion);
    out.push('Suggested change:', `${f}${n.language ?? ''}`, n.suggestion, f);
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
  if (fyi.length) parts.push(`${fyi.length} FYI`);
  out.push(
    m.followUp
      ? `Following up on feedback you have already worked on: ${parts.join(', ')}. The exchange so far is under each note, newest last.`
      : `I reviewed the generated code and have some feedback: ${parts.join(', ')}.`,
  );

  const rules: string[] = [];
  if (changes.length) {
    rules.push('Work through the change requests in order; if one is unclear or you disagree, say so and ask before changing it.');
  }
  if (ideas.length) {
    rules.push('The ideas are enhancements on top of the current code: implement them if they are straightforward, otherwise sketch the approach and ask first.');
  }
  if (questions.length) {
    rules.push(
      changes.length || ideas.length
        ? 'Answer the questions first — only change code for a question if we agree.'
        : 'Please answer each question before changing anything.',
    );
  }
  if (fyi.length) rules.push('The FYI notes need no action.');
  if (m.config.scopeGuard) rules.push("Only touch the files listed below; don't make unrelated changes.");
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
  section('Questions', questions);
  section('FYI', fyi);

  if (m.config.requestReport) {
    out.push(
      '## When you are done',
      '',
      'Reply with one line per note so I can track it, using exactly this format:',
      '`#<number> done — <what you changed>` · `#<number> skipped — <why>` · `#<number> answer: <your answer>`',
      '',
      'Say what you actually did in each line, briefly — the line is kept beside the note as ' +
        'your side of the conversation, and "done" on its own leaves nothing to read next to ' +
        'code that has changed.',
      '',
    );
  }
  return out.join('\n');
}
