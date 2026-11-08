/**
 * Shared live simulation (PLAN.md §3 K, D89). One user run per project at a time; while it is
 * queued or running, the layout is locked. The SpacetimeDB module enforces the lock, and clients
 * use the same rule to show it. A run that has not moved for `RUN_LOCK_STALE_MS` (no runner, or a
 * runner that died) stops locking, so a project can never stay locked forever.
 */

/** A run with no progress for this long no longer locks editing (ms). */
export const RUN_LOCK_STALE_MS = 120_000;

/** What a person is doing on a project, shown by presence. */
export const PRESENCE_MODES = ['edit', 'simulate', 'analysis'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

export interface LockingRunFacts {
  status: string;
  /** '' or null for user runs; agent runs never lock. */
  agentJobId: string | null;
  /** Last progress time (ms since epoch). */
  updatedAtMs: number;
}

/** Does this run lock the project's layout at `nowMs`? */
export function locksEditing(run: LockingRunFacts, nowMs: number): boolean {
  if (run.agentJobId) return false;
  if (run.status !== 'queued' && run.status !== 'running') return false;
  return nowMs - run.updatedAtMs <= RUN_LOCK_STALE_MS;
}

export const LOCKED_MESSAGE = 'A simulation is running on this project. Editing unlocks when it ends or someone stops it.';
