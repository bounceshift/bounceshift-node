import type { ValidationResult, ValidationStatus } from './types.js';

/** Statuses considered safe to send to. */
const SAFE_STATUSES: ReadonlySet<ValidationStatus> = new Set<ValidationStatus>([
  'valid',
  'catch_all',
]);

/**
 * Whether an email is safe to send to.
 *
 * Accepts either a bare {@link ValidationStatus} or a full
 * {@link ValidationResult}. Mirrors the API's `isSafeToSend()`: true when the
 * status is `valid` or `catch_all`.
 */
export function isSafeToSend(
  statusOrResult: ValidationStatus | ValidationResult
): boolean {
  const status =
    typeof statusOrResult === 'string'
      ? statusOrResult
      : statusOrResult.status;

  return SAFE_STATUSES.has(status);
}
