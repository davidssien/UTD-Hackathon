/**
 * Optimistic editing over an authoritative server document (docs/ARCHITECTURE.md §8, D6).
 * Local edits apply immediately with the same `applyEdit` the reducer runs;
 * when the server's rows change, pending edits are re-applied on top
 * (rebase). An edit leaves the pending queue once its requestId shows up in
 * the server's edit log, or once the server rejects it.
 */
import { applyEdit, type DomainErrorData, type EditCommand, type EgressDocument, type ID } from '@egress/core';

type PatchCommand = Extract<EditCommand, { kind: 'applyPatch' }>;

interface Pending {
  requestId: ID;
  commands: EditCommand[];
  baseRevision: number;
}

export class OptimisticDocument {
  private server: EgressDocument | null = null;
  private pending: Pending[] = [];
  private current: EgressDocument | null = null;
  private readonly undoStack: PatchCommand[] = [];
  private readonly redoStack: PatchCommand[] = [];
  lastError: DomainErrorData | null = null;

  get view(): EgressDocument | null {
    return this.current;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** New authoritative state: drop confirmed edits, rebase the rest. */
  setServer(doc: EgressDocument | null, confirmedRequestIds: Iterable<ID> = []): void {
    this.server = doc;
    const confirmed = new Set(confirmedRequestIds);
    this.pending = this.pending.filter(p => !confirmed.has(p.requestId));
    this.rebase();
  }

  /**
   * Apply locally. Returns the request to send to the server, or the error if
   * the edit is invalid against the current view (nothing is sent then).
   */
  propose(requestId: ID, commands: EditCommand[], history: 'record' | 'undo' | 'redo' = 'record'):
    { ok: true; request: { requestId: ID; baseRevision: number; commands: EditCommand[] }; created: ID[][] } | { ok: false; error: DomainErrorData } {
    if (!this.current) return { ok: false, error: { code: 'NOT_FOUND', message: 'No project is open.' } };
    const result = applyEdit(this.current, { requestId, commands });
    if (!result.ok) {
      this.lastError = result.error;
      return { ok: false, error: result.error };
    }
    this.lastError = null;
    const baseRevision = this.server?.revision ?? 0;
    this.pending.push({ requestId, commands, baseRevision });
    this.current = result.doc;
    if (history === 'record') { this.undoStack.push(result.inverse); this.redoStack.length = 0; }
    else if (history === 'undo') this.redoStack.push(result.inverse);
    else this.undoStack.push(result.inverse);
    return { ok: true, request: { requestId, baseRevision, commands }, created: result.created };
  }

  /** The server refused this edit: forget it and show its error. */
  reject(requestId: ID, error: DomainErrorData): void {
    this.pending = this.pending.filter(p => p.requestId !== requestId);
    this.lastError = error;
    this.rebase();
  }

  takeUndo(): PatchCommand | undefined {
    return this.undoStack.pop();
  }

  takeRedo(): PatchCommand | undefined {
    return this.redoStack.pop();
  }

  private rebase(): void {
    let doc = this.server;
    const survivors: Pending[] = [];
    for (const p of this.pending) {
      if (!doc) break;
      const result = applyEdit(doc, { requestId: p.requestId, commands: p.commands });
      if (result.ok) {
        doc = result.doc;
        survivors.push(p);
      } else {
        // Someone else's edit made ours impossible; the server will reject it too.
        this.lastError = result.error;
      }
    }
    this.pending = survivors;
    this.current = doc;
  }
}
