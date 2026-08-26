import * as assert from 'node:assert/strict';
import { isImagePath, parseDroppedPaths } from '../../dnd/dropPayload';

describe('parseDroppedPaths', () => {
  it('reads file URIs, percent-decoded, one per line', () => {
    assert.deepEqual(parseDroppedPaths('file:///Users/me/a%20shot.png\r\nfile:///tmp/b.jpg'), [
      '/Users/me/a shot.png',
      '/tmp/b.jpg',
    ]);
  });

  it('accepts bare absolute paths and ignores comments and blanks', () => {
    assert.deepEqual(parseDroppedPaths('# comment\n\n/tmp/c.png\n'), ['/tmp/c.png']);
  });

  it('drops relative paths, URLs and duplicates', () => {
    assert.deepEqual(parseDroppedPaths('shot.png\nhttps://x/y.png\n/tmp/d.png\n/tmp/d.png'), ['/tmp/d.png']);
  });

  it('strips the localhost authority some sources add', () => {
    assert.deepEqual(parseDroppedPaths('file://localhost/tmp/e.png'), ['/tmp/e.png']);
  });

  it('survives malformed percent-encoding instead of throwing', () => {
    assert.deepEqual(parseDroppedPaths('file:///tmp/%E0%A4%A.png'), []);
  });

  it('keeps a hash inside a name — only a leading hash is a comment', () => {
    assert.deepEqual(parseDroppedPaths('/tmp/shot#2.png'), ['/tmp/shot#2.png']);
  });

  it('decodes non-ASCII names the way Finder encodes them', () => {
    assert.deepEqual(parseDroppedPaths('file:///tmp/caf%C3%A9%20%E2%9C%93.png'), ['/tmp/café ✓.png']);
  });

  it('recognises image extensions case-insensitively', () => {
    assert.equal(isImagePath('/tmp/A.PNG'), true);
    assert.equal(isImagePath('/tmp/a.tiff'), true);
    assert.equal(isImagePath('/tmp/a.txt'), false);
    assert.equal(isImagePath('/tmp/noext'), false);
  });
});
