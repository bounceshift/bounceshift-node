import { BounceShift } from './client.js';
import { BounceShiftError } from './errors.js';
import type { ValidationResult, ValidationStatus } from './types.js';

/**
 * Loose Express-compatible types. The SDK does not depend on Express at
 * runtime; these describe only the surface the middleware touches so that
 * `@types/express` stays a devDependency.
 */
interface RequestLike {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(payload: unknown): unknown;
}

type NextLike = (error?: unknown) => void;

/** Callback invoked when an email is rejected, instead of the default response. */
export type OnInvalidHandler = (
  result: ValidationResult,
  req: RequestLike,
  res: ResponseLike,
  next: NextLike
) => void | Promise<void>;

/** Options for {@link deliverableEmail}. */
export interface DeliverableEmailOptions {
  /** Request body field to read the email from. Defaults to `'email'`. */
  field?: string;
  /** Also reject `risky` and `unknown` statuses. */
  strict?: boolean;
  /** Reject results whose confidence is below this threshold (0–100). */
  minConfidence?: number;
  /** A pre-configured client. Required unless one is provided per-app elsewhere. */
  client?: BounceShift;
  /** Error message returned on block. */
  message?: string;
  /** HTTP status returned on block. Defaults to 422. */
  status?: number;
  /** Custom handler invoked on block instead of the default JSON response. */
  onInvalid?: OnInvalidHandler;
}

/**
 * Statuses always blocked (mirrors the Laravel `Deliverable` rule): a hard,
 * unambiguous "do not send" verdict.
 */
const ALWAYS_BLOCKED: ReadonlySet<ValidationStatus> = new Set<ValidationStatus>(
  ['invalid', 'disposable', 'do_not_mail', 'abuse', 'spamtrap']
);

/** Additional statuses blocked only in `strict` mode. */
const STRICT_BLOCKED: ReadonlySet<ValidationStatus> = new Set<ValidationStatus>(
  ['risky', 'unknown']
);

/**
 * Express middleware that rejects requests carrying an undeliverable email.
 *
 * Default policy blocks only clearly bad addresses
 * (`invalid`/`disposable`/`do_not_mail`/`abuse`/`spamtrap`) and lets
 * `valid`/`catch_all`/`unknown`/`risky` through.
 *
 * `strict` additionally blocks `risky` and `unknown`; `minConfidence`
 * additionally blocks results below the given confidence.
 *
 * ⚠️ `strict` and `minConfidence` can reject real users. Providers on
 * throttled SMTP infra (Outlook/Hotmail, Gmail) frequently return low-
 * confidence `unknown` for perfectly good mailboxes — enabling these options
 * trades signup conversion for stricter filtering. Use with care.
 *
 * The middleware **fails open**: any {@link BounceShiftError} (outage,
 * timeout, rate limit, auth misconfig) calls `next()` so an API problem never
 * blocks signups. Unexpected non-SDK errors are passed to `next(error)`.
 */
export function deliverableEmail(options: DeliverableEmailOptions = {}) {
  const client = options.client;
  if (client === undefined) {
    throw new BounceShiftError(
      'deliverableEmail requires a `client` (a configured BounceShift instance).'
    );
  }

  const field = options.field ?? 'email';
  const status = options.status ?? 422;
  const message = options.message ?? 'The provided email is not deliverable.';

  return async function deliverableEmailMiddleware(
    req: RequestLike,
    res: ResponseLike,
    next: NextLike
  ): Promise<void> {
    const email = readEmail(req, field);

    // No email present — not this middleware's job to require one.
    if (email === undefined) {
      next();
      return;
    }

    let result: ValidationResult;
    try {
      result = await client.validate(email);
    } catch (error) {
      if (error instanceof BounceShiftError) {
        // Fail open: never block a signup on an API failure.
        next();
        return;
      }
      next(error);
      return;
    }

    if (isDeliverable(result, options)) {
      next();
      return;
    }

    if (options.onInvalid) {
      await options.onInvalid(result, req, res, next);
      return;
    }

    res.status(status).json({
      error: 'undeliverable_email',
      message,
      status: result.status,
      confidence: result.confidence,
    });
  };
}

function readEmail(req: RequestLike, field: string): string | undefined {
  const fromBody = req.body?.[field];
  if (typeof fromBody === 'string' && fromBody.length > 0) {
    return fromBody;
  }
  const fromQuery = req.query?.[field];
  if (typeof fromQuery === 'string' && fromQuery.length > 0) {
    return fromQuery;
  }
  return undefined;
}

function isDeliverable(
  result: ValidationResult,
  options: DeliverableEmailOptions
): boolean {
  if (ALWAYS_BLOCKED.has(result.status)) {
    return false;
  }

  if (options.strict && STRICT_BLOCKED.has(result.status)) {
    return false;
  }

  if (
    options.minConfidence !== undefined &&
    result.confidence < options.minConfidence
  ) {
    return false;
  }

  return true;
}
