/**
 * Run these one at a time, in the order they were asked for.
 *
 * Sending a batch ends with `clearSent(theseIds)`, which archives and deletes every *other*
 * note that has been sent — on the understanding that those are the previous round. Two sends
 * in flight at once break that understanding: the second one's `clearSent` sees the first
 * one's notes as the previous round and deletes them seconds after they went, so the answer
 * that comes back names notes that are no longer here.
 *
 * The overlap is rare — a queue flush landing on a manual send — and the cost of preventing it
 * is a queue of one, on an action that already takes a second or two.
 */
export function serialiser(): <T>(fn: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = last.then(fn, fn);
    // The chain must never carry a rejection forward: one failed send would otherwise wedge
    // every send after it for the life of the window.
    last = next.catch(() => undefined);
    return next as Promise<T>;
  };
}
