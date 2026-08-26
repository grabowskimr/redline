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
