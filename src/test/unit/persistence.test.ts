import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Persistence } from '../../store/persistence';
import { emptyState } from '../../model/schema';
import { note } from './fixtures';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'redline-'));
}

describe('Persistence', () => {
  it('returns an empty state when the file does not exist', async () => {
    const dir = await tmpDir();
    const p = new Persistence(path.join(dir, 'notes.json'));
    const r = await p.load();
    assert.equal(r.state.active.notes.length, 0);
    assert.equal(r.quarantinedTo, undefined);
  });

  it('round-trips state through a debounced atomic write', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'nested', 'notes.json');
    const p = new Persistence(file, undefined, 10);
    const state = emptyState();
    state.active.notes.push(note({ body: 'persisted' }));
    p.save(emptyState());
    p.save(state); // collapses into one write
    await new Promise((r) => setTimeout(r, 40));
    const files = await fs.readdir(path.dirname(file));
    assert.deepEqual(files, ['notes.json']); // no tmp file left behind
    const r = await new Persistence(file).load();
    assert.equal(r.state.active.notes[0]?.body, 'persisted');
  });

  it('flush writes immediately', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'notes.json');
    const p = new Persistence(file, undefined, 10_000);
    p.save(emptyState());
    await p.flush();
    await fs.access(file);
  });

  it('quarantines a corrupt file and starts empty', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'notes.json');
    await fs.writeFile(file, '{ not json', 'utf8');
    const r = await new Persistence(file).load();
    assert.equal(r.state.active.notes.length, 0);
    assert.ok(r.quarantinedTo?.includes('notes.corrupt-'));
    const q = await fs.readFile(r.quarantinedTo ?? '', 'utf8');
    assert.equal(q, '{ not json');
  });

  it('quarantines an unsupported schema version', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'notes.json');
    await fs.writeFile(file, JSON.stringify({ version: 99 }), 'utf8');
    const r = await new Persistence(file).load();
    assert.ok(r.quarantinedTo);
  });

  it('treats an empty file as empty state without quarantine', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'notes.json');
    await fs.writeFile(file, '', 'utf8');
    const r = await new Persistence(file).load();
    assert.equal(r.quarantinedTo, undefined);
  });
});
