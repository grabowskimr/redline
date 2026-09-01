import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Attachments } from '../../store/attachments';
import { ReviewStore } from '../../store/reviewStore';
import { emptyState } from '../../model/schema';
import { createAnchor } from '../../anchor/anchorService';
import { NewNoteInput, ReviewNote } from '../../model/note';

/**
 * Screenshots attached to notes: kept while anything refers to them, thrown away when nothing
 * does.
 *
 * They are the one thing the extension stores that is measured in megabytes rather than
 * kilobytes, and they used to be swept only when a window opened — so deleting a card left its
 * pictures on disk until the next restart.
 */
describe('screenshots attached to a note', () => {
  let storage: string;

  const store = (): ReviewStore =>
    new ReviewStore(emptyState(), { save: () => Promise.resolve() } as never, {
      archiveLimit: () => 5,
    });

  const attachments = (s: ReviewStore): Attachments =>
    new Attachments(
      { storageUri: vscode.Uri.file(storage), globalStorageUri: vscode.Uri.file(storage) } as never,
      s,
      { info: () => undefined, warn: () => undefined, trace: () => undefined } as never,
    );

  const add = (s: ReviewStore, body: string): ReviewNote => {
    const range = { startLine: 0, startChar: 0, endLine: 0, endChar: 3 };
    const input: NewNoteInput = {
      path: 'a.ts',
      workspaceFolder: 'repo',
      range,
      anchor: createAnchor('let a = 1;', range),
      body,
    };
    return s.add(input);
  };

  const files = (): Promise<string[]> =>
    nodeFs.readdir(path.join(storage, 'attachments')).catch(() => [] as string[]);

  beforeEach(async () => {
    storage = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'redline-att-'));
    (vscode as unknown as { resetStub(): void }).resetStub();
  });

  afterEach(async () => {
    await nodeFs.rm(storage, { recursive: true, force: true });
  });

  it('keeps a note\'s pictures out of the repository', async () => {
    const s = store();
    const n = add(s, 'look at this');
    const at = attachments(s);
    const saved = await at.add(n.id, 'shot.png', Buffer.from('image bytes'));

    assert.ok(saved?.startsWith(storage), 'in the extension\'s own storage');
    assert.deepEqual(s.getById(n.id)?.attachments, [saved]);
  });

  it('throws away every picture of a note that is gone — the follow-ups\' too', async () => {
    /*
     * The question a card raises when you delete it: a screenshot attached to the note and one
     * attached to a follow-up on it are the same kind of thing, and neither has any reason to
     * outlive the note.
     */
    const s = store();
    const n = add(s, 'look at this');
    const at = attachments(s);
    const onNote = await at.add(n.id, 'note.png', Buffer.from('one'));
    s.markSent([n.id]);
    s.update(n.id, { addenda: ['Claude: done', 'and this bit'] });
    const onFollowUp = await at.add(n.id, 'followup.png', Buffer.from('two'));

    assert.equal((await files()).length, 2, 'both are on disk');
    assert.deepEqual(s.getById(n.id)?.attachmentTurns, [0, 3], 'one for the note, one for a turn');

    s.delete([n.id]);
    await at.cleanupOrphans();
    assert.deepEqual(await files(), [], 'and both are gone with it');
    void onNote;
    void onFollowUp;
  });

  it('keeps the pictures of a note that Restore Last Submitted Batch could bring back', async () => {
    /*
     * A sent note lives on in the archive, and restoring that batch brings it back whole. Its
     * screenshots have to be there when it arrives — sweeping on "no active note refers to
     * this" alone would take them the moment the round was cleared.
     */
    const s = store();
    const n = add(s, 'look at this');
    const at = attachments(s);
    await at.add(n.id, 'shot.png', Buffer.from('bytes'));
    s.markSent([n.id]);

    // What sending the next round does: the previous one rolls into the archive.
    s.clearSent();
    assert.equal(s.notes.length, 0, 'nothing active');
    assert.ok(s.archive.some((b) => b.notes.length > 0), 'but it is in the archive');

    await at.cleanupOrphans();
    assert.equal((await files()).length, 1, 'the picture is still there for the restore');
  });

  it('leaves alone anything it did not put there', async () => {
    // The sweep deletes by "nothing refers to it", so it must only ever look in its own
    // directory — and `remove` refuses a path outside it, because the id comes from a webview.
    const s = store();
    const n = add(s, 'x');
    const at = attachments(s);
    const outside = path.join(storage, 'not-ours.png');
    await nodeFs.writeFile(outside, 'someone else\'s');
    s.update(n.id, { attachments: [outside] });

    await at.remove(n.id, outside);
    assert.ok(
      await nodeFs.stat(outside).then(() => true, () => false),
      'still there: it was never ours to delete',
    );
  });

  it('takes a picture off one turn without disturbing the others', async () => {
    const s = store();
    const n = add(s, 'x');
    const at = attachments(s);
    const first = await at.add(n.id, 'one.png', Buffer.from('1'));
    s.markSent([n.id]);
    s.update(n.id, { addenda: ['Claude: done'] });
    const second = await at.add(n.id, 'two.png', Buffer.from('2'));

    await at.remove(n.id, first!);
    const after = s.getById(n.id)!;
    assert.deepEqual(after.attachments, [second]);
    assert.deepEqual(after.attachmentTurns, [2], 'and the surviving one keeps its turn');
  });
});
