import * as assert from 'node:assert/strict';
import { RenderConfig } from '../../config';
import { createAnchor } from '../../anchor/anchorService';
import { KIND_META, KINDS_BY_WEIGHT, ReviewNote } from '../../model/note';
import { KIND_GLYPH } from '../../model/kindGlyphs';
import { buildModel, fenceFor, renderBatch, SnippetSource } from '../../export/renderBatch';
import { parseReport } from '../../export/report';
import { note, range } from './fixtures';

const cfg = (over: Partial<RenderConfig> = {}): RenderConfig => ({
  outputTemplate: 'claude-prompt',
  includeSnippet: true,
  includeGitContext: true,
  scopeGuard: false,
  requestReport: false,
  ...over,
});

const HOST = [
  ...Array.from({ length: 141 }, (_, i) => `// line ${i + 1}`),
  '  const thread = controller.createCommentThread(uri, range, []);', // 142
  '  thread.comments = [comment];',
  '  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;', // 144
  ...Array.from({ length: 58 }, (_, i) => `// line ${i + 145}`),
  '  this.threads.clear();', // 203
].join('\n');
const STORE = [...Array.from({ length: 43 }, (_, i) => `// s${i}`), '  const notes = this.state.active.notes.filter(n => n.id !== id);', '  x', '  y'].join('\n');

const files: Record<string, string> = { 'src/comments/commentHost.ts': HOST, 'src/store/reviewStore.ts': STORE };
const source: SnippetSource = { textFor: (n) => files[n.path] };

function fixtureNotes(): ReviewNote[] {
  const mk = (path: string, r: ReturnType<typeof range>, over: Partial<ReviewNote>): ReviewNote =>
    note({ path, range: r, anchor: createAnchor(files[path] ?? '', r), languageId: 'typescript', ...over });
  return [
    mk('src/store/reviewStore.ts', range(43, 45), { id: 'n3', seq: 3, kind: 'nit', body: '`delete` takes an array of ids elsewhere in this class — make this consistent.', order: 2 }),
    mk('src/comments/commentHost.ts', range(202), { id: 'n2', seq: 2, kind: 'question', body: 'Are the disposed threads actually released here, or do we leak the `CommentThread`\nobjects because the map holds the last reference? Check whether `dispose()` is called\nbefore `clear()`.', order: 1 }),
    mk('src/comments/commentHost.ts', range(141, 149), {
      id: 'n1', seq: 1, kind: 'bug', order: 0,
      body: 'Recreating the thread here makes the widget flicker and lose focus when a note is edited.\nMutate the existing thread instead, and reassign `thread.comments` rather than pushing\ninto it.',
      suggestion: '  const existing = this.threadsByNoteId.get(note.id);\n  if (existing) {\n    existing.comments = [new NoteComment(note.id, note)];\n    return existing;\n  }',
    }),
  ];
}

const git = { repoName: 'orca', branch: 'feat/pr-parity', sha: 'a1b2c3d4e5f6', dirty: true };
const now = new Date(2026, 7, 23, 14, 2, 11);

describe('renderBatch model', () => {
  it('filters to active notes, groups by file alphabetically, sorts by line, 1-based', () => {
    const notes = [...fixtureNotes(), note({ id: 'done', done: true })];
    const m = buildModel(notes, { config: cfg(), source, now });
    assert.equal(m.count, 3);
    assert.equal(m.fileCount, 2);
    assert.deepEqual(m.files.map((f) => f.path), ['src/comments/commentHost.ts', 'src/store/reviewStore.ts']);
    const first = m.files[0]?.notes ?? [];
    assert.deepEqual(first.map((n) => [n.seq, n.lineRange, n.startLine, n.endLine]), [
      [1, 'L142-150', 142, 150],
      [2, 'L203', 203, 203],
    ]);
    assert.equal(m.files[1]?.notes[0]?.seq, 3);
    assert.deepEqual(m.kindCounts.map((k) => `${k.kind}:${k.count}`), ['bug:1', 'question:1', 'nit:1']);
  });

  it('empty batch', () => {
    const m = buildModel([], { config: cfg(), now });
    assert.equal(m.count, 0);
    const text = renderBatch([], { config: cfg(), now });
    assert.ok(text.includes('no feedback this time'));
  });

  it('snippet truncation', () => {
    const src: SnippetSource = { textFor: () => HOST };
    const big = note({ path: 'a.ts', range: range(0, 99) });
    const m2 = buildModel([big], { config: cfg(), source: src });
    const lines = (m2.files[0]?.notes[0]?.snippet ?? '').split('\n');
    assert.equal(lines.length, 41);
    assert.equal(lines[40], '… (60 more lines)');
  });

  it('falls back to the stored snippet when the file is unavailable', () => {
    const n = note({ path: 'gone.ts', anchor: { ...note().anchor, snippet: 'stored text' } });
    const m = buildModel([n], { config: cfg(), source: { textFor: () => undefined } });
    assert.equal(m.files[0]?.notes[0]?.snippet, 'stored text');
  });

  it('orphans go to the trailing section with stored snippet', () => {
    const n = note({ id: 'o', path: 'z.ts', anchor: { ...note().anchor, snippet: 'old code', orphaned: true } });
    const m = buildModel([n, note({ id: 'k', path: 'a.ts' })], { config: cfg(), source, now });
    assert.equal(m.files.length, 1);
    assert.equal(m.orphans.length, 1);
    assert.equal(m.orphans[0]?.seq, 1);
    assert.equal(m.orphans[0]?.snippet, 'old code');
    const text = renderBatch([n], { config: cfg(), source, now });
    assert.ok(text.includes('may be stale'));
    assert.ok(text.includes('Original code:\n```ts\nold code\n```'));
  });

  it('respects onlyIds', () => {
    const m = buildModel(fixtureNotes(), { config: cfg(), onlyIds: ['n2'] });
    assert.equal(m.count, 1);
    assert.equal(m.files[0]?.notes[0]?.note.id, 'n2');
  });
});

describe('claude-prompt formatter (default)', () => {
  it('groups by intent with stable #numbers, code and comment', () => {
    const text = renderBatch(fixtureNotes(), { config: cfg({ includeGitContext: false }), source, now });
    assert.equal(
      text,
      [
        'I reviewed the generated code and have some feedback: 2 change requests, 1 question.',
        'Work through the change requests in order; if one is unclear or you disagree, say so and ask before changing it. Answer the questions first — only change code for a question if we agree.',
        '',
        '## Change requests',
        '',
        '### #1 — src/comments/commentHost.ts · Lines 142-150',
        'Kind: bug',
        'Code:',
        '```ts',
        '  const thread = controller.createCommentThread(uri, range, []);',
        '  thread.comments = [comment];',
        '  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;',
        '// line 145',
        '// line 146',
        '// line 147',
        '// line 148',
        '// line 149',
        '// line 150',
        '```',
        'User comment: ',
        '"""',
        'Recreating the thread here makes the widget flicker and lose focus when a note is edited.',
        'Mutate the existing thread instead, and reassign `thread.comments` rather than pushing',
        'into it.',
        '"""',
        'Suggested change:',
        '```ts',
        '  const existing = this.threadsByNoteId.get(note.id);',
        '  if (existing) {',
        '    existing.comments = [new NoteComment(note.id, note)];',
        '    return existing;',
        '  }',
        '```',
        '',
        '### #3 — src/store/reviewStore.ts · Lines 44-46',
        'Kind: nit',
        'Code:',
        '```ts',
        '  const notes = this.state.active.notes.filter(n => n.id !== id);',
        '  x',
        '  y',
        '```',
        'User comment: "`delete` takes an array of ids elsewhere in this class — make this consistent."',
        '',
        '## Questions',
        '',
        '### #2 — src/comments/commentHost.ts · Line 203',
        'Kind: question',
        'Code:',
        '```ts',
        '  this.threads.clear();',
        '```',
        'User comment: ',
        '"""',
        'Are the disposed threads actually released here, or do we leak the `CommentThread`',
        'objects because the map holds the last reference? Check whether `dispose()` is called',
        'before `clear()`.',
        '"""',
        '',
      ].join('\n'),
    );
  });

  it('plain comment notes look like the user example', () => {
    const a = note({ seq: 7, path: 'domains/hr/apps/grow/src/app/components/organisms/FormTemplate/AddButton/FormTemplateAddButton.styles.ts', range: range(9), body: 'test' });
    const b = note({ seq: 8, path: 'domains/hr/apps/grow/src/app/components/organisms/FormTemplate/EmptyState/FormTemplateEmptyState.styles.ts', range: range(13, 14), body: 'test 2' });
    const text = renderBatch([a, b], { config: cfg({ includeGitContext: false, includeSnippet: false }), now });
    assert.equal(
      text,
      [
        'I reviewed the generated code and have some feedback: 2 change requests.',
        'Work through the change requests in order; if one is unclear or you disagree, say so and ask before changing it.',
        '',
        '## Change requests',
        '',
        '### #7 — domains/hr/apps/grow/src/app/components/organisms/FormTemplate/AddButton/FormTemplateAddButton.styles.ts · Line 10',
        'User comment: "test"',
        '',
        '### #8 — domains/hr/apps/grow/src/app/components/organisms/FormTemplate/EmptyState/FormTemplateEmptyState.styles.ts · Lines 14-15',
        'User comment: "test 2"',
        '',
      ].join('\n'),
    );
  });

  it('questions-only, scope guard and report-back footer', () => {
    const text = renderBatch([note({ kind: 'question', body: 'why?' })], {
      config: cfg({ includeGitContext: false, includeSnippet: false, scopeGuard: true, requestReport: true }),
      now,
    });
    assert.ok(text.startsWith('I reviewed the generated code and have some feedback: 1 question.\nPlease answer each question before changing anything. Only touch the files listed below'));
    assert.ok(text.includes('## When you are done'));
    // The format asks for a sentence with every outcome: the line is kept beside the note as
    // Claude's side of the conversation, and a bare "done" leaves nothing to read there.
    assert.ok(text.includes('`#<number> done — <what you changed>`'));
    assert.match(text, /Keep each line to one sentence/);
    assert.equal(parseReport(text).length, 0, 'the footer itself must not parse as a report');
  });

  it('praise is FYI', () => {
    const text = renderBatch([note({ kind: 'praise', body: 'nice' })], { config: cfg({ includeGitContext: false, includeSnippet: false }), now });
    assert.ok(text.includes('1 FYI.\nThe FYI notes need no action.'));
    assert.ok(text.includes('## FYI'));
  });
});

describe('multi-root rendering', () => {
  it('keeps same relative path in different roots as separate files', () => {
    const a = note({ path: 'package.json', workspaceFolder: 'api', body: 'a' });
    const b = note({ path: 'package.json', workspaceFolder: 'web', body: 'b' });
    const m = buildModel([a, b], { config: cfg({ includeSnippet: false }), now });
    assert.equal(m.fileCount, 2);
    assert.deepEqual(m.files.map((f) => f.path), ['api/package.json', 'web/package.json']);
    const text = renderBatch([a, b], { config: cfg({ includeSnippet: false, includeGitContext: false }), now });
    assert.ok(text.includes('— api/package.json ·'));
    assert.ok(text.includes('— web/package.json ·'));
  });
});

describe('idea kind', () => {
  it('gets its own section and instruction', () => {
    const text = renderBatch([note({ kind: 'idea', body: 'also support dark mode here' })], { config: cfg({ includeGitContext: false, includeSnippet: false }), now });
    assert.ok(text.includes('1 idea.'));
    assert.ok(text.includes('The ideas are enhancements on top of the current code'));
    assert.ok(text.includes('## Ideas'));
  });
});

describe('prompt escaping and context', () => {
  it('uses 4-backtick fences when the code contains 3-backtick fences', () => {
    const n = note({
      suggestion: 'before\n```js\nx\n```\nafter',
      anchor: { ...note().anchor, snippet: '```\ncode\n```' },
      languageId: 'typescript',
    });
    const text = renderBatch([n], { config: cfg(), now });
    assert.ok(text.includes('````ts\n```\ncode\n```\n````'), 'snippet fence widened');
    assert.ok(text.includes('````ts\nbefore\n```js\nx\n```\nafter\n````'), 'suggestion fence widened');
    assert.equal(fenceFor('``````x'), '```````');
  });

  it('includes the git line only when git context is on', () => {
    const notes = [note({ body: 'a' })];
    const on = renderBatch(notes, { config: cfg({ includeSnippet: false }), git, now });
    assert.ok(on.includes('**Repo:** orca · **Branch:** feat/pr-parity · **HEAD:** a1b2c3d (uncommitted changes present)'));
    const off = renderBatch(notes, { config: cfg({ includeSnippet: false, includeGitContext: false }), git, now });
    assert.ok(!off.includes('**Repo:**'));
  });

  it('renders screenshots as file paths the agent can read', () => {
    const n = note({ attachments: ['/tmp/shot-1.png', '/tmp/shot-2.png'] });
    const text = renderBatch([n], { config: cfg({ includeSnippet: false }), now });
    assert.ok(text.includes('Screenshot: /tmp/shot-1.png (read this image file — it is part of the feedback)'));
    assert.ok(text.includes('Screenshot: /tmp/shot-2.png'));
  });

  it('json template carries seq, intent and screenshots', () => {
    const n = note({ seq: 9, kind: 'idea', attachments: ['/tmp/a.png'], languageId: 'typescript' });
    const doc = JSON.parse(renderBatch([n], { config: cfg({ outputTemplate: 'json' }), git, now })) as {
      notes: Array<Record<string, unknown>>;
    };
    assert.equal(doc.notes[0]?.['seq'], 9);
    assert.equal(doc.notes[0]?.['intent'], 'idea');
    assert.deepEqual(doc.notes[0]?.['screenshots'], ['/tmp/a.png']);
  });
});

describe('kind ordering', () => {
  it('is the single order used by every surface', () => {
    // The widget toolbar (package.json) and the pickers (KINDS_BY_WEIGHT) must agree, or
    // the same list appears in two different orders depending on where you open it.
    assert.deepEqual(
      [...KINDS_BY_WEIGHT],
      ['comment', 'bug', 'security', 'perf', 'idea', 'refactor', 'question', 'todo', 'nit', 'praise'],
    );
    assert.equal(KIND_META.comment.label, 'change request', 'the default kind is a real, named kind');
  });
});

describe('kind glyphs', () => {
  it('has renderable markup for every kind', () => {
    for (const kind of KINDS_BY_WEIGHT) {
      const markup = KIND_GLYPH[kind];
      assert.ok(markup?.startsWith('<path'), `${kind} has a path`);
      assert.ok(markup.endsWith('/>'), `${kind} markup is closed`);
      assert.ok(!markup.includes('"d="undefined"'), `${kind} has real path data`);
    }
  });
});

describe('continuing a conversation on a note', () => {
  const source: SnippetSource = { textFor: () => undefined };
  const sent = { at: '2026-08-26T10:00:00.000Z', snippetHash: 'h' };

  it('includes a note that has already been sent when asked to', () => {
    const answered = note({ id: 'a', seq: 4, sent, addenda: ['Claude: JSON has no comments.'] });
    const fresh = buildModel([answered], { config: cfg(), source });
    assert.equal(fresh.count, 0, 'a sent note is not part of a new review');

    const again = buildModel([answered], { config: cfg(), source, includeInactive: true });
    assert.equal(again.count, 1, 'but it can be sent again to continue the discussion');
  });

  it('includes a note marked done, so a reply about the change still reaches Claude', () => {
    const finished = note({ id: 'b', seq: 5, done: true, sent });
    assert.equal(buildModel([finished], { config: cfg(), source, includeInactive: true }).count, 1);
  });

  it('frames a batch of already-sent notes as a continuation', () => {
    const answered = note({
      id: 'c',
      seq: 6,
      sent,
      addenda: ['Claude: I used a throwaway key.', 'That is not what I meant — drop the key entirely.'],
    });
    const out = renderBatch([answered], { config: cfg(), source, includeInactive: true });
    assert.match(out, /Following up on feedback you have already worked on/);
    assert.doesNotMatch(out, /I reviewed the generated code and have some feedback/);
    // The whole exchange travels with it, oldest first.
    const claudeAt = out.indexOf('Claude: I used a throwaway key.');
    const mineAt = out.indexOf('That is not what I meant');
    assert.ok(claudeAt > 0 && mineAt > claudeAt, 'the exchange is present and in order');
  });

  it('still reads as a fresh review when any note is new', () => {
    const answered = note({ id: 'd', seq: 7, sent });
    const brandNew = note({ id: 'e', seq: 8 });
    const out = renderBatch([answered, brandNew], { config: cfg(), source, includeInactive: true });
    assert.match(out, /I reviewed the generated code and have some feedback/);
  });
});

describe('a batch that mixes new notes with replies', () => {
  const build = (notes: ReviewNote[]): string =>
    renderBatch(notes, { config: cfg(), source, includeInactive: true, now: new Date('2026-08-28T10:00:00Z') });

  const fresh = note({ id: 'a', seq: 1, body: 'rename this' });
  const answered = note({
    id: 'b',
    seq: 2,
    body: 'remove this comment',
    addenda: ['Claude: removed it', 'the other one too, please'],
    sent: { at: '2026-08-28T09:00:00Z', snippetHash: 'h', addendaAtSend: 1 },
  });

  it('explains the conversation under a note even when the batch is not all follow-ups', () => {
    // Only reachable since a round can mix the two: the threading sentence was tied to *every*
    // note being a follow-up, so a mixed batch shipped the exchanges with nothing to say what
    // they were.
    const text = build([fresh, answered]);
    assert.match(text, /The exchange so far is under each note, newest last\./);
    assert.match(text, /Some of these continue notes you have already worked on\./);
    assert.match(text, /↳ Claude: removed it/, 'and the thread itself is in there');
  });

  it('still says "following up" when every note is one', () => {
    const text = build([answered]);
    assert.match(text, /Following up on feedback you have already worked on/);
    assert.doesNotMatch(text, /Some of these continue/);
  });

  it('says neither for a first round', () => {
    const text = build([fresh]);
    assert.doesNotMatch(text, /exchange so far/);
    assert.doesNotMatch(text, /Some of these continue/);
  });
});
