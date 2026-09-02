/**
 * Notes waiting for the agent to go quiet.
 *
 * Sending into a run that is already going drops the notes into the middle of a turn, where
 * they are as likely to be ignored as read. Holding them costs nothing, and the moment to send
 * is one we already know about: the hook says when a run ends.
 *
 * This was a bare `true`. One flag cannot hold two things — replying to one card and then to a
 * second before the first was answered set the same flag twice, and the flush re-derived
 * "everything sendable" from the store, so what went was whatever qualified at that moment
 * rather than what either send had asked for. Ids are exact, and a note deleted in the
 * meantime simply drops out.
 *
 * Pure: no `vscode`, so the thing that actually decides what reaches the agent can be tested.
 */
export class SendQueue {
  private readonly ids = new Set<string>();

  constructor(private readonly onChange: () => void = () => undefined) {}

  get size(): number {
    return this.ids.size;
  }

  /** In the order they were queued: the first thing asked for is the first thing sent. */
  list(): string[] {
    return [...this.ids];
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /**
   * Hold these until the run ends. Queueing the same note twice holds it once — pressing send
   * again while it waits is a person checking it is still there, not a second request.
   */
  hold(ids: readonly string[]): void {
    const before = this.ids.size;
    for (const id of ids) this.ids.add(id);
    if (this.ids.size !== before) this.onChange();
  }

  /**
   * Empty the queue and return what should actually be sent.
   *
   * `stillThere` drops the notes that have gone since — deleted, or cleared with the round —
   * because sending an id the store no longer has produces an empty message.
   */
  take(stillThere: (id: string) => boolean): string[] {
    return this.takeWithLost(stillThere).send;
  }

  /**
   * The same, saying which ids were dropped for having no note behind them any more.
   *
   * The dropping was silent, and when everything queued had gone the flush returned before
   * saying a word: run *Clear sent*, or delete the note, and the card that had promised to go
   * when Claude finished simply went back to looking unsent. A promise that cannot be kept has
   * to be withdrawn out loud.
   */
  takeWithLost(stillThere: (id: string) => boolean): { send: string[]; lost: string[] } {
    const send: string[] = [];
    const lost: string[] = [];
    for (const id of this.ids) (stillThere(id) ? send : lost).push(id);
    const had = this.ids.size > 0;
    this.ids.clear();
    if (had) this.onChange();
    return { send, lost };
  }

  /**
   * Take these out of the queue: something else is sending them now.
   *
   * A held note is otherwise indistinguishable from any other unsent one — nothing is written
   * on it — so a manual send picked it up as well, and the flush that came later sent it a
   * second time. Whoever sends it first claims it.
   */
  drop(ids: readonly string[]): void {
    let removed = false;
    for (const id of ids) removed = this.ids.delete(id) || removed;
    if (removed) this.onChange();
  }

  cancel(): boolean {
    if (this.ids.size === 0) return false;
    this.ids.clear();
    this.onChange();
    return true;
  }
}

/** Whether a send should put the confirmation in front of the user. */
export type SendKind =
  /** Someone pressed a button just now. */
  | 'by hand'
  /** The queue emptying itself because the run ended. Nobody is watching. */
  | 'automatic';

/**
 * `confirmOnSubmit` defaults to true, and the automatic flush went through the same modal.
 *
 * Queue three notes, walk away, and the end of the run put up a dialog with nobody there to
 * answer it — while the flush had already emptied the queue, so escaping it lost the notes:
 * no timer watching, nothing said, and the cards back to looking merely unsent. The strip's
 * own tooltip promised they go the moment Claude finishes, which was false for every
 * default-config user.
 *
 * The person confirmed when they pressed Send. The queue is a delay, not a second decision.
 */
export function shouldConfirm(configured: boolean, kind: SendKind): boolean {
  return configured && kind === 'by hand';
}

/**
 * The queued ids worth restoring into a new window.
 *
 * The queue was a bare `Set` in memory and nothing wrote it down: close VS Code before the run
 * ended and three notes that had been promised delivery came back as ordinary unsent drafts,
 * with no record that anything had been promised at all.
 *
 * Persisting it rather than warning on the way out, because a warning is the harder of the two
 * to reason about: `deactivate` is not a place a dialog can be relied on to appear, so the
 * warning would be the thing that silently did not happen. Restoring is also the answer that
 * keeps the promise instead of apologising for it. Ids whose notes did not survive are dropped
 * here — a stored id with no note behind it would only be lost again at the next flush.
 */
export function queueToRestore(stored: unknown, stillThere: (id: string) => boolean): string[] {
  if (!Array.isArray(stored)) return [];
  const out: string[] = [];
  for (const id of stored) {
    if (typeof id !== 'string' || id === '') continue;
    if (out.includes(id) || !stillThere(id)) continue;
    out.push(id);
  }
  return out;
}
