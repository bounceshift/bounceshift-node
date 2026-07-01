import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  BounceShift,
  BounceShiftError,
  ForbiddenError,
  InsufficientCreditsError,
  RateLimitError,
} from '../src/index.js';
import { jsonResponse, mockFetchSequence, rawSuccessBody } from './helpers.js';

function makeClient(overrides = {}) {
  return new BounceShift({
    apiKey: 'secret-key',
    organizationId: 'org_123',
    retries: 2,
    timeoutMs: 1000,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('BounceShift.validate — success mapping', () => {
  it('maps snake_case API keys to camelCase result fields', async () => {
    mockFetchSequence([
      jsonResponse(
        200,
        rawSuccessBody({
          email: 'jane@acme.io',
          status: 'catch_all',
          confidence: 72,
          mx_found: true,
          is_disposable: false,
          is_catch_all: true,
          is_role_account: true,
          from_cache: true,
          credits_used: 0,
        })
      ),
    ]);

    const result = await makeClient().validate('jane@acme.io');

    expect(result).toEqual({
      email: 'jane@acme.io',
      status: 'catch_all',
      confidence: 72,
      mxFound: true,
      smtpValid: true,
      isDisposable: false,
      isCatchAll: true,
      isRoleAccount: true,
      fromCache: true,
      creditsUsed: 0,
      result: { sub_status: 'mailbox_found' },
    });
  });

  it('coerces null boolean flags to false (real no-MX response shape)', async () => {
    // The API returns is_catch_all/is_role_account/etc. as null when the check
    // did not run (e.g. a no-MX address); the SDK must coerce, not reject.
    mockFetchSequence([
      jsonResponse(
        200,
        rawSuccessBody({
          status: 'invalid',
          confidence: 100,
          mx_found: false,
          smtp_valid: null,
          is_disposable: null,
          is_catch_all: null,
          is_role_account: null,
        })
      ),
    ]);

    const result = await makeClient().validate('user@no-mx.example');

    expect(result.status).toBe('invalid');
    expect(result.mxFound).toBe(false);
    expect(result.smtpValid).toBeNull();
    expect(result.isDisposable).toBe(false);
    expect(result.isCatchAll).toBe(false);
    expect(result.isRoleAccount).toBe(false);
  });

  it('preserves smtp_valid === null', async () => {
    mockFetchSequence([
      jsonResponse(200, rawSuccessBody({ status: 'unknown', smtp_valid: null })),
    ]);

    const result = await makeClient().validate('user@example.com');

    expect(result.smtpValid).toBeNull();
    expect(result.status).toBe('unknown');
  });

  it('sends both required auth headers and never leaks the key in the body', async () => {
    const mock = mockFetchSequence([jsonResponse(200, rawSuccessBody())]);

    await makeClient().validate('user@example.com');

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.bounceshift.com/v1/validate/single');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers['X-Organization-ID']).toBe('org_123');
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toBe('@bounceshift/sdk/1.0.0');
    expect(init.body).toBe(JSON.stringify({ email: 'user@example.com' }));
  });

  it('normalizes an empty-array result to an object', async () => {
    mockFetchSequence([jsonResponse(200, rawSuccessBody({ result: [] }))]);

    const result = await makeClient().validate('user@example.com');

    expect(result.result).toEqual({});
  });
});

describe('BounceShift.validate — error classes', () => {
  it('throws AuthenticationError on 401', async () => {
    mockFetchSequence([jsonResponse(401, { message: 'nope' })]);
    await expect(makeClient().validate('a@b.com')).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });

  it('throws InsufficientCreditsError on 402', async () => {
    mockFetchSequence([
      jsonResponse(402, { error: 'insufficient_credits', message: 'broke' }),
    ]);
    const error = await makeClient()
      .validate('a@b.com')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(402);
    expect((error as ApiError).message).toBe('broke');
  });

  it('throws ForbiddenError on 403', async () => {
    mockFetchSequence([jsonResponse(403, { message: 'denied' })]);
    await expect(makeClient().validate('a@b.com')).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('throws RateLimitError on 429 (no retries) with parsed retryAfter', async () => {
    mockFetchSequence([
      jsonResponse(429, { message: 'slow down' }, { 'Retry-After': '12' }),
    ]);
    const error = await makeClient({ retries: 0 })
      .validate('a@b.com')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(12);
  });

  it('throws a generic ApiError on other non-2xx', async () => {
    mockFetchSequence([jsonResponse(418, { message: "I'm a teapot" })]);
    const error = await makeClient({ retries: 0 })
      .validate('a@b.com')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(418);
    expect((error as ApiError).body).toEqual({ message: "I'm a teapot" });
  });
});

describe('BounceShift.validate — retries', () => {
  it('retries after a 5xx then succeeds', async () => {
    vi.useFakeTimers();
    const mock = mockFetchSequence([
      jsonResponse(503, { message: 'unavailable' }),
      jsonResponse(200, rawSuccessBody({ status: 'valid' })),
    ]);

    const promise = makeClient().validate('user@example.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('valid');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('honors a numeric Retry-After clamped to 60s', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockFetchSequence([
      jsonResponse(429, { message: 'slow' }, { 'Retry-After': '9999' }),
      jsonResponse(200, rawSuccessBody()),
    ]);

    const promise = makeClient().validate('user@example.com');
    await vi.runAllTimersAsync();
    await promise;

    const backoffDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 1000);
    expect(backoffDelays).toContain(60_000);
  });

  it('ignores a non-numeric (HTTP-date) Retry-After and falls back to backoff', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockFetchSequence([
      jsonResponse(
        429,
        { message: 'slow' },
        { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }
      ),
      jsonResponse(200, rawSuccessBody()),
    ]);

    const promise = makeClient().validate('user@example.com');
    await vi.runAllTimersAsync();
    await promise;

    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((ms): ms is number => typeof ms === 'number');
    expect(delays).toContain(250); // exponential backoff, not a NaN-from-date
    expect(delays.some((ms) => Number.isNaN(ms))).toBe(false);
  });

  it('retries a network failure then succeeds', async () => {
    vi.useFakeTimers();
    const mock = mockFetchSequence([
      () => {
        throw new TypeError('fetch failed');
      },
      jsonResponse(200, rawSuccessBody({ status: 'valid' })),
    ]);

    const promise = makeClient().validate('user@example.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('valid');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('throws a BounceShiftError after every network retry fails', async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new TypeError('fetch failed');
      },
    ]);

    const promise = makeClient()
      .validate('user@example.com')
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await promise).toBeInstanceOf(BounceShiftError);
  });
});

describe('BounceShift.validate — timeout', () => {
  it('aborts and maps a stalled request to a timeout BounceShiftError', async () => {
    vi.useFakeTimers();
    const hangingFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    );
    vi.stubGlobal('fetch', hangingFetch);

    const promise = makeClient({ retries: 0, timeoutMs: 1000 })
      .validate('user@example.com')
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await promise;

    expect(error).toBeInstanceOf(BounceShiftError);
    expect((error as Error).message).toBe('Request timed out.');
  });
});

describe('BounceShift.validate — malformed responses', () => {
  it('throws BounceShiftError on an unknown status value', async () => {
    mockFetchSequence([
      jsonResponse(200, rawSuccessBody({ status: 'definitely_not_real' })),
    ]);
    const error = await makeClient()
      .validate('a@b.com')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BounceShiftError);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('throws BounceShiftError on garbage shape', async () => {
    mockFetchSequence([jsonResponse(200, { totally: 'wrong' })]);
    await expect(makeClient().validate('a@b.com')).rejects.toBeInstanceOf(
      BounceShiftError
    );
  });
});

describe('BounceShift construction', () => {
  it('throws on a non-HTTPS baseUrl', () => {
    expect(
      () =>
        new BounceShift({
          apiKey: 'k',
          organizationId: 'o',
          baseUrl: 'http://insecure.example.com/v1',
        })
    ).toThrow(BounceShiftError);
  });

  it('accepts an https baseUrl', () => {
    expect(
      () =>
        new BounceShift({
          apiKey: 'k',
          organizationId: 'o',
          baseUrl: 'https://staging.bounceshift.com/v1',
        })
    ).not.toThrow();
  });

  it('requires apiKey and organizationId', () => {
    expect(
      () => new BounceShift({ apiKey: '', organizationId: 'o' })
    ).toThrow(BounceShiftError);
    expect(
      () => new BounceShift({ apiKey: 'k', organizationId: '' })
    ).toThrow(BounceShiftError);
  });
});
