/** Minimal event emitter so `store/` stays free of `vscode` imports. */
export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (e: T) => void;

export class Emitter<T> implements Disposable {
  private listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        // Listeners must not break the emitter; surface via console for unit tests.
        console.error('listener threw', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
