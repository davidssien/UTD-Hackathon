/**
 * Saves page helpers shared by both clients (PLAN.md §3 B). `statsFor` sizes a document the
 * same way the server's `my_project_stats` view does: the sum of its entity JSON payloads.
 */
import { DomainError, documentToEntities, parseDocumentJson, type EgressDocument, type ID } from '@egress/core';
import type { ProjectStats } from './types.ts';

export function statsFor(projectId: ID, doc: EgressDocument, members = 1, lastEvacuationSeconds: number | null = null): ProjectStats {
  let sizeBytes = 0;
  for (const e of documentToEntities(doc)) sizeBytes += JSON.stringify(e).length + 1;
  const openings = (kind: string) => doc.openings.filter(o => o.openingKind === kind).length;
  return {
    projectId, sizeBytes, walls: doc.walls.length, doors: openings('door'), windows: openings('window'), exits: openings('exit'),
    floors: doc.floors.length, members, lastEvacuationSeconds,
  };
}

/** Parses a downloaded project file; throws INVALID_INPUT with a readable message when it isn't one. */
export function parseProjectFile(json: string): EgressDocument {
  try {
    return parseDocumentJson(json);
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('INVALID_INPUT', 'This file is not an Egress project (.json).');
  }
}
