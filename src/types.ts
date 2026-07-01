/**
 * The exact set of validation statuses the BounceShift API can return.
 * Mirrors the `ValidationStatus` enum in the core service.
 */
export type ValidationStatus =
  | 'valid'
  | 'invalid'
  | 'risky'
  | 'catch_all'
  | 'unknown'
  | 'disposable'
  | 'spamtrap'
  | 'abuse'
  | 'do_not_mail';

/** All valid statuses, used to validate API responses at runtime. */
export const VALIDATION_STATUSES: readonly ValidationStatus[] = [
  'valid',
  'invalid',
  'risky',
  'catch_all',
  'unknown',
  'disposable',
  'spamtrap',
  'abuse',
  'do_not_mail',
] as const;

/**
 * The result of validating a single email address.
 *
 * Field names are camelCase, mapped from the snake_case keys the API returns.
 */
export interface ValidationResult {
  /** The email address that was validated (echoed by the API). */
  email: string;
  /** The overall validation status. */
  status: ValidationStatus;
  /** Confidence in the verdict, 0–100. */
  confidence: number;
  /** Whether the domain has usable MX records. */
  mxFound: boolean;
  /** SMTP mailbox check result; `null` when inconclusive/not performed. */
  smtpValid: boolean | null;
  /** Whether the address belongs to a disposable-email provider. */
  isDisposable: boolean;
  /** Whether the domain accepts all mail (catch-all). */
  isCatchAll: boolean;
  /** Whether the local part is a role account (info@, support@, ...). */
  isRoleAccount: boolean;
  /** Whether this result was served from cache (no credit charged). */
  fromCache: boolean;
  /** Credits consumed by this request (0 when served from cache). */
  creditsUsed: number;
  /** Freeform sub-status detail describing how the verdict was reached. */
  result: Record<string, unknown>;
}
