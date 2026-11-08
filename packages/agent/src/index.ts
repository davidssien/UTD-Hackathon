/**
 * @egress/agent — Analysis-mode agent (docs/ARCHITECTURE.md §7). Pure TS over @egress/core
 * and @egress/sim: runs in the runner (with Nemotron) and in the browser mock
 * (heuristic planner), always through the same validated tools.
 */
export { LocalEnvironment, yieldToEventLoop, type AgentEnvironment, type AgentStepRecord, type ProposalDraft, type RunRecord, type RunRequest } from './environment.ts';
export { suggestionsFor, type Suggestion } from './candidates.ts';
export { DEFAULT_BUDGET, delta, describeDelta, summarizeRun, ToolBox, TOOL_NAMES, TOOL_SPECS, type AgentBudget, type ToolName, type ToolSpec } from './tools.ts';
export { classifyIntent, runHeuristicAgent, runLlmAgent, SYSTEM_PROMPT, type AgentOutcome, type ChatFn, type ChatMessage, type Intent } from './planner.ts';
export { complianceChecks, describeLayout, resolvePlacement, type ComplianceCheck, type PlacementSpec, type RoomInfo, type RoomKind, type WallInfo } from './layout.ts';
