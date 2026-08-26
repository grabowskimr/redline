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
 * the file. Eight characters always survive being typed.
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
    return marker.token ?? DEFAULT_DELIVERY_TOKEN;
  } catch {
    return undefined;
  }
}

/**
 * Leave the feedback where the hook will find it.
 *
 * Written and then renamed into place: the hook could otherwise read a file that is still
 * being written and deliver half a review.
 */
export async function stageForHandover(root: string, text: string, home?: string): Promise<void> {
  const dir = stateDir(root, home);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'outbox.md');
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, target);
}

/** Drop a staged batch that was never collected — a send that failed after staging. */
export async function discardHandover(root: string, home?: string): Promise<void> {
  try {
    await fs.rm(path.join(stateDir(root, home), 'outbox.md'), { force: true });
  } catch {
    // nothing staged
  }
}
