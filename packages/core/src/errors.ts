export type DomainErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'STALE_EDIT'
  | 'INVALID_INPUT'
  | 'INVALID_GEOMETRY'
  | 'OBJECT_COLLISION'
  | 'OPENING_OUTSIDE_WALL'
  | 'NO_REACHABLE_EXIT'
  | 'POPULATION_INFEASIBLE'
  | 'RUN_LIMIT_EXCEEDED'
  | 'INVALID_SCENARIO'
  | 'UNSUPPORTED_MODEL'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

export interface DomainErrorData {
  code: DomainErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Thrown by pure core functions and SpacetimeDB reducers; serializes to `DomainErrorData`. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  toJSON(): DomainErrorData {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }

  /** Reducer errors cross the wire as strings; this is the inverse of `toWire`. */
  static fromWire(text: string): DomainError {
    const match = /^([A-Z_]+): ([\s\S]*)$/.exec(text);
    return match ? new DomainError(match[1] as DomainErrorCode, match[2]) : new DomainError('INTERNAL_ERROR', text);
  }

  toWire(): string {
    return `${this.code}: ${this.message}`;
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;
