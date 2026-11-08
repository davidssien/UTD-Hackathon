/**
 * Egress runner (docs/ARCHITECTURE.md §7): connects outbound to SpacetimeDB with a
 * persisted service identity, registers itself with the shared secret, then
 * claims queued simulation runs and agent jobs from the runner views.
 *
 *   node services/runner/src/main.ts            (uses services/runner/.env)
 */
import { fileURLToPath } from 'node:url';
import type { Pace } from '@egress/core';
import { config, loadToken, saveToken } from './config.ts';
import { processAgentJob, processRun } from './jobs.ts';
import { processLabelRequest } from './labels.ts';
import { hasNemotronKey, nemotronChatFn } from './llm.ts';
import { connect, SpacetimeBackend } from './spacetime.ts';

/** Clients treat a runner as online if its last heartbeat is newer than ~4 beats. */
export const HEARTBEAT_MS = 5000;
const RUNNER_VERSION = 'egress-runner 0.3';

export interface RunnerHandle {
  backend: SpacetimeBackend;
  identity: string;
  stop(): void;
}

export async function startRunner(options: { uri?: string; db?: string; token?: string | null; secret?: string; log?: (line: string) => void } = {}): Promise<RunnerHandle> {
  const log = options.log ?? (line => console.log(line));
  const uri = options.uri ?? config.spacetimeUri;
  const db = options.db ?? config.spacetimeDb;
  const { conn, identity } = await connect({
    uri, db, token: options.token === null ? undefined : options.token ?? loadToken(uri, db),
    onToken: token => { if (options.token === undefined) saveToken(token, uri, db); },
    log,
  });
  log(`[runner] connected to ${uri} / ${db} as ${identity.slice(0, 16)}…`);
  await conn.reducers.registerService({ secret: options.secret ?? config.serviceSecret() });
  const backend = new SpacetimeBackend(conn);
  await backend.subscribe();
  const chat = hasNemotronKey() ? nemotronChatFn(log) : undefined;
  log(`[runner] ready; agent mode: ${chat ? `Nemotron (${config.nemotronModel})` : 'heuristic (no NVIDIA_API_KEY)'}`);

  const busy = new Set<string>();
  let stopped = false;

  const pump = () => {
    if (stopped) return;
    for (const run of conn.db.runnerQueue.iter()) {
      if (run.status !== 'queued' || busy.has(run.id) || run.agentJobId) continue;
      busy.add(run.id);
      void processRun(backend, { runId: run.id, layoutHash: run.layoutHash, scenarioJson: run.scenario, pace: run.pace as Pace }, { log })
        .then(outcome => {
          if (outcome.state && outcome.metrics) {
            backend.records.set(run.id, {
              runId: run.id, label: 'user run', scenario: outcome.state.scenario, layoutHash: run.layoutHash, metrics: outcome.metrics,
              initialActors: outcome.state.initial, respawned: 0, computeMs: outcome.computeMs,
            });
          }
        })
        .finally(() => busy.delete(run.id));
    }
    for (const job of conn.db.runnerAgentQueue.iter()) {
      if (job.status !== 'queued' || busy.has(job.id)) continue;
      busy.add(job.id);
      void processAgentJob(backend, { jobId: job.id, projectId: job.projectId, prompt: job.prompt, contextJson: job.context, snapshotHash: job.snapshotHash }, { chat, log })
        .finally(() => busy.delete(job.id));
    }
  };
  const labelling = () => {
    if (stopped) return;
    for (const req of conn.db.runnerLabelQueue.iter()) {
      const key = `labels:${req.projectId}`;
      if (req.status !== 'queued' || busy.has(key)) continue;
      busy.add(key);
      void processLabelRequest(backend, { projectId: req.projectId, rooms: req.rooms }, log).finally(() => busy.delete(key));
    }
  };
  conn.db.runnerQueue.onInsert(() => pump());
  conn.db.runnerAgentQueue.onInsert(() => pump());
  let labelsReady = false;
  backend.subscribeLabels().then(() => { labelsReady = true; labelling(); }).catch(e => log(`[runner] room labelling off: ${e instanceof Error ? e.message : String(e)}`));
  conn.db.runnerLabelQueue.onInsert(() => labelling());
  conn.db.runnerLabelQueue.onUpdate(() => labelling());
  const labelTimer = setInterval(() => { if (labelsReady) labelling(); }, 1000);
  const timer = setInterval(pump, 1000); // belt and braces in case an insert callback is missed
  pump();

  // Liveness for the UI ("simulation server offline" instead of an endless "queued").
  const jobIds = () => new Set([...conn.db.runnerAgentQueue.iter()].map(j => j.id));
  const beat = () => {
    if (stopped) return;
    const jobs = jobIds();
    const activeJobs = [...busy].filter(id => jobs.has(id)).length;
    void conn.reducers.runnerHeartbeat({
      agentModel: chat ? config.nemotronModel : 'heuristic', activeRuns: busy.size - activeJobs, activeJobs, version: RUNNER_VERSION,
    }).catch(e => log(`[runner] heartbeat failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  beat();

  return {
    backend,
    identity,
    stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(labelTimer);
      clearInterval(heartbeat);
      conn.disconnect();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startRunner().catch(e => {
    console.error('[runner] fatal:', e);
    process.exit(1);
  });
}
