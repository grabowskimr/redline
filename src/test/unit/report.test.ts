import * as assert from 'node:assert/strict';
import { parseReport } from '../../export/report';

describe('parseReport', () => {
  it('parses done / skipped / answer lines with tolerant formatting', () => {
    const text = [
      'Here is what I did:',
      '- `#12 done`',
      '#13 skipped — the helper is used elsewhere',
      '* #14 answer: it is duplicated because of the theme override',
      '#15: fixed',
      '#16 - declined: out of scope',
      'random line #99 not a report',
    ].join('\n');
    assert.deepEqual(parseReport(text), [
      { seq: 12, outcome: 'done' },
      { seq: 13, outcome: 'skipped', text: 'the helper is used elsewhere' },
      { seq: 14, outcome: 'answered', text: 'it is duplicated because of the theme override' },
      { seq: 15, outcome: 'done' },
      { seq: 16, outcome: 'skipped', text: 'out of scope' },
    ]);
  });
  it('later lines override earlier ones', () => {
    assert.deepEqual(parseReport('#1 skipped\n#1 done'), [{ seq: 1, outcome: 'done' }]);
  });
});

describe('an outcome that comes with an explanation', () => {
  it('keeps what Claude said alongside a completed change', () => {
    // The prompt now asks for a sentence with every outcome, and the applier turns any text
    // into Claude's turn in the note's conversation — not just answers to questions.
    const items = parseReport(
      [
        '#3 done — moved applyDiscount above the return so annual plans get it',
        '#4 skipped — the query is already parameterised upstream',
        '#5 answer: it returns early so the tax step can be skipped for exempt plans',
      ].join('\n'),
    );
    assert.deepEqual(
      items.map((i) => [i.seq, i.outcome, (i.text ?? '').slice(0, 20)]),
      [
        [3, 'done', 'moved applyDiscount '],
        [4, 'skipped', 'the query is already'],
        [5, 'answered', 'it returns early so '],
      ],
    );
  });

  it('still accepts a bare outcome', () => {
    assert.deepEqual(parseReport('#7 done'), [{ seq: 7, outcome: 'done' }]);
  });
});
