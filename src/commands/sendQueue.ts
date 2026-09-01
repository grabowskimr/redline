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
    const out = [...this.ids].filter(stillThere);
    const had = this.ids.size > 0;
    this.ids.clear();
    if (had) this.onChange();
    return out;
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
