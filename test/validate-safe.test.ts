import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BounceShift,
  InsufficientCreditsError,
  isDegraded,
  isSafeToSend,
} from '../src/index.js';
import { jsonResponse, mockFetchSequence, rawSuccessBody } from './helpers.js';

function makeClient(overrides = {}) {
  return new BounceShift({
    apiKey: 'secret-key',
    organizationId: 'org_123',
    // No retries keeps the fail-open tests free of backoff timers.
    retries: 0,
    timeoutMs: 1000,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BounceShift.validateSafe — fail open', () => {
  it('returns the real verdict when the API responds', async () => {
    mockFetchSequence([jsonResponse(200, rawSuccessBody({ status: 'valid' }))]);

    const result = await makeClient().validateSafe('user@example.com');

    expect(result.status).toBe('valid');
    expect(isDegraded(result)).toBe(false);
    expect(isSafeToSend(result)).toBe(true);
  });

  it('returns a degraded result when the team is out of credits (402)', async () => {
    mockFetchSequence([
      jsonResponse(402, {
        error: 'Insufficient credits',
        message: 'Insufficient credits. Required: 1, Available: 0',
      }),
    ]);

    const result = await makeClient().validateSafe('user@example.com');

    expect(result.status).toBe('unknown');
    expect(isDegraded(result)).toBe(true);
    expect(result.subStatus).toBe('validation_unavailable');
    expect(result.creditsUsed).toBe(0);
    expect(result.email).toBe('user@example.com');
  });

  it('returns a degraded result when the API is down (5xx)', async () => {
    mockFetchSequence([jsonResponse(500, { error: 'Server Error' })]);

    const result = await makeClient().validateSafe('user@example.com');

    expect(isDegraded(result)).toBe(true);
    expect(result.status).toBe('unknown');
  });

  it('returns a degraded result on a transport failure (timeout / network)', async () => {
    mockFetchSequence([
      () => {
        throw new Error('network down');
      },
    ]);

    const result = await makeClient().validateSafe('user@example.com');

    expect(isDegraded(result)).toBe(true);
  });

  it('returns a degraded result on a malformed response body', async () => {
    mockFetchSequence([jsonResponse(200, 'not-json')]);

    const result = await makeClient().validateSafe('user@example.com');

    expect(isDegraded(result)).toBe(true);
  });

  it('invokes onDegraded with the error and email when it degrades', async () => {
    const onDegraded = vi.fn();
    mockFetchSequence([jsonResponse(402, { error: 'Insufficient credits' })]);

    await makeClient({ onDegraded }).validateSafe('user@example.com');

    expect(onDegraded).toHaveBeenCalledOnce();
    const call = onDegraded.mock.calls[0];
    expect(call?.[0]).toBeInstanceOf(InsufficientCreditsError);
    expect(call?.[1]).toBe('user@example.com');
  });

  it('never lets a throwing onDegraded hook break the caller', async () => {
    const onDegraded = vi.fn(() => {
      throw new Error('logger blew up');
    });
    mockFetchSequence([jsonResponse(500, { error: 'Server Error' })]);

    const result = await makeClient({ onDegraded }).validateSafe('user@example.com');

    expect(isDegraded(result)).toBe(true);
    expect(onDegraded).toHaveBeenCalledOnce();
  });

  it('leaves validate() throwing so the typed-error contract is unchanged', async () => {
    mockFetchSequence([jsonResponse(402, { error: 'Insufficient credits' })]);

    await expect(makeClient().validate('user@example.com')).rejects.toBeInstanceOf(
      InsufficientCreditsError
    );
  });
});
