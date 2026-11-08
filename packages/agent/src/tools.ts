/**
 * The agent's allowlisted tools (Plan.md §7). Every call is schema-validated,
 * budgeted, and logged as tool_call / tool_result steps. Numbers returned here
 * come from real simulations; the model only chooses what to try.
 */
import { z } from 'zod';
import {
  applyEdit, deriveLayout, DomainError, EditCommandSchema, openingCenter,
  type EditCommand, type ID, type SimulationMetrics,
} from '@egress/core';
import type { AgentEnvironment, RunRecord } from './environment.ts';
import { suggestionsFor, type Suggestion } from './candidates.ts';

export interface AgentBudget {
  maxToolCalls: number;
  maxScenarios: number;
  maxCandidates: number;
}

export const DEFAULT_BUDGET: AgentBudget = { maxToolCalls: 12, maxScenarios: 2, maxCandidates: 3 };

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
  submit_proposal: z.object({ baselineRunId: id, candidateRunId: id, summary: z.string().min(1).max(1500) }).strict(),
} as const;
export type ToolName = keyof typeof ARGS;
export const TOOL_NAMES = Object.keys(ARGS) as ToolName[];

export const TOOL_SPECS: ToolSpec[] = [
  spec('inspect_layout', 'Summarize the building: rooms with areas, exits and doors with widths and positions, and geometry warnings.', {}),
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
  spec('submit_proposal', 'Submit a tested candidate for human approval. Only tested candidates can be submitted; the change is not applied until a person accepts it.', {
    baselineRunId: { type: 'string' }, candidateRunId: { type: 'string' }, summary: { type: 'string', description: 'Plain explanation citing measured numbers; say "modeled".' },
  }, ['baselineRunId', 'candidateRunId', 'summary']),
];

function spec(name: ToolName, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
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
      case 'submit_proposal': {
        const candidate = this.candidates.get(args.candidateRunId as string);
        if (!candidate) throw new DomainError('NOT_FOUND', 'Only candidates tested with test_edit_batch can be proposed.');
        const baseline = await this.run(args.baselineRunId as string);
        const d = delta(baseline.metrics, candidate.run.metrics);
        const why = candidate.suggestion
          ? `${candidate.suggestion.rationale} Modeled with the same ${baseline.metrics.initialPeople} people: ${describeDelta(d)}.`
          : `Modeled with the same ${baseline.metrics.initialPeople} people: ${describeDelta(d)}.`;
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
    const { topology, diagnostics } = deriveLayout(doc);
    const openings = doc.openings.filter(o => o.openingKind !== 'window').map(o => {
      const c = openingCenter(doc, o);
      return { id: o.id, kind: o.openingKind, widthM: o.widthM, state: o.state, center: c ? { x: round(c.x), y: round(c.y) } : null };
    });
    return {
      rooms: topology.rooms.map(r => ({ id: r.id, areaM2: round(r.area) })),
      exits: openings.filter(o => o.kind === 'exit'),
      doors: openings.filter(o => o.kind === 'door'),
      walls: doc.walls.length,
      warnings: diagnostics.map(d => `${d.code}: ${d.message}`),
    };
  }
}

const KEYS = ['evacuationTimeSeconds', 'maxQueueLength', 'peakCongestion', 'meanCongestion', 'evacuatedPeople', 'unreachablePeople'] as const;

export function delta(base: SimulationMetrics, cand: SimulationMetrics): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KEYS) {
    const a = base[k], b = cand[k];
    if (typeof a === 'number' && typeof b === 'number') out[k] = round(b - a);
  }
  if (base.evacuationTimeSeconds && cand.evacuationTimeSeconds) out.evacuationTimePercent = round(((cand.evacuationTimeSeconds - base.evacuationTimeSeconds) / base.evacuationTimeSeconds) * 100);
  return out;
}

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
