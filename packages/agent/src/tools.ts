/**
 * The agent's allowlisted tools (docs/ARCHITECTURE.md §7). Every call is schema-validated,
 * budgeted, and logged as tool_call / tool_result steps. Numbers returned here
 * come from real simulations; the model only chooses what to try.
 */
import { z } from 'zod';
import {
  applyEdit, deriveLayout, DomainError, EditCommandSchema, effectiveTime, metricsDelta, openingCenter,
  type EditCommand, type ID, type SimulationMetrics,
} from '@egress/core';
import type { AgentEnvironment, RunRecord } from './environment.ts';
import { suggestionsFor, type Suggestion } from './candidates.ts';
import { complianceChecks, describeLayout, resolvePlacement } from './layout.ts';

export interface AgentBudget {
  maxToolCalls: number;
  maxScenarios: number;
  maxCandidates: number;
  /** Extra-seed confirmations (each runs 2 baseline + 2 candidate simulations). */
  maxConfirmations?: number;
}

export const DEFAULT_BUDGET: AgentBudget = { maxToolCalls: 14, maxScenarios: 2, maxCandidates: 4, maxConfirmations: 1 };
/** A job may leave the requested change and, separately, a better alternative (D72). */
export const MAX_PROPOSALS_PER_JOB = 2;

/** OpenAI-style function tool spec (what Nemotron sees). */
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const id = z.string().min(1).max(200);
const ARGS = {
  inspect_layout: z.object({}).strict(),
  inspect_run: z.object({ runId: id }).strict(),
  run_scenario: z.object({ people: z.number().int().min(1).max(2000).optional(), blockedExitIds: z.array(id).max(20).optional() }).strict(),
  get_hotspots: z.object({ runId: id, topK: z.number().int().min(1).max(5).optional() }).strict(),
  test_edit_batch: z.object({ baselineRunId: id, suggestionId: z.string().max(20).optional(), commands: z.array(EditCommandSchema).min(1).max(5).optional() }).strict(),
  compare_runs: z.object({ baselineRunId: id, candidateRunId: id }).strict(),
  confirm_candidate: z.object({ candidateRunId: id }).strict(),
  submit_proposal: z.object({ baselineRunId: id, candidateRunId: id, summary: z.string().min(1).max(1500), requested: z.boolean().optional() }).strict(),
  place_opening: z.object({
    kind: z.enum(['door', 'window', 'exit']), widthM: z.number().min(0.5).max(6).optional(), wallId: id.optional(), offsetM: z.number().min(0).max(500).optional(),
    at: z.enum(['start', 'center', 'end']).optional(), roomId: id.optional(), farthestFromOpeningId: id.optional(),
  }).strict(),
  check_compliance: z.object({}).strict(),
} as const;
export type ToolName = keyof typeof ARGS;
export const TOOL_NAMES = Object.keys(ARGS) as ToolName[];

export const TOOL_SPECS: ToolSpec[] = [
  spec('inspect_layout', 'Describe the building: rooms (id, kind room/hallway/closet, size, centre, neighbouring rooms, opening ids), walls (id, length, ends, whether outside, rooms on each side, openings with offsets), and geometry warnings. Use it to ground any place the user names.', {}),
  spec('place_opening', 'Turn a requested placement into a valid new door, window or exit and register it as a suggestionId for test_edit_batch. Give a wallId (and offsetM or at), or a roomId to search that room\'s walls; farthestFromOpeningId puts it as far as possible from an existing opening (e.g. "the other end of the hallway from the door"). Exits need an outside wall.', {
    kind: { type: 'string', enum: ['door', 'window', 'exit'] }, widthM: { type: 'number' }, wallId: { type: 'string' }, offsetM: { type: 'number' },
    at: { type: 'string', enum: ['start', 'center', 'end'] }, roomId: { type: 'string' }, farthestFromOpeningId: { type: 'string' },
  }, ['kind']),
  spec('check_compliance', 'Modeled code-style checks (door width, exit count and capacity for the head count, corridor width, travel distance). Failing door widths come back as suggestionIds you can test. Not a code review.', {}),
  spec('inspect_run', 'Get the scenario and measured metrics of an existing simulation run.', { runId: { type: 'string' } }, ['runId']),
  spec('run_scenario', 'Run an evacuation simulation on the current layout (counts against a budget of 2). Optionally change head count or block exits.', {
    people: { type: 'integer', minimum: 1, maximum: 2000 }, blockedExitIds: { type: 'array', items: { type: 'string' } },
  }),
  spec('get_hotspots', 'Ranked congestion hotspots of a run, each with the nearest door or exit, plus validated design suggestions (suggestionId) you can test.', {
    runId: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 5 },
  }, ['runId']),
  spec('test_edit_batch', 'Apply a suggested design change to a copy of the layout and rerun the baseline scenario with the exact same people. Pass a suggestionId from get_hotspots. Budget: 3 candidates.', {
    baselineRunId: { type: 'string' }, suggestionId: { type: 'string' },
  }, ['baselineRunId']),
  spec('compare_runs', 'Metric differences (candidate minus baseline) between two runs.', { baselineRunId: { type: 'string' }, candidateRunId: { type: 'string' } }, ['baselineRunId', 'candidateRunId']),
  spec('confirm_candidate', 'Re-test a tested candidate on 2 more random seeds (fresh crowds, same layouts) to check the improvement is not a fluke of one population. Budget: 1. Do this before submit_proposal.', {
    candidateRunId: { type: 'string' },
  }, ['candidateRunId']),
  spec('submit_proposal', 'Submit a tested candidate for human approval (at most 2 per job). Only tested candidates can be submitted; nothing is applied until a person accepts it. Set requested=true when this is the change the user asked for: it is then allowed even if it does not improve the outcome, and the measured effect is stated honestly.', {
    baselineRunId: { type: 'string' }, candidateRunId: { type: 'string' }, summary: { type: 'string', description: 'Plain explanation citing measured numbers; say "modeled".' },
    requested: { type: 'boolean' },
  }, ['baselineRunId', 'candidateRunId', 'summary']),
];

function spec(name: ToolName, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

/** Result of re-testing a candidate on extra seeds (spec P1: three random-seed comparison). */
export interface Robustness {
  seeds: number[];
  /** effectiveTime delta per seed (candidate − baseline, seconds). */
  effectiveTimeDeltas: number[];
  meanSeconds: number;
  worstSeconds: number;
  improvedOnAll: boolean;
}

export interface Candidate {
  run: RunRecord;
  baselineRunId: ID;
  commands: EditCommand[];
  suggestion?: Suggestion;
}

export class ToolBox {
  readonly env: AgentEnvironment;
  readonly budget: AgentBudget;
  readonly candidates = new Map<ID, Candidate>();
  readonly suggestions = new Map<string, Suggestion>();
  readonly proposals: ID[] = [];
  readonly robustness = new Map<ID, Robustness>();
  confirmed = 0;
  calls = 0;
  scenarios = 0;
  tested = 0;
  readonly jobId: string;

  constructor(env: AgentEnvironment, jobId: string, budget: AgentBudget = DEFAULT_BUDGET) {
    this.env = env;
    this.jobId = jobId;
    this.budget = budget;
  }

  /** Validate, budget, execute and log one tool call. Errors come back as results so the model can recover. */
  async call(name: string, rawArgs: unknown): Promise<unknown> {
    if (!(name in ARGS)) return this.fail(name, rawArgs, `Unknown tool ${name}. Allowed: ${TOOL_NAMES.join(', ')}.`);
    if (this.calls >= this.budget.maxToolCalls) return this.fail(name, rawArgs, `Tool budget of ${this.budget.maxToolCalls} calls is used up. Summarize what you measured.`);
    this.calls++;
    const parsed = ARGS[name as ToolName].safeParse(rawArgs ?? {});
    if (!parsed.success) return this.fail(name, rawArgs, `Invalid arguments: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    await this.env.log({ kind: 'tool_call', toolName: name, payload: parsed.data });
    try {
      const result = await this.execute(name as ToolName, parsed.data);
      await this.env.log({ kind: 'tool_result', toolName: name, payload: result });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.env.log({ kind: 'error', toolName: name, payload: { message } });
      return { error: message };
    }
  }

  private async fail(name: string, args: unknown, message: string) {
    await this.env.log({ kind: 'error', toolName: name, payload: { args, message } });
    return { error: message };
  }

  private async execute(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'inspect_layout': return this.inspectLayout();
      case 'inspect_run': return summarizeRun(await this.run(args.runId as string));
      case 'run_scenario': {
        if (this.scenarios >= this.budget.maxScenarios) throw new DomainError('RUN_LIMIT_EXCEEDED', `Scenario budget of ${this.budget.maxScenarios} is used up.`);
        this.scenarios++;
        const base = this.env.defaultScenario();
        const scenario = {
          ...base,
          id: `${this.jobId}.scenario${this.scenarios}`,
          population: { ...base.population, count: (args.people as number | undefined) ?? base.population.count },
          goal: { kind: 'evacuate' as const, blockedExitIds: (args.blockedExitIds as string[] | undefined) ?? base.goal.blockedExitIds },
        };
        const run = await this.env.runScenario({ document: this.env.document(), scenario, label: 'baseline' });
        return summarizeRun(run);
      }
      case 'get_hotspots': {
        const run = await this.run(args.runId as string);
        const hotspots = run.metrics.bottlenecks.slice(0, (args.topK as number | undefined) ?? 3);
        const suggestions = suggestionsFor(this.env.document(), hotspots);
        for (const s of suggestions) this.suggestions.set(s.suggestionId, s);
        return {
          runId: run.runId,
          hotspots: hotspots.map(h => ({ center: h.regionCenter, score: h.score, peakAtSecond: (h.observedAtTick ?? 0) / 10, description: h.description })),
          suggestions: suggestions.map(s => ({ suggestionId: s.suggestionId, title: s.title, rationale: s.rationale })),
        };
      }
      case 'test_edit_batch': {
        if (this.tested >= this.budget.maxCandidates) throw new DomainError('RUN_LIMIT_EXCEEDED', `Candidate budget of ${this.budget.maxCandidates} is used up.`);
        const baseline = await this.run(args.baselineRunId as string);
        const suggestion = args.suggestionId ? this.suggestions.get(args.suggestionId as string) : undefined;
        if (args.suggestionId && !suggestion) throw new DomainError('NOT_FOUND', `No suggestion ${String(args.suggestionId)}; call get_hotspots first.`);
        const commands = (suggestion?.commands ?? args.commands) as EditCommand[] | undefined;
        if (!commands?.length) throw new DomainError('INVALID_INPUT', 'Pass a suggestionId (preferred) or commands.');
        const applied = applyEdit(this.env.document(), { requestId: `${this.jobId}.candidate${this.tested}`, commands });
        if (!applied.ok) throw new DomainError(applied.error.code, `That change is not valid geometry: ${applied.error.message}`);
        this.tested++;
        const run = await this.env.runScenario({ document: applied.doc, scenario: baseline.scenario, label: suggestion?.title ?? 'candidate', initialActors: baseline.initialActors });
        this.candidates.set(run.runId, { run, baselineRunId: baseline.runId, commands, suggestion });
        return { ...summarizeRun(run), change: suggestion?.title ?? 'custom edit', delta: delta(baseline.metrics, run.metrics), controlled: run.respawned === 0 };
      }
      case 'compare_runs': {
        const [a, b] = [await this.run(args.baselineRunId as string), await this.run(args.candidateRunId as string)];
        return { delta: delta(a.metrics, b.metrics), samePopulation: b.respawned === 0, sameSeed: a.scenario.population.seed === b.scenario.population.seed };
      }
      case 'confirm_candidate': {
        if (this.confirmed >= (this.budget.maxConfirmations ?? 1)) throw new DomainError('RUN_LIMIT_EXCEEDED', 'Confirmation budget is used up.');
        const candidate = this.candidates.get(args.candidateRunId as string);
        if (!candidate) throw new DomainError('NOT_FOUND', 'Only candidates tested with test_edit_batch can be confirmed.');
        this.confirmed++;
        const baseline = await this.run(candidate.baselineRunId);
        const applied = applyEdit(this.env.document(), { requestId: `${this.jobId}.confirm`, commands: candidate.commands });
        if (!applied.ok) throw new DomainError(applied.error.code, applied.error.message);
        const seed0 = baseline.scenario.population.seed;
        const trials = [{ seed: seed0, delta: delta(baseline.metrics, candidate.run.metrics) }];
        for (const seed of [(seed0 + 1) >>> 0, (seed0 + 2) >>> 0]) {
          const scenario = { ...baseline.scenario, population: { ...baseline.scenario.population, seed } };
          const b = await this.env.runScenario({ document: this.env.document(), scenario, label: `baseline, seed ${seed}` });
          const c = await this.env.runScenario({ document: applied.doc, scenario, label: `${candidate.suggestion?.title ?? 'candidate'}, seed ${seed}`, initialActors: b.initialActors });
          trials.push({ seed, delta: delta(b.metrics, c.metrics) });
        }
        const times = trials.map(t => t.delta.effectiveTimeSeconds ?? 0);
        const result: Robustness = {
          seeds: trials.map(t => t.seed),
          effectiveTimeDeltas: times,
          meanSeconds: round(times.reduce((a, b) => a + b, 0) / times.length),
          worstSeconds: round(Math.max(...times)),
          improvedOnAll: times.every(t => t < -0.5),
        };
        this.robustness.set(candidate.run.runId, result);
        return result;
      }
      case 'place_opening': {
        const placement = resolvePlacement(this.env.document(), args as unknown as Parameters<typeof resolvePlacement>[1]);
        const suggestionId = `p${[...this.suggestions.keys()].filter(k => k.startsWith('p')).length + 1}`;
        this.suggestions.set(suggestionId, { suggestionId, targetId: placement.wallId, title: placement.description, rationale: `Requested: ${placement.description}.`, commands: [placement.command] });
        return { suggestionId, description: placement.description, wallId: placement.wallId, offsetM: placement.offsetM, center: placement.center };
      }
      case 'check_compliance': {
        const doc = this.env.document();
        const checks = complianceChecks(doc, this.env.defaultScenario().population.count);
        const suggestions = [];
        for (const id of checks.find(c => c.id === 'door-width' && c.status === 'fail')?.entityIds ?? []) {
          const o = doc.openings.find(x => x.id === id);
          if (!o) continue;
          const suggestionId: string = `c${suggestions.length + 1}`;
          const s: Suggestion = { suggestionId, targetId: o.id, title: `Widen the ${o.widthM} m ${o.openingKind} to 0.91 m`, rationale: `This ${o.widthM} m ${o.openingKind} is below the 0.81 m clear width used by building codes.`, commands: [{ kind: 'updateOpening' as const, openingId: o.id, patch: { widthM: 0.91 } }] };
          if (applyEdit(doc, { requestId: 'check', commands: s.commands }).ok) { this.suggestions.set(suggestionId, s); suggestions.push({ suggestionId, title: s.title }); }
        }
        return { note: 'Modeled checks against typical code values, not a code review.', checks, suggestions };
      }
      case 'submit_proposal': {
        const candidate = this.candidates.get(args.candidateRunId as string);
        if (!candidate) throw new DomainError('NOT_FOUND', 'Only candidates tested with test_edit_batch can be proposed.');
        if (candidate.baselineRunId !== args.baselineRunId) throw new DomainError('INVALID_INPUT', 'Use the baseline this candidate was tested against.');
        if (this.proposals.length >= MAX_PROPOSALS_PER_JOB) throw new DomainError('RUN_LIMIT_EXCEEDED', `A job can leave at most ${MAX_PROPOSALS_PER_JOB} proposals.`);
        const baseline = await this.run(args.baselineRunId as string);
        const d = delta(baseline.metrics, candidate.run.metrics);
        const requested = args.requested === true;
        const improves = (d.effectiveTimeSeconds ?? 0) + 0.1 * (d.maxQueueLength ?? 0) < -0.5;
        if (!improves && !requested) {
          throw new DomainError('INVALID_INPUT', 'This candidate does not measurably improve the modeled outcome. Test another suggestion or explain that no improvement was found.');
        }
        const robust = this.robustness.get(candidate.run.runId);
        if (robust && robust.meanSeconds >= -0.5 && !requested) {
          throw new DomainError('INVALID_INPUT', `The improvement did not hold across seeds (mean change ${robust.meanSeconds} s). Do not propose it.`);
        }
        if (requested) Object.assign(d, { requested: 1 });
        const across = robust
          ? ` Re-tested on ${robust.seeds.length} different crowds: mean ${signed(robust.meanSeconds)} s, worst ${signed(robust.worstSeconds)} s${robust.improvedOnAll ? ', better every time' : ''}.`
          : '';
        if (robust) Object.assign(d, { seedsTested: robust.seeds.length, robustMeanSeconds: robust.meanSeconds, robustWorstSeconds: robust.worstSeconds });
        const verdict = requested && !improves ? ' As requested; it does not improve the modeled evacuation.' : '';
        const why = candidate.suggestion
          ? `${candidate.suggestion.rationale} Modeled with the same ${baseline.metrics.initialPeople} people: ${describeDelta(d)}.${verdict}${across}`
          : `Modeled with the same ${baseline.metrics.initialPeople} people: ${describeDelta(d)}.${verdict}${across}`;
        const proposalId = await this.env.submitProposal({
          commands: candidate.commands,
          notes: { summary: String(args.summary), byCommand: Object.fromEntries(candidate.commands.map((_, i) => [String(i), why])) },
          baselineRunId: baseline.runId,
          candidateRunId: candidate.run.runId,
          delta: d,
        });
        this.proposals.push(proposalId);
        return { proposalId, status: 'awaiting human approval', delta: d };
      }
    }
  }

  private async run(runId: string): Promise<RunRecord> {
    const run = await this.env.getRun(runId);
    if (!run) throw new DomainError('NOT_FOUND', `No run ${runId}.`);
    return run;
  }

  private inspectLayout() {
    const doc = this.env.document();
    const { diagnostics } = deriveLayout(doc);
    const { rooms, walls } = describeLayout(doc);
    const openings = doc.openings.filter(o => o.openingKind !== 'window').map(o => {
      const c = openingCenter(doc, o);
      return { id: o.id, kind: o.openingKind, wallId: o.wallId, widthM: o.widthM, state: o.state, center: c ? { x: round(c.x), y: round(c.y) } : null };
    });
    return {
      rooms: rooms.map(r => ({ id: r.id, kind: r.kind, areaM2: r.areaM2, widthM: r.widthM, lengthM: r.lengthM, center: r.center, neighbours: r.neighbours, openingIds: r.openingIds })),
      exits: openings.filter(o => o.kind === 'exit'),
      doors: openings.filter(o => o.kind === 'door'),
      walls: walls.map(w => ({ id: w.id, lengthM: w.lengthM, from: { x: round(w.from.x), y: round(w.from.y) }, to: { x: round(w.to.x), y: round(w.to.y) }, outside: w.exterior, roomIds: w.roomIds, openings: w.openings })),
      warnings: diagnostics.map(d => `${d.code}: ${d.message}`),
    };
  }
}

/** Moved to @egress/core so the UI clients compute identical deltas; kept here for existing imports. */
export { effectiveTime };
export const delta = (base: SimulationMetrics, cand: SimulationMetrics): Record<string, number> => metricsDelta(base, cand);

export function describeDelta(d: Record<string, number>): string {
  const parts: string[] = [];
  if (d.evacuationTimeSeconds !== undefined) parts.push(`evacuation time ${signed(d.evacuationTimeSeconds)} s${d.evacuationTimePercent !== undefined ? ` (${signed(d.evacuationTimePercent)}%)` : ''}`);
  if (d.maxQueueLength !== undefined) parts.push(`longest queue ${signed(d.maxQueueLength)} people`);
  if (d.peakCongestion !== undefined) parts.push(`peak congestion ${signed(d.peakCongestion)}`);
  return parts.join(', ');
}

export function summarizeRun(run: RunRecord) {
  const m = run.metrics;
  return {
    runId: run.runId,
    label: run.label,
    people: m.initialPeople,
    seed: run.scenario.population.seed,
    blockedExitIds: run.scenario.goal.blockedExitIds,
    evacuationTimeSeconds: m.evacuationTimeSeconds,
    effectiveTimeSeconds: round(effectiveTime(m)),
    evacuated: m.evacuatedPeople,
    unreachable: m.unreachablePeople,
    maxQueueLength: m.maxQueueLength,
    peakCongestion: m.peakCongestion,
    meanCongestion: m.meanCongestion,
    perExitThroughput: m.perExitThroughput,
    timedOut: !m.complete || m.evacuationTimeSeconds === null,
  };
}

const round = (v: number) => Math.round(v * 100) / 100;
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
