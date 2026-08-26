import * as assert from 'node:assert/strict';
import { createAnchor, hashSnippet, resolveAnchor, snippetAt } from '../../anchor/anchorService';
import { range } from './fixtures';

const FILE = [
  'import { a } from "./a";',
  '',
  'export function one() {',
  '  const thread = controller.createCommentThread(uri, range, []);',
  '  thread.comments = [comment];',
  '  return thread;',
  '}',
  '',
  'export function two() {',
  '  this.threads.clear();',
  '}',
  '',
  'export function three() {',
  '  const notes = this.state.active.notes.filter(n => n.id !== id);',
  '  return notes;',
  '}',
].join('\n');

describe('anchorService.createAnchor', () => {
  it('captures snippet, hash, context and hint', () => {
    const a = createAnchor(FILE, range(3, 4));
    assert.equal(a.snippet, '  const thread = controller.createCommentThread(uri, range, []);\n  thread.comments = [comment];');
    assert.equal(a.lineHint, 3);
    assert.deepEqual(a.contextBefore, ['import { a } from "./a";', '', 'export function one() {']);
    assert.deepEqual(a.contextAfter, ['  return thread;', '}', '']);
    assert.equal(a.snippetHash, hashSnippet(a.snippet));
  });

  it('clamps out-of-range lines', () => {
    const a = createAnchor('x\ny', range(5, 9));
    assert.equal(a.snippet, 'y');
    assert.equal(a.lineHint, 1);
  });

  it('hash ignores whitespace differences', () => {
    assert.equal(hashSnippet('  a =   1;'), hashSnippet('a = 1;'));
    assert.notEqual(hashSnippet('a = 1;'), hashSnippet('a = 2;'));
  });
});

describe('anchorService.resolveAnchor', () => {
  const a = createAnchor(FILE, range(3, 4));

  it('fast path when unchanged', () => {
    const r = resolveAnchor(FILE, a);
    assert.equal(r?.method, 'hint');
    assert.equal(r?.range.startLine, 3);
    assert.equal(r?.range.endLine, 4);
  });

  it('insertion above shifts the range', () => {
    const text = 'const x = 1;\nconst y = 2;\n' + FILE;
    const r = resolveAnchor(text, a);
    assert.equal(r?.range.startLine, 5);
    assert.equal(r?.range.endLine, 6);
    assert.equal(r?.method, 'nearby');
  });

  it('insertion below keeps the range', () => {
    const text = FILE + '\nconst z = 3;';
    assert.equal(resolveAnchor(text, a)?.range.startLine, 3);
  });

  it('insertion inside the snippet falls back to fuzzy', () => {
    const lines = FILE.split('\n');
    lines.splice(4, 0, '  // added a comment here');
    const r = resolveAnchor(lines.join('\n'), a);
    // Exact match impossible; fuzzy should still locate it near line 3 or give up — never wrong.
    if (r) assert.ok(r.range.startLine >= 2 && r.range.startLine <= 5, `got ${r.range.startLine}`);
  });

  it('deletion of the anchored block orphans the note', () => {
    const lines = FILE.split('\n');
    lines.splice(3, 2);
    assert.equal(resolveAnchor(lines.join('\n'), a), undefined);
  });

  it('survives a whole-file reformat (indentation + spacing)', () => {
    const reformatted = FILE.split('\n')
      .map((l) => l.replace(/^ {2}/, '\t').replace(/ = /g, '  =  '))
      .join('\n');
    const r = resolveAnchor(reformatted, a);
    assert.equal(r?.range.startLine, 3);
  });

  it('disambiguates duplicate snippets by context', () => {
    const dup = [
      'function alpha() {',
      '  return 1;',
      '}',
      'function beta() {',
      '  return 1;',
      '}',
      'function gamma() {',
      '  return 1;',
      '}',
    ].join('\n');
    const anchor = createAnchor(dup, range(4));
    assert.equal(anchor.snippet, '  return 1;');
    const edited = 'const pad = 0;\n' + dup;
    const r = resolveAnchor(edited, anchor);
    assert.equal(r?.range.startLine, 5);
  });

  it('refuses ambiguous duplicates with identical context', () => {
    const dup = ['x();', 'y();', 'x();', 'y();'].join('\n');
    const anchor = { ...createAnchor(dup, range(0)), lineHint: 0, contextBefore: [], contextAfter: [] };
    // hint still matches → fast path. Move hint off both candidates equally.
    const far = ['', '', 'x();', 'y();', '', '', 'x();', 'y();'].join('\n');
    const r = resolveAnchor(far, { ...anchor, lineHint: 4 });
    assert.equal(r, undefined);
  });

  it('finds a match outside the search radius via global search', () => {
    const big = Array.from({ length: 600 }, (_, i) => `line ${i};`).join('\n') + '\n' + FILE;
    const r = resolveAnchor(big, a, { searchRadius: 50 });
    assert.equal(r?.method, 'global');
    assert.equal(r?.range.startLine, 603);
  });

  it('fuzzy-matches a lightly edited snippet', () => {
    const edited = FILE.replace('thread.comments = [comment];', 'thread.comments = [comment, other];');
    const r = resolveAnchor(edited, a);
    assert.equal(r?.method, 'fuzzy');
    assert.equal(r?.range.startLine, 3);
  });

  it('handles empty documents', () => {
    assert.equal(resolveAnchor('', a), undefined);
  });
});

describe('anchorService.snippetAt', () => {
  it('extracts inclusive lines', () => {
    assert.equal(snippetAt('a\nb\nc', range(1, 2)), 'b\nc');
  });
});
