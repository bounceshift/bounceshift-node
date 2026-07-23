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
 * The action-oriented deliverability recommendation the API returns alongside
 * the raw {@link ValidationStatus}. This is a higher-level verdict derived
 * server-side; the SDK surfaces it as-is rather than re-deriving it.
 */
export type Recommendation =
  | 'deliverable'
  | 'send_with_caution'
  | 'risky'
  | 'undeliverable'
  | 'unknown';

/** All recommendations the SDK knows, used to validate API responses at runtime. */
export const RECOMMENDATIONS: readonly Recommendation[] = [
  'deliverable',
  'send_with_caution',
  'risky',
  'undeliverable',
  'unknown',
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
  /** Granular reason for the verdict (e.g. `smtp_verified`); `null` when not set. */
  subStatus: string | null;
  /**
   * Action-oriented deliverability recommendation, normalized to a known
   * {@link Recommendation}. `null` when the API omits it or sends a value this
   * SDK version does not recognize — in the latter case the original string is
   * preserved in {@link ValidationResult.recommendationRaw}.
   */
  recommendation: Recommendation | null;
  /**
   * The recommendation string exactly as the API sent it, kept even when it is
   * not a known {@link Recommendation}. `null` when the API omits it.
   */
  recommendationRaw: string | null;
  /**
   * Quality score, 0–100. Its own signal: it currently tracks `confidence` but
   * may diverge, so it is modeled separately. `null` when the API omits it
   * (e.g. some error paths).
   */
  qualityScore: number | null;
  /** Plain-English sentence describing the verdict; `null` when the API omits it. */
  explanation: string | null;
  /**
   * The corrected address when the domain looks like a misspelling of a major
   * provider (`gmial.com` -> `gmail.com`); `null` otherwise.
   *
   * Advisory only. The API validates the address you sent, never the
   * suggestion, and the verdict is unaffected — show the correction to whoever
   * typed the address rather than substituting it, since the mailbox at the
   * misspelled domain may genuinely exist.
   *
   * Populated on any status, including `valid` and `disposable`: misspellings
   * that resolve accept mail and never bounce, so this is the only signal you
   * get for them.
   */
  didYouMean: string | null;
}
