import {
  ApiError,
  AuthenticationError,
  BounceShiftError,
  ForbiddenError,
  InsufficientCreditsError,
  RateLimitError,
} from './errors.js';
import {
  RECOMMENDATIONS,
  VALIDATION_STATUSES,
  type Recommendation,
  type ValidationResult,
  type ValidationStatus,
} from './types.js';

/** The SDK version, sent as part of the User-Agent header. */
export const SDK_VERSION = '1.1.0';

const DEFAULT_BASE_URL = 'https://api.bounceshift.com/v1';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;

/** Maximum backoff, in seconds, honored from a `Retry-After` header. */
const MAX_RETRY_AFTER_SECONDS = 60;

/** Options for constructing a {@link BounceShift} client. */
export interface BounceShiftOptions {
  /** API key sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Organization id sent as `X-Organization-ID`. */
  organizationId: string;
  /** Override the API base URL. Must be HTTPS. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Number of retries for 429 / 5xx responses. Defaults to 2. */
  retries?: number;
  /**
   * Called whenever {@link BounceShift.validateSafe} (and the fail-open
   * middleware) degrades — i.e. gives up on a failure and returns an unverified
   * result. Use it to log or alert (e.g. out of credits, or an outage) without
   * blocking the caller. Anything this hook throws is swallowed.
   */
  onDegraded?: (error: BounceShiftError, email: string) => void;
}

/**
 * The raw 200 response shape from `POST /validate/single`.
 * Keys are snake_case exactly as the API emits them.
 */
interface RawValidationResponse {
  email: string;
  status: string;
  confidence: number;
  // The API returns null for boolean flags whose check did not run
  // (e.g. is_catch_all on a no-MX address), so treat them all as nullable.
  mx_found: boolean | null;
  smtp_valid: boolean | null;
  is_disposable: boolean | null;
  is_catch_all: boolean | null;
  is_role_account: boolean | null;
  from_cache: boolean | null;
  credits_used: number;
  result: unknown;
  // Fields added by a newer API; optional so older/error responses that omit
  // them still parse (additive, backwards-compatible).
  sub_status?: string | null;
  recommendation?: string | null;
  quality_score?: number | null;
  explanation?: string | null;
}

/** A response paired with its already-consumed, parsed body. */
interface FetchedResponse {
  response: Response;
  body: unknown;
}

/** Client for the BounceShift email validation API. */
export class BounceShift {
  readonly #apiKey: string;

  readonly #organizationId: string;

  readonly #baseUrl: string;

  readonly #timeoutMs: number;

  readonly #retries: number;

  readonly #onDegraded: ((error: BounceShiftError, email: string) => void) | undefined;

  constructor(options: BounceShiftOptions) {
    if (!options.apiKey) {
      throw new BounceShiftError('apiKey is required.');
    }
    if (!options.organizationId) {
      throw new BounceShiftError('organizationId is required.');
    }

    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    if (!isHttpsUrl(baseUrl)) {
      throw new BounceShiftError('baseUrl must be an https URL.');
    }

    this.#apiKey = options.apiKey;
    this.#organizationId = options.organizationId;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = options.retries ?? DEFAULT_RETRIES;
    this.#onDegraded = options.onDegraded;
  }

  /**
   * Validate a single email address.
   *
   * @throws {AuthenticationError} on 401.
   * @throws {InsufficientCreditsError} on 402.
   * @throws {ForbiddenError} on 403.
   * @throws {RateLimitError} on 429 after retries are exhausted.
   * @throws {ApiError} on any other non-2xx response.
   * @throws {BounceShiftError} on transport failure, timeout, or a malformed
   *   response (including an unknown status value).
   */
  async validate(email: string): Promise<ValidationResult> {
    const url = `${this.#baseUrl}/validate/single`;
    const payload = JSON.stringify({ email });

    let lastError: BounceShiftError | undefined;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      let fetched: FetchedResponse;
      try {
        fetched = await this.#send(url, payload);
      } catch (error) {
        // Network/timeout failure — retry if attempts remain.
        lastError = toTransportError(error);
        if (attempt < this.#retries) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      const { response, body } = fetched;

      if (response.ok) {
        return parseSuccess(body);
      }

      const shouldRetry =
        (response.status === 429 || response.status >= 500) &&
        attempt < this.#retries;

      if (shouldRetry) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const waitMs =
          retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt);
        await delay(waitMs);
        continue;
      }

      throw toApiError(response, body);
    }

    // Unreachable: the loop always returns or throws, but satisfies the
    // type checker and guards against a misconfigured `retries` value.
    throw lastError ?? new BounceShiftError('Request failed with no response.');
  }

  /**
   * Validate without ever throwing on a failure — fail open.
   *
   * For hot paths (e.g. validate-on-signup) where a validation problem must
   * never block the user. On any SDK failure — out of credits (402), an API
   * outage (5xx), a timeout, or a network error — it returns a degraded
   * {@link ValidationResult} (`status: 'unknown'`, `creditsUsed: 0`, and
   * {@link isDegraded} true) and invokes the `onDegraded` hook, instead of
   * throwing. Use {@link BounceShift.validate} to handle the typed errors
   * yourself. Unexpected non-SDK errors are not swallowed.
   */
  async validateSafe(email: string): Promise<ValidationResult> {
    try {
      return await this.validate(email);
    } catch (error) {
      if (error instanceof BounceShiftError) {
        this.#reportDegraded(error, email);
        return degradedResult(email, error.message);
      }
      throw error;
    }
  }

  /** Invoke the `onDegraded` hook, never letting it break the caller's flow. */
  #reportDegraded(error: BounceShiftError, email: string): void {
    if (this.#onDegraded === undefined) {
      return;
    }
    try {
      this.#onDegraded(error, email);
    } catch {
      // An observability hook must never break the caller's flow.
    }
  }

  /**
   * Perform one request. A single abort timer covers BOTH the fetch and the
   * response-body read, so a server that streams headers quickly and then
   * stalls the body cannot hang the call past `timeoutMs`.
   */
  async #send(url: string, body: string): Promise<FetchedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'X-Organization-ID': this.#organizationId,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': `@bounceshift/sdk/${SDK_VERSION}`,
        },
        body,
        signal: controller.signal,
      });

      // Read under the same signal — an aborted body read rejects here.
      const text = await response.text();

      return { response, body: parseBody(text) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build the degraded result returned by {@link BounceShift.validateSafe} on failure. */
function degradedResult(email: string, reason: string): ValidationResult {
  return {
    email,
    status: 'unknown',
    confidence: 0,
    mxFound: false,
    smtpValid: null,
    isDisposable: false,
    isCatchAll: false,
    isRoleAccount: false,
    fromCache: false,
    creditsUsed: 0,
    result: { degraded: true, reason },
    subStatus: 'validation_unavailable',
    recommendation: null,
    recommendationRaw: null,
    qualityScore: null,
    explanation:
      'Validation was unavailable, so the address was returned without a verdict.',
  };
}

function parseSuccess(body: unknown): ValidationResult {
  if (!isRawValidationResponse(body)) {
    throw new BounceShiftError('Malformed API response: unexpected shape.');
  }

  if (!isKnownStatus(body.status)) {
    throw new BounceShiftError(
      `Malformed API response: unknown status "${body.status}".`
    );
  }

  return {
    email: body.email,
    status: body.status,
    confidence: body.confidence,
    // Coerce nullable flags to false (matching the PHP SDK); keep smtp_valid's
    // null distinct since "inconclusive" is meaningful there.
    mxFound: body.mx_found === true,
    smtpValid: typeof body.smtp_valid === 'boolean' ? body.smtp_valid : null,
    isDisposable: body.is_disposable === true,
    isCatchAll: body.is_catch_all === true,
    isRoleAccount: body.is_role_account === true,
    fromCache: body.from_cache === true,
    creditsUsed: body.credits_used,
    // The API casts an empty sub-status to a PHP array, which serializes to
    // `[]`; normalize that to an object so the declared type holds.
    result: isPlainObject(body.result) ? body.result : {},
    // Additive fields: tolerate absent/null and unknown values — never throw.
    subStatus: typeof body.sub_status === 'string' ? body.sub_status : null,
    recommendation: toKnownRecommendation(body.recommendation),
    recommendationRaw:
      typeof body.recommendation === 'string' ? body.recommendation : null,
    qualityScore:
      typeof body.quality_score === 'number' ? body.quality_score : null,
    explanation: typeof body.explanation === 'string' ? body.explanation : null,
  };
}

/**
 * Normalize an incoming recommendation to a known {@link Recommendation}.
 * Returns null for a missing, null, or unrecognized value so an unexpected
 * server string never throws (the raw value is preserved separately).
 */
function toKnownRecommendation(value: unknown): Recommendation | null {
  return typeof value === 'string' &&
    (RECOMMENDATIONS as readonly string[]).includes(value)
    ? (value as Recommendation)
    : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isKnownStatus(value: string): value is ValidationStatus {
  return (VALIDATION_STATUSES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for the API's boolean flags, which may be null when a check did not run. */
function isBoolish(value: unknown): boolean {
  return typeof value === 'boolean' || value === null || value === undefined;
}

function isRawValidationResponse(
  value: unknown
): value is RawValidationResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.email === 'string' &&
    typeof v.status === 'string' &&
    typeof v.confidence === 'number' &&
    isBoolish(v.mx_found) &&
    isBoolish(v.smtp_valid) &&
    isBoolish(v.is_disposable) &&
    isBoolish(v.is_catch_all) &&
    isBoolish(v.is_role_account) &&
    isBoolish(v.from_cache) &&
    typeof v.credits_used === 'number' &&
    typeof v.result === 'object' &&
    v.result !== null
  );
}

/** Parse a response body string into JSON, falling back to the raw text. */
function parseBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return fallback;
}

function toApiError(response: Response, body: unknown): BounceShiftError {
  const { status } = response;

  switch (status) {
    case 401:
      return new AuthenticationError(
        extractMessage(body, 'Authentication failed.'),
        body
      );
    case 402:
      return new InsufficientCreditsError(
        extractMessage(body, 'Insufficient credits.'),
        body
      );
    case 403:
      return new ForbiddenError(extractMessage(body, 'Forbidden.'), body);
    case 429:
      return new RateLimitError(
        extractMessage(body, 'Rate limit exceeded.'),
        body,
        parseRetryAfter(response.headers.get('retry-after'))
      );
    default:
      return new ApiError(
        extractMessage(body, `API request failed with status ${status}.`),
        status,
        body
      );
  }
}

function toTransportError(error: unknown): BounceShiftError {
  if (error instanceof BounceShiftError) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new BounceShiftError('Request timed out.');
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new BounceShiftError(`Request failed: ${detail}`);
}

/**
 * Parse a numeric `Retry-After` header (seconds) and clamp it to
 * {@link MAX_RETRY_AFTER_SECONDS}. Returns undefined for missing or
 * non-numeric (HTTP-date) values.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** Exponential backoff in milliseconds for a given zero-based attempt. */
function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 250, MAX_RETRY_AFTER_SECONDS * 1000);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
