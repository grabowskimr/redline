import { RenderModel } from '../renderBatch';

export function json(m: RenderModel): string {
  const notes = [...m.files.flatMap((f) => f.notes), ...m.orphans].map((n) => {
    const o: Record<string, unknown> = {
      id: n.note.id,
      seq: n.seq,
      path: n.path,
      startLine: n.startLine,
      endLine: n.endLine,
      kind: n.kind,
      intent: n.intent,
      body: n.body,
    };
    if (n.note.addenda.length) o['addenda'] = n.note.addenda;
    if (n.suggestion !== undefined) o['suggestion'] = n.suggestion;
    if (n.snippet !== undefined) o['snippet'] = n.snippet;
    if (n.language !== undefined) o['language'] = n.note.languageId ?? n.language;
    if (n.attachments.length) o['screenshots'] = n.attachments;
    if (n.orphaned) o['orphaned'] = true;
    return o;
  });
  const doc: Record<string, unknown> = { generatedAt: m.generatedAt };
  if (m.config.includeGitContext && m.git) {
    const repo: Record<string, unknown> = {};
    if (m.git.repoName) repo['name'] = m.git.repoName;
    if (m.git.branch) repo['branch'] = m.git.branch;
    if (m.git.sha) repo['sha'] = m.git.sha.slice(0, 7);
    if (m.git.dirty !== undefined) repo['dirty'] = m.git.dirty;
    doc['repo'] = repo;
  }
  doc['notes'] = notes;
  return JSON.stringify(doc, null, 2) + '\n';
}
