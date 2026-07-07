import type { Recommendation, ValidationResult } from './types.js';

/** Recommendations for which sending is advised. */
const SENDABLE_RECOMMENDATIONS: ReadonlySet<Recommendation> =
  new Set<Recommendation>(['deliverable', 'send_with_caution']);

/**
 * Whether the API recommends sending to this address.
 *
 * Accepts either a bare {@link Recommendation} or a full
 * {@link ValidationResult}. Mirrors the server's recommendation semantics:
 * true only for `deliverable` or `send_with_caution`.
 *
 * Tolerant by design — never throws. A missing/`null` recommendation, or an
 * unknown recommendation string the SDK does not model, is treated as **not**
 * sendable.
 */
export function isSendable(
  recommendationOrResult:
    | Recommendation
    | ValidationResult
    | null
    | undefined
): boolean {
  if (recommendationOrResult === null || recommendationOrResult === undefined) {
    return false;
  }

  const recommendation =
    typeof recommendationOrResult === 'string'
      ? recommendationOrResult
      : recommendationOrResult.recommendation;

  if (recommendation === null) {
    return false;
  }

  return (SENDABLE_RECOMMENDATIONS as ReadonlySet<string>).has(recommendation);
}
