import { NewNoteInput, NoteAnchor, ReviewNote, SerialRange } from '../../model/note';
import { emptyState, PersistedState } from '../../model/schema';
import { ReviewStore } from '../../store/reviewStore';

export function range(startLine: number, endLine = startLine): SerialRange {
  return { startLine, startChar: 0, endLine, endChar: 0 };
}

export function anchor(snippet: string, lineHint = 0): NoteAnchor {
  return { snippet, snippetHash: 'h', contextBefore: [], contextAfter: [], lineHint };
}

export function input(over: Partial<NewNoteInput> = {}): NewNoteInput {
  return {
    path: 'src/a.ts',
    range: range(4),
    anchor: anchor('const a = 1;', 4),
    body: 'note body',
    ...over,
  };
}

export function makeStore(state: PersistedState = emptyState(), archiveLimit = 20): ReviewStore {
  return new ReviewStore(state, undefined, { archiveLimit: () => archiveLimit });
}

export function note(over: Partial<ReviewNote> = {}): ReviewNote {
  const ts = '2026-08-23T14:02:11.482Z';
  return {
    id: over.id ?? 'id-' + Math.random().toString(36).slice(2, 8),
    seq: 1,
    path: 'src/a.ts',
    range: range(4),
    anchor: anchor('const a = 1;', 4),
    body: 'note body',
    addenda: [],
    kind: 'comment',
    done: false,
    order: 0,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}
