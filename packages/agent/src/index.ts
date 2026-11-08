/**
 * @egress/agent — Analysis-mode agent (Plan.md §7). Pure TS over @egress/core
 * and @egress/sim: runs in the runner (with Nemotron) and in the browser mock
 * (heuristic planner), always through the same validated tools.
 */
export { LocalEnvironment, yieldToEventLoop, type AgentEnvironment, type AgentStepRecord, type ProposalDraft, type RunRecord, type RunRequest } from './environment.ts';
export { suggestionsFor, type Suggestion } from './candidates.ts';
export { DEFAULT_BUDGET, delta, describeDelta, summarizeRun, ToolBox, TOOL_NAMES, TOOL_SPECS, type AgentBudget, type ToolName, type ToolSpec } from './tools.ts';
export { runHeuristicAgent, runLlmAgent, SYSTEM_PROMPT, type AgentOutcome, type ChatFn, type ChatMessage } from './planner.ts';
