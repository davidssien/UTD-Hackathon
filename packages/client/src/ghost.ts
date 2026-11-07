import { applyEdit, type EditCommand, type EgressDocument, type ID } from '@egress/core';
import type { ProposalView } from './types.ts';

/**
 * Ghost preview of a proposal: applies its commands to the current document
 * with requestId = proposal id, which is exactly what Accept will do (D19), so
 * ghost entity ids match the ids that will exist after acceptance.
 */
export function ghostFor(doc: EgressDocument | null, proposalId: ID, commands: EditCommand[]): ProposalView['ghost'] {
  if (!doc) return null;
  const result = applyEdit(doc, { requestId: proposalId, commands });
  if (!result.ok) return null;
  return { doc: result.doc, createdIds: result.created, changedIds: result.changed, removedIds: result.removed };
}
