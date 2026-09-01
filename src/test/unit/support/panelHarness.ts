/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';


/**
 * Drives the real `media/cards.js` against a minimal DOM shim. The drag handlers were the
 * flakiest part of this extension, and they cannot be reached from the extension-host
 * tests at all — the webview is a separate runtime. This harness registers the listeners
 * the script installs, then fires synthetic drag events at them.
 */

/** `media/` from wherever the compiled test happens to sit. */
export function mediaPath(file: string): string {
  return path.join(__dirname, '..', '..', '..', '..', 'media', file);
}

export interface Harness {
  posted: any[];
  root: any;
  fire(type: string, event: any): void;
  card(id: string): any;
  cards: any[];
  writes: { strip: number; body: number };
  box(card: any, value?: string): any;
  readonly menuHtml: string;
  tick(ms: number): Promise<void>;
}

export function element(tag: string, attrs: Record<string, string> = {}): any {
  const classes = new Set<string>();
  const el: any = {
    tagName: tag.toUpperCase(),
    dataset: { ...attrs },
    children: [] as any[],
    innerHTML: '',
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    addEventListener: () => undefined,
    closest: (sel: string) => {
      if (sel === 'textarea') return el.tagName === 'TEXTAREA' ? el : null;
      if (sel.includes('card')) return el.isCard ? el : (el.parentCard ?? null);
      if (sel.includes('actions') || sel.includes('controls')) return el.scope ?? null;
      if (sel.includes('data-filter')) return el.dataset.filter ? el : null;
      if (sel.includes('data-global')) return el.dataset.global ? el : null;
      if (sel.includes('data-act')) return el.dataset.act ? el : null;
      if (sel.includes('data-shot') || sel.includes('data-unshot')) return null;
      return null;
    },
  };
  return el;
}

export function harness(): Harness {
  const listeners = new Map<string, Array<(e: any) => void>>();
  const on = (type: string, fn: (e: any) => void): void => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  };
  const posted: any[] = [];
  const cards: any[] = [];
  /*
   * The panel keeps the session header and the card list in two containers and repaints them
   * separately — the header carries the name of the file Claude is writing right now, so one
   * string for both meant every file it touched re-parsed every card. The shim mirrors that,
   * and `root.innerHTML` reads as the two together, which is what the assertions want.
   */
  const strip = element('div');
  const body = element('div');
  strip.isConnected = true;
  body.isConnected = true;
  // How many times each container has actually been rewritten — the cost this split exists to
  // avoid is the rewrite, and nothing else about the markup shows whether it happened.
  const writes = { strip: 0, body: 0 };
  for (const [el, key] of [
    [strip, 'strip'],
    [body, 'body'],
  ] as const) {
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => html,
      set: (v: string) => {
        html = v;
        writes[key] += 1;
      },
    });
  }
  const root = element('div');
  Object.defineProperty(root, 'innerHTML', {
    get: () => strip.innerHTML + body.innerHTML,
    set: () => {
      strip.innerHTML = '';
      body.innerHTML = '';
    },
  });
  root.addEventListener = on;
  // Mirrors `cardById`: the *live* element for a note id, so a card replaced by a
  // re-render is found instead of the detached original.
  root.querySelector = (sel: string) => {
    const id = /data-id="([^"]+)"/.exec(sel)?.[1];
    return [...cards].reverse().find((c) => c.dataset.id === id) ?? null;
  };
  // Every follow-up box on the page: a repaint carries all of them, not only the focused one,
  // because a draft lives in the DOM and nowhere else.
  root.querySelectorAll = (sel: string) =>
    sel === 'textarea' ? cards.map((c: any) => c.box).filter(Boolean) : [];

  // Popups are appended to the body rather than painted into a container, so the last one
  // opened is captured here for the tests that check what a menu offers.
  const menu = { html: '' };
  const documentShim: any = {
    getElementById: (id: string) => (id === 'strip' ? strip : id === 'cards' ? body : root),
    addEventListener: on,
    elementFromPoint: () => null,
    activeElement: null,
    createElement: () => {
      const e = element('div');
      e.setAttribute = () => undefined;
      e.getBoundingClientRect = () => ({ left: 0, bottom: 0, top: 0, right: 0 });
      e.style = {};
      e.remove = () => undefined;
      Object.defineProperty(e, 'innerHTML', {
        get: () => menu.html,
        set: (v: string) => {
          menu.html = v;
        },
      });
      return e;
    },
    body: { appendChild: () => undefined },
  };
  const windowShim: any = { addEventListener: on };

  class FileReaderShim {
    onload: (() => void) | null = null;
    result = 'data:image/png;base64,QUJD';
    readAsDataURL(): void {
      setTimeout(() => this.onload?.(), 0);
    }
  }

  const src = fs.readFileSync(mediaPath('cards.js'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'window',
    'document',
    'acquireVsCodeApi',
    'FileReader',
    src,
  )(windowShim, documentShim, () => ({ postMessage: (m: any) => posted.push(m) }), FileReaderShim);

  return {
    posted,
    cards,
    root,
    writes,
    get menuHtml() {
      return menu.html;
    },
    card(id: string) {
      const el = element('div', { id });
      el.isCard = true;
      el.dataset.id = id;
      // Cards are asked for their follow-up box by the commit path; a real one answers.
      el.querySelector = (sel: string) => (sel === 'textarea' ? el.box : null);
      cards.push(el);
      return el;
    },
    /** Attach a box to a card, the way a rendered card has one. */
    box(card: any, value = ''): any {
      const ta = element('textarea');
      ta.value = value;
      ta.parentCard = card;
      ta.closest = (sel: string) => (sel === 'textarea' ? ta : sel.includes('card') ? card : null);
      card.box = ta;
      return ta;
    },
    fire(type: string, event: any) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    tick: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

export const dt = (over: Partial<{ types: string[]; files: any[]; data: Record<string, string> }> = {}): any => ({
  types: over.types ?? ['Files'],
  files: over.files ?? [],
  getData: (t: string) => over.data?.[t] ?? '',
  dropEffect: '',
});

export const dragEvent = (target: any, dataTransfer: any, shiftKey = true) => {
  let prevented = false;
  return {
    target,
    clientX: 10,
    clientY: 10,
    shiftKey,
    dataTransfer,
    preventDefault: () => {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  } as any;
};
