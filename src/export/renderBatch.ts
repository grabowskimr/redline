/**
 * Batch rendering. Pure: no `vscode` imports. The caller supplies file contents for
 * snippet extraction via `SnippetSource`.
 */
import { RenderConfig } from '../config';
import {
  compareByPathThenLine,
  formatLineRange,
  GitSnapshot,
  Intent,
  intentOf,
  isOpen,
  KIND_META,
  KINDS_BY_WEIGHT,
  NoteKind,
  ReviewNote,
} from '../model/note';
import { resolveAnchor } from '../anchor/anchorService';
import { claudePrompt } from './formatters/claudePrompt';
import { json } from './formatters/json';

export const SNIPPET_MAX_LINES = 40;

export interface GitContext extends GitSnapshot {
  repoName?: string;
}

export interface RenderedNote {
  /** Stable note number shown as `#12`. */
  seq: number;
  intent: Intent;
  note: ReviewNote;
  path: string;
  /** 1-based. */
  startLine: number;
  endLine: number;
  lineRange: string;
  kind: NoteKind;
  kindIcon: string;
  body: string;
  /** Full body incl. addenda, ready to emit. */
  bodyWithAddenda: string;
  /** Snippet text to show (possibly with a truncation marker), or undefined. */
  snippet?: string;
  language?: string;
  suggestion?: string;
  attachments: string[];
  orphaned: boolean;
}

export interface RenderedFile {
  path: string;
  language?: string;
  notes: RenderedNote[];
}

export interface RenderModel {
  count: number;
  fileCount: number;
  files: RenderedFile[];
  orphans: RenderedNote[];
  kindCounts: Array<{ kind: NoteKind; icon: string; count: number }>;
  git?: GitContext;
  /** ISO timestamp of generation. */
  generatedAt: string;
  config: RenderConfig;
  /** Every note has been through a round already: this is a continuation, not a new review. */
  followUp: boolean;
}

export interface SnippetSource {
  /** Current text of the file, or undefined if unavailable (falls back to stored snippet). */
  textFor(note: ReviewNote): string | undefined;
}

export interface RenderOptions {
  config: RenderConfig;
  git?: GitContext;
  source?: SnippetSource;
  /** Override "now" (tests). */
  now?: Date;
  /** Restrict to these note ids (copy single note / send selection). */
  onlyIds?: readonly string[];
  /** Include done/sent notes too (defaults to false). */
  includeInactive?: boolean;
}

export function languageFromPath(p: string): string | undefined {
  const ext = p.split('.').pop()?.toLowerCase();
  if (!ext || ext === p.toLowerCase()) return undefined;
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    ex: 'elixir', exs: 'elixir', erl: 'erlang', php: 'php', swift: 'swift',
    md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    sh: 'bash', zsh: 'bash', bash: 'bash', sql: 'sql', html: 'html', css: 'css',
    scss: 'scss', vue: 'vue', svelte: 'svelte', graphql: 'graphql', gql: 'graphql',
  };
  return map[ext] ?? ext;
}

/** Map a VS Code languageId to a short markdown fence id. */
export function fenceLanguage(languageId: string | undefined, path: string): string | undefined {
  const map: Record<string, string> = {
    typescript: 'ts', typescriptreact: 'tsx', javascript: 'js', javascriptreact: 'jsx',
    plaintext: '', shellscript: 'bash', csharp: 'csharp', cpp: 'cpp', objectivec: 'objc',
  };
  if (languageId) {
    const m = map[languageId];
    if (m !== undefined) return m || undefined;
    return languageId;
  }
  return languageFromPath(path);
}

function splitLines(t: string): string[] {
  return t.split(/\r?\n/);
}

export function extractSnippet(note: ReviewNote, source: SnippetSource | undefined): string | undefined {
  const text = source?.textFor(note);
  let lines: string[];
  if (text !== undefined && !note.anchor.orphaned) {
    const all = splitLines(text);
    // Re-locate the anchor: the stored range can lag behind the file (the agent edited it
    // moments ago). The sent-time hash is taken at the resolved range too, so both the
    // agent and the "code changed" badge look at the same lines.
    const resolved = resolveAnchor(text, note.anchor);
    const range = resolved ? resolved.range : note.range;
    const start = Math.max(0, range.startLine);
    const end = Math.min(all.length - 1, range.endLine);
    if (start > end) return note.anchor.snippet || undefined;
    lines = all.slice(start, end + 1);
  } else {
    if (!note.anchor.snippet) return undefined;
    lines = splitLines(note.anchor.snippet);
  }
  if (lines.length > SNIPPET_MAX_LINES) {
    const more = lines.length - SNIPPET_MAX_LINES;
    lines = [...lines.slice(0, SNIPPET_MAX_LINES), `… (${more} more lines)`];
  }
  return lines.join('\n');
}

/** True when every note in the batch has already been through a round with the agent. */
export function isFollowUp(notes: readonly ReviewNote[]): boolean {
  return notes.length > 0 && notes.every((n) => !!n.sent);
}

export function bodyWithAddenda(note: ReviewNote): string {
  const parts = [note.body.trimEnd()];
  for (const a of note.addenda) {
    const lines = splitLines(a.trimEnd());
    parts.push('', `↳ ${lines[0] ?? ''}${lines.length > 1 ? '\n' + lines.slice(1).join('\n') : ''}`);
  }
  return parts.join('\n');
}

/** Pick a fence that does not collide with fences inside `code`. */
export function fenceFor(code: string): string {
  let longest = 2;
  for (const m of code.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(longest + 1);
}

export function buildModel(notes: readonly ReviewNote[], opts: RenderOptions): RenderModel {
  const only = opts.onlyIds ? new Set(opts.onlyIds) : undefined;
  const selected = notes
    .filter((n) => (opts.includeInactive ? true : isOpen(n)))
    .filter((n) => !only || only.has(n.id))
    .sort((a, b) => (a.workspaceFolder ?? '').localeCompare(b.workspaceFolder ?? '') || compareByPathThenLine(a, b));

  const multiRoot = new Set(selected.map((n) => n.workspaceFolder ?? '')).size > 1;
  const displayPath = (n: ReviewNote): string =>
    multiRoot && n.workspaceFolder ? `${n.workspaceFolder}/${n.path}` : n.path;
  const fileKey = (n: ReviewNote): string => `${n.workspaceFolder ?? ''}::${n.path}`;

  const render = (note: ReviewNote): RenderedNote => {
    const language = fenceLanguage(note.languageId, note.path);
    const snippet = opts.config.includeSnippet ? extractSnippet(note, opts.source) : undefined;
    const r: RenderedNote = {
      seq: note.seq,
      intent: intentOf(note),
      note,
      path: displayPath(note),
      startLine: note.range.startLine + 1,
      endLine: note.range.endLine + 1,
      lineRange: formatLineRange(note.range),
      kind: note.kind,
      kindIcon: KIND_META[note.kind].icon,
      body: note.body,
      bodyWithAddenda: bodyWithAddenda(note),
      attachments: note.attachments ?? [],
      orphaned: !!note.anchor.orphaned,
    };
    if (snippet !== undefined) r.snippet = snippet;
    if (language !== undefined) r.language = language;
    if (note.suggestion !== undefined) r.suggestion = note.suggestion;
    return r;
  };

  const files: RenderedFile[] = [];
  const orphans: RenderedNote[] = [];
  let lastKey: string | undefined;
  for (const note of selected) {
    if (note.anchor.orphaned) continue;
    const rendered = render(note);
    let file = files[files.length - 1];
    if (!file || lastKey !== fileKey(note)) {
      lastKey = fileKey(note);
      file = { path: displayPath(note), notes: [] };
      const lang = fenceLanguage(note.languageId, note.path);
      if (lang !== undefined) file.language = lang;
      files.push(file);
    }
    file.notes.push(rendered);
  }
  for (const note of selected) {
    if (note.anchor.orphaned) orphans.push(render(note));
  }

  const counts = new Map<NoteKind, number>();
  for (const n of selected) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  const kindCounts = KINDS_BY_WEIGHT.filter((k) => counts.has(k)).map((k) => ({
    kind: k,
    icon: KIND_META[k].icon,
    count: counts.get(k) ?? 0,
  }));

  const model: RenderModel = {
    count: selected.length,
    fileCount: new Set(selected.map(fileKey)).size,
    files,
    orphans,
    kindCounts,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    config: opts.config,
    followUp: isFollowUp(selected),
  };
  if (opts.git) model.git = opts.git;
  return model;
}

export function renderBatch(notes: readonly ReviewNote[], opts: RenderOptions): string {
  const model = buildModel(notes, opts);
  return opts.config.outputTemplate === 'json' ? json(model) : claudePrompt(model);
}

export function shortSha(sha: string | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}
