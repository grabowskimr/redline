import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { differsFromSnapshot, readSnapshot } from '../../claude/snapshot';
import { projectSlug } from '../../claude/transcripts';

describe('run-start snapshot', () => {
  let home: string;
  let repo: string;

  const writeSnapshot = async (files: Record<string, string>, at = '2026-08-26T10:00:00.000Z'): Promise<void> => {
    const dir = path.join(home, '.claude', 'redline', projectSlug(repo), 'snapshot');
    await fs.mkdir(dir, { recursive: true });
    const manifest: Record<string, string> = {};
    for (const [rel, body] of Object.entries(files)) {
      const stored = encodeURIComponent(rel);
      await fs.writeFile(path.join(dir, stored), body, 'utf8');
      manifest[rel] = stored;
    }
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ at, files: manifest }), 'utf8');
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-snap-home-'));
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-snap-repo-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('is absent when the hook has not run', async () => {
    assert.equal(await readSnapshot(repo, home), undefined);
  });

  it('reports a file the run changed, and not one it left alone', async () => {
    // The reported bug: two edits to one file in different runs, both shown as "last run".
    await writeSnapshot({
      'app.ts': 'line1\nline2 EDITED-IN-RUN-1\nline3\nline4\n',
      'other.ts': 'untouched\n',
    });
    await fs.writeFile(path.join(repo, 'app.ts'), 'line1\nline2 EDITED-IN-RUN-1\nline3\nline4 EDITED-IN-RUN-2\n', 'utf8');
    await fs.writeFile(path.join(repo, 'other.ts'), 'untouched\n', 'utf8');

    const snap = await readSnapshot(repo, home);
    assert.ok(snap);
    assert.equal(await differsFromSnapshot(snap, repo, 'app.ts'), true, 'this run touched it');
    assert.equal(await differsFromSnapshot(snap, repo, 'other.ts'), false, 'an earlier run did');
  });

  it('treats a file with no snapshot entry as this run\'s work', async () => {
    // It was clean when the run began, so its whole diff belongs to this run.
    await writeSnapshot({ 'app.ts': 'x\n' });
    const snap = await readSnapshot(repo, home);
    assert.ok(snap);
    assert.equal(snap.has('brand-new.ts'), false);
    assert.equal(await differsFromSnapshot(snap, repo, 'brand-new.ts'), true);
  });

  it('does not hide a change when the current file is unreadable', async () => {
    await writeSnapshot({ 'gone.ts': 'was here\n' });
    const snap = await readSnapshot(repo, home);
    assert.ok(snap);
    assert.equal(await differsFromSnapshot(snap, repo, 'gone.ts'), true, 'deleted counts as changed');
  });

  it('ignores a manifest it cannot make sense of', async () => {
    const dir = path.join(home, '.claude', 'redline', projectSlug(repo), 'snapshot');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), '{ not json', 'utf8');
    assert.equal(await readSnapshot(repo, home), undefined);
  });
});
