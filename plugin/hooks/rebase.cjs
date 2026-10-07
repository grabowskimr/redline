'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const oid = /^[0-9a-f]{40,64}$/;
const digest = (line) => createHash('sha256').update(line).digest('hex');
const LIMIT = 8 * 1024 * 1024;

/** HEAD's reflog belongs to this worktree, not to the shared common Git directory. */
async function reflog(root) {
  let dir = path.join(root, '.git');
  try {
    if ((await fs.stat(dir)).isFile()) {
      const match = /^gitdir: (.+)\s*$/.exec(await fs.readFile(dir, 'utf8'));
      if (!match) throw new Error('Cannot locate this worktree’s Git history.');
      dir = path.resolve(root, match[1]);
    }
    const file = path.join(dir, 'logs', 'HEAD');
    let raw = '', byteOffset = 0;
    try {
      const handle = await fs.open(file, 'r');
      try {
        const { size } = await handle.stat();
        const offset = Math.max(0, size - LIMIT);
        const buffer = Buffer.alloc(Math.min(size, LIMIT));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        raw = buffer.subarray(0, bytesRead).toString('utf8');
        byteOffset = offset;
        if (offset) {
          const cut = raw.indexOf('\n') + 1;
          byteOffset += Buffer.byteLength(raw.slice(0, cut));
          raw = raw.slice(cut);
        }
      } finally { await handle.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (raw && !raw.endsWith('\n')) throw new Error('Git history is changing. Refresh Last run after the Git operation finishes.');
    const entries = raw.split('\n').filter(Boolean).map((line) => {
      const match = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^\t]+ (\d+) [+-]\d{4}(?:\t(.*))?$/.exec(line);
      if (!match) throw new Error('Git history is unreadable. Last run cannot be separated from a rebase.');
      const cursor = `${byteOffset}:${digest(line)}`;
      byteOffset += Buffer.byteLength(line) + 1;
      return { cursor, old: match[1], next: match[2], at: Number(match[3]) * 1000, message: match[4] || '' };
    });
    return { entries, cursor: entries.at(-1)?.cursor || 'empty' };
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], cursor: 'empty' };
    throw error;
  }
}

async function captureRebaseCursor(root) { return (await reflog(root)).cursor; }

/** Replay only Git rebase transitions onto the run's baseline, never normal agent commits. */
async function adjustForRebases(root, before, until, git) {
  const log = await reflog(root);
  const cursor = before.rebaseCursor;
  const index = cursor && cursor !== 'empty' ? log.entries.findLastIndex((entry) => entry.cursor === cursor) : -1;
  if (cursor && cursor !== 'empty' && index < 0) throw new Error('Git history for this run expired. Last run cannot be separated from the rebase.');
  const from = Date.parse(before.at), end = Date.parse(until.at);
  const endIndex = until.rebaseCursor ? log.entries.findLastIndex((entry) => entry.cursor === until.rebaseCursor) : undefined;
  if (until.rebaseCursor && until.rebaseCursor !== 'empty' && endIndex < 0) throw new Error('Git history for the end of this run expired.');
  let tree = before.tree, start, rebased = false;
  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i];
    if (cursor ? i <= index : entry.at < from) continue;
    if (endIndex !== undefined ? i > endIndex : entry.at > end) continue;
    const fastForward = /^(?:pull\b.* --rebase\b|rebase\b).*: [Ff]ast-forward\b/.test(entry.message);
    const action = fastForward ? 'finish' : /^(?:rebase\b|pull\b.* --rebase\b).*\((start|finish|abort)\):/.exec(entry.message)?.[1];
    if (!action) continue;
    if (endIndex === undefined && entry.at + 1000 > end) throw new Error('The rebase overlaps this run’s end. Last run cannot be separated reliably.');
    if (action === 'start') { start = entry; continue; }
    if (fastForward) start = entry;
    if (!start || !oid.test(start.old) || !oid.test(entry.next)) {
      throw new Error('The rebase overlaps this run’s start. Last run cannot be separated reliably.');
    }
    if (start.old !== entry.next) {
      try {
        // Git 2.40 requires commit operands. Wrap the snapshot in an unreferenced object;
        // this is not a branch commit and changes neither the index nor any ref.
        const comparison = (await git(['-c', 'user.name=Redline', '-c', 'user.email=redline@localhost',
          'commit-tree', tree, '-m', 'Redline rebase comparison'])).trim();
        if (!oid.test(comparison)) throw new Error('Unexpected comparison object');
        const result = (await git(['merge-tree', '--write-tree', `--merge-base=${start.old}`, comparison, entry.next])).trim();
        if (!oid.test(result)) throw new Error('Unexpected merge result');
        tree = result;
      } catch {
        throw new Error('Cannot separate the rebase from this run’s edits. Review Everything; an exact Last run needs a clean comparison and Git 2.40 or newer.');
      }
    }
    rebased = true;
    start = undefined;
  }
  if (start) throw new Error('A Git rebase is still in progress. Last run will refresh after it finishes.');
  return { tree, rebaseCursor: until.rebaseCursor || log.cursor, rebased };
}

module.exports = { captureRebaseCursor, adjustForRebases };
