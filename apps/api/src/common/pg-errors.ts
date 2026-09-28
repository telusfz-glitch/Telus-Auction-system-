import { ApiError } from './api-error';

/**
 * Turns constraint / guard-trigger failures into client-safe errors. Only the error CLASS is exposed, never
 * Postgres's message (it can contain values and schema names); anything unrecognised is rethrown → generic 500.
 */
export function mapPgError(err: unknown): unknown {
  const e = err as { code?: string; message?: string };
  switch (e?.code) {
    case '23505': return new ApiError('ALREADY_EXISTS', 'A record with the same unique value already exists.', 409);
    case '23503': return new ApiError('REFERENCE_NOT_FOUND', 'A referenced record does not exist.', 422);
    case '23P01': return new ApiError('OVERLAP', 'The ranges overlap.', 422);
    case '23514': return new ApiError('CONSTRAINT_VIOLATION', 'The values are not allowed.', 422);
    case '42501':
      if (/^(AUCTION_TRANSITION_FORBIDDEN|AUCTION_FROZEN|LOT_FROZEN)/.test(e.message ?? '')) {
        return new ApiError('INVALID_STATE', 'That change is not allowed in the auction\'s current state.', 409);
      }
      return err;
    default: return err;
  }
}
