import * as assert from 'node:assert/strict';
import { ReviewProgress } from '../../view/reviewProgress';

describe('file review progress', () => {
  const file = { path: 'src/main.rs', before: 'old-blob', after: 'new-blob' };
  it('retains reviewed files when only another file changes', () => {
    const p = new ReviewProgress();
    p.mark('/repo', 'recent', file, true);
    assert.equal(p.isReviewed('/repo', 'recent', { ...file }), true);
    assert.equal(p.isReviewed('/repo', 'recent', { ...file, path: 'other.rs' }), false);
  });
  it('invalidates when either side changes and separates roots and scopes', () => {
    const p = new ReviewProgress();
    p.mark('/repo', 'recent', file, true);
    for (const changed of [{ ...file, before: 'changed-base' }, { ...file, after: 'changed-code' }]) {
      assert.equal(p.isReviewed('/repo', 'recent', changed), false);
    }
    assert.equal(p.isReviewed('/repo2', 'recent', file), false);
    assert.equal(p.isReviewed('/repo', 'all', file), false);
  });
  it('restores persisted marks, tolerates corrupt state and can unmark', () => {
    const p = new ReviewProgress(); p.mark('/repo', 'all', file, true);
    const restored = new ReviewProgress(p.snapshot());
    assert.equal(restored.isReviewed('/repo', 'all', file), true);
    restored.mark('/repo', 'all', file, false);
    assert.equal(restored.isReviewed('/repo', 'all', file), false);
    assert.doesNotThrow(() => new ReviewProgress({ bad: true }));
  });
});
