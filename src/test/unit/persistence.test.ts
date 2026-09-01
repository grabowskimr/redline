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

describe('a notes file that cannot be read', () => {
  /*
   * "There is nothing here" and "I could not read what is here" used to be the same answer: any
   * failure that was not ENOENT returned an empty state. You saw an empty panel, wrote one
   * note, and the debounced save replaced `notes.json` with a one-note document. Every note
   * gone, no quarantine file, nothing on screen to say what had happened.
   *
   * A permission error is the easy one to picture; a network volume blinking is the one that
   * actually happens.
   */
  const unreadableDir = async (): Promise<{ dir: string; file: string }> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-unreadable-'));
    const file = path.join(dir, 'notes.json');
    // A directory where the file should be: every read fails with EISDIR, which is neither
    // ENOENT nor a parse error, so it takes exactly the branch under test.
    await fs.mkdir(file);
    return { dir, file };
  };

  it('says it could not read, rather than reporting an empty review', async () => {
    const { dir, file } = await unreadableDir();
    const p = new Persistence(file, undefined, 10);

    const loaded = await p.load();
    assert.ok(loaded.unreadable, 'the failure is reported, not swallowed');
    assert.equal(loaded.state.active.notes.length, 0, 'and nothing is invented to fill the gap');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses to save over a file it never managed to read', async () => {
    const { dir, file } = await unreadableDir();
    const p = new Persistence(file, undefined, 10);
    await p.load();

    p.save(emptyState());
    await p.flush();

    // Still the directory we put there: had the guard not held, this would now be a JSON file
    // containing an empty review, and whatever was really there would be gone.
    assert.equal((await fs.stat(file)).isDirectory(), true, 'the file on disk is untouched');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves again once a load has succeeded', async () => {
    // The block is not a latch that needs a restart to clear: a reload that works re-enables
    // saving, which is what makes "fix the permissions and reload" a real instruction.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-recovered-'));
    const file = path.join(dir, 'notes.json');
    const p = new Persistence(file, undefined, 10);

    assert.equal((await p.load()).unreadable, undefined, 'nothing there is not a failure');
    p.save(emptyState());
    await p.flush();
    assert.ok(await fs.stat(file).then(() => true, () => false), 'and it saves');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
