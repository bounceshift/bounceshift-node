import type { ValidationResult } from './types.js';

/**
 * Whether a result is a degraded fail-open placeholder — returned by
 * {@link BounceShift.validateSafe} (or the fail-open middleware) when validation
 * was unavailable (out of credits, an outage, a timeout) — rather than a real
 * verdict from the API. Lets callers tell "we couldn't check" apart from a
 * genuine `unknown` verdict.
 */
export function isDegraded(result: ValidationResult): boolean {
  return (result.result as Record<string, unknown>)['degraded'] === true;
}
