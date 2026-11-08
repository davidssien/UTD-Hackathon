/**
 * SpacetimeDB adapter for the runner: implements RunnerBackend over the
 * generated bindings (service-only reducers + runner views). The job logic
 * itself lives in jobs.ts and is tested without a database.
 */
import { DbConnection, tables } from '../../../packages/client/src/bindings/index.ts';
import { canonicalJson, parseDocumentJson, type AgentStepKind, type EditCommand, type EgressDocument, type ID, type ProposalNotes } from '@egress/core';
import type { RunRecord } from '@egress/agent';
import type { RunnerBackend } from './jobs.ts';

export interface ConnectOptions {
  uri: string;
  db: string;
  token?: string;
  onToken?: (token: string) => void;
  log?: (line: string) => void;
}

export function connect(options: ConnectOptions): Promise<{ conn: DbConnection; identity: string }> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(options.uri)
      .withDatabaseName(options.db)
      .withToken(options.token)
      .onConnect((conn, identity, token) => {
        options.onToken?.(token);
        resolve({ conn, identity: identity.toHexString() });
      })
      .onConnectError((_ctx, error) => reject(error))
      .onDisconnect(() => options.log?.('[spacetime] disconnected'))
      .build();
  });
}

/** Resolve once `check` passes, re-checking on every table change (or after `ms`). */
export function until<T>(check: () => T | undefined | null | false, ms = 10_000, what = 'condition'): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started > ms) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

export class SpacetimeBackend implements RunnerBackend {
  readonly conn: DbConnection;
  readonly records = new Map<ID, RunRecord>();

  constructor(conn: DbConnection) {
    this.conn = conn;
  }

  /** Subscribe to the runner views; resolves when the initial rows are in. */
  subscribe(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(ctx => reject(new Error(`runner subscription failed: ${String((ctx as { event?: unknown }).event ?? 'unknown')}`)))
        .subscribe([tables.runnerQueue, tables.runnerAgentQueue, tables.runnerInputs, tables.runnerLabelQueue]);
    });
  }

  async claimLabelRequest(projectId: string) {
    await this.conn.reducers.claimLabelRequest({ projectId });
  }

  async publishRoomLabels(projectId: string, labels: string, source: 'nemotron' | 'rules') {
    await this.conn.reducers.publishRoomLabels({ projectId, labels, source });
  }

  async claimRun(runId: ID) {
    await this.conn.reducers.claimSimulation({ runId });
  }

  async loadSnapshot(layoutHash: string): Promise<EgressDocument> {
    const row = await until(() => [...this.conn.db.runnerInputs.iter()].find(r => r.hash === layoutHash), 10_000, `snapshot ${layoutHash}`);
    return parseDocumentJson(row.document);
  }

  async appendChunk(runId: ID, chunkIndex: number, firstTick: number, lastTick: number, encoding: string, bytes: Uint8Array) {
    await this.conn.reducers.appendReplayChunk({ runId, chunkIndex, firstTick, lastTick, encoding, bytes });
  }

  async publishResult(runId: ID, metrics: string, fields: Uint8Array, grid: string) {
    await this.conn.reducers.publishRunResult({ runId, metrics, fields, grid });
  }

  async failRun(runId: ID, code: string, message: string) {
    await this.conn.reducers.failSimulation({ runId, code, message });
  }

  /** A run we claimed that is no longer visible as running was cancelled (or deleted). */
  isCancelled(runId: ID): boolean {
    const row = [...this.conn.db.runnerQueue.iter()].find(r => r.id === runId);
    return !row || row.status === 'cancelled';
  }

  async claimAgentJob(jobId: ID) {
    await this.conn.reducers.claimAgentJob({ jobId });
  }

  async startAgentRun(runId: ID, jobId: ID, document: string, scenario: string) {
    await this.conn.reducers.startAgentRun({ runId, jobId, document, scenario });
  }

  async appendAgentStep(jobId: ID, seq: number, kind: AgentStepKind, toolName: string, payload: string) {
    await this.conn.reducers.appendAgentStep({ jobId, seq, kind, toolName, payload });
  }

  async publishProposal(proposalId: ID, jobId: ID, commands: EditCommand[], notes: ProposalNotes, baselineRunId: ID, candidateRunId: ID, delta: Record<string, number>) {
    await this.conn.reducers.publishProposal({
      proposalId, jobId, commands: JSON.stringify(commands), notes: canonicalJson(notes), baselineRunId, candidateRunId, delta: canonicalJson(delta),
    });
  }

  async finishAgentJob(jobId: ID, status: 'complete' | 'failed', summary: string) {
    await this.conn.reducers.finishAgentJob({ jobId, status, summary });
  }

  findRunRecord(runId: ID) {
    return this.records.get(runId);
  }
}
