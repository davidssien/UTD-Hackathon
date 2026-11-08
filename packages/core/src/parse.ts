/**
 * Trust-boundary parsers. Every JSON payload arriving from another process
 * (browser → reducer, DB row → runner, LLM tool call → runner) goes through
 * one of these and fails as a DomainError instead of a raw ZodError.
 */
import type { z } from 'zod';
import { DomainError, type DomainErrorCode } from './errors.ts';
import {
  EditRequestSchema, EgressDocumentSchema, EntitySchema, SimulationMetricsSchema, SimulationScenarioSchema,
} from './schemas.ts';

export function parseWith<S extends z.ZodType>(schema: S, value: unknown, what: string, code: DomainErrorCode = 'INVALID_INPUT'): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  throw new DomainError(code, `Invalid ${what}${where}: ${issue?.message ?? 'unknown problem'}`);
}

const json = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError('INVALID_INPUT', `${what} is not valid JSON.`);
  }
};

export const parseDocument = (value: unknown) => parseWith(EgressDocumentSchema, value, 'building document', 'INVALID_GEOMETRY');
export const parseDocumentJson = (text: string) => parseDocument(json(text, 'Building document'));
export const parseEntity = (value: unknown) => parseWith(EntitySchema, value, 'entity', 'INVALID_GEOMETRY');
export const parseEntityJson = (text: string) => parseEntity(json(text, 'Entity'));
export const parseEditRequest = (value: unknown) => parseWith(EditRequestSchema, value, 'edit request');
export const parseEditRequestJson = (text: string) => parseEditRequest(json(text, 'Edit request'));
export const parseScenario = (value: unknown) => parseWith(SimulationScenarioSchema, value, 'scenario', 'INVALID_SCENARIO');
export const parseScenarioJson = (text: string) => parseScenario(json(text, 'Scenario'));
export const parseMetrics = (value: unknown) => parseWith(SimulationMetricsSchema, value, 'metrics');
