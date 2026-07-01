/**
 * Base error for all BounceShift SDK failures.
 *
 * The Express middleware fails open on any {@link BounceShiftError}, so any
 * error the SDK can throw during a request should extend this class.
 */
export class BounceShiftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BounceShiftError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A non-2xx API response that does not map to a more specific error class.
 * Carries the HTTP status code and the parsed (or raw) response body.
 */
export class ApiError extends BounceShiftError {
  readonly statusCode: number;

  readonly body: unknown;

  constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — the API key / organization pair was rejected. */
export class AuthenticationError extends ApiError {
  constructor(message: string, body: unknown) {
    super(message, 401, body);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 403 — authenticated, but not allowed to perform this action. */
export class ForbiddenError extends ApiError {
  constructor(message: string, body: unknown) {
    super(message, 403, body);
    this.name = 'ForbiddenError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 402 — the organization has run out of credits. */
export class InsufficientCreditsError extends ApiError {
  constructor(message: string, body: unknown) {
    super(message, 402, body);
    this.name = 'InsufficientCreditsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 429 — rate limited. {@link retryAfter} is the parsed numeric `Retry-After`
 * header value in seconds, when present.
 */
export class RateLimitError extends ApiError {
  readonly retryAfter: number | undefined;

  constructor(message: string, body: unknown, retryAfter?: number) {
    super(message, 429, body);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
