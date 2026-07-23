import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BounceShift,
  BounceShiftError,
  deliverableEmail,
  type ValidationResult,
  type ValidationStatus,
} from '../src/index.js';

function makeResult(
  status: ValidationStatus,
  confidence = 90
): ValidationResult {
  return {
    email: 'user@example.com',
    status,
    confidence,
    mxFound: true,
    smtpValid: null,
    isDisposable: status === 'disposable',
    isCatchAll: status === 'catch_all',
    isRoleAccount: false,
    fromCache: false,
    creditsUsed: 1,
    result: {},
    subStatus: null,
    recommendation: null,
    recommendationRaw: null,
    qualityScore: null,
    explanation: null,
    didYouMean: null,
  };
}

/** A stub client whose `validate` is a controllable vitest mock. */
function stubClient(
  impl: (email: string) => Promise<ValidationResult>
): BounceShift {
  const client = new BounceShift({ apiKey: 'k', organizationId: 'o' });
  vi.spyOn(client, 'validate').mockImplementation(impl);
  return client;
}

function fakeReqRes(email?: string) {
  const req = { body: email === undefined ? {} : { email } };
  const res = {
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deliverableEmail — default (lenient) policy', () => {
  it('calls next() for unknown (lenient pass)', async () => {
    const client = stubClient(async () => makeResult('unknown', 10));
    const mw = deliverableEmail({ client });
    const { req, res, next } = fakeReqRes('user@example.com');

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeUndefined();
  });

  it('calls next() for risky and valid and catch_all', async () => {
    for (const status of ['risky', 'valid', 'catch_all'] as const) {
      const client = stubClient(async () => makeResult(status));
      const mw = deliverableEmail({ client });
      const { req, res, next } = fakeReqRes('user@example.com');
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(res.statusCode).toBeUndefined();
    }
  });

  it('blocks invalid with a 422 JSON error', async () => {
    const client = stubClient(async () => makeResult('invalid'));
    const mw = deliverableEmail({ client });
    const { req, res, next } = fakeReqRes('bad@example.com');

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
    expect(res.payload).toMatchObject({
      error: 'undeliverable_email',
      status: 'invalid',
    });
  });

  it('blocks disposable / do_not_mail / abuse / spamtrap', async () => {
    for (const status of [
      'disposable',
      'do_not_mail',
      'abuse',
      'spamtrap',
    ] as const) {
      const client = stubClient(async () => makeResult(status));
      const mw = deliverableEmail({ client });
      const { req, res, next } = fakeReqRes('x@example.com');
      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(422);
    }
  });
});

describe('deliverableEmail — fail open', () => {
  it('calls next() (no block) when the client throws a BounceShiftError', async () => {
    const client = stubClient(async () => {
      throw new BounceShiftError('API down');
    });
    const mw = deliverableEmail({ client });
    const { req, res, next } = fakeReqRes('user@example.com');

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeUndefined();
  });

  it('fails open even in strict mode when the client throws', async () => {
    const client = stubClient(async () => {
      throw new BounceShiftError('API down');
    });
    const mw = deliverableEmail({ client, strict: true });
    const { req, res, next } = fakeReqRes('user@example.com');

    await mw(req, res, next);

    // A degrade must never be blocked, even though strict mode rejects `unknown`.
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeUndefined();
  });

  it('passes non-SDK errors to next(error)', async () => {
    const boom = new TypeError('unexpected');
    const client = stubClient(async () => {
      throw boom;
    });
    const mw = deliverableEmail({ client });
    const { req, res, next } = fakeReqRes('user@example.com');

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  it('skips validation entirely when no email is present', async () => {
    const validate = vi.fn();
    const client = stubClient(validate as never);
    const mw = deliverableEmail({ client });
    const { req, res, next } = fakeReqRes(undefined);

    await mw(req, res, next);

    expect(validate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});

describe('deliverableEmail — strict and minConfidence', () => {
  it('strict blocks risky and unknown', async () => {
    for (const status of ['risky', 'unknown'] as const) {
      const client = stubClient(async () => makeResult(status, 95));
      const mw = deliverableEmail({ client, strict: true });
      const { req, res, next } = fakeReqRes('user@example.com');
      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(422);
    }
  });

  it('strict still passes valid and catch_all', async () => {
    for (const status of ['valid', 'catch_all'] as const) {
      const client = stubClient(async () => makeResult(status, 95));
      const mw = deliverableEmail({ client, strict: true });
      const { req, res, next } = fakeReqRes('user@example.com');
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(res.statusCode).toBeUndefined();
    }
  });

  it('minConfidence blocks below the threshold but passes at/above it', async () => {
    const lowClient = stubClient(async () => makeResult('valid', 40));
    const lowMw = deliverableEmail({ client: lowClient, minConfidence: 60 });
    const low = fakeReqRes('user@example.com');
    await lowMw(low.req, low.res, low.next);
    expect(low.next).not.toHaveBeenCalled();
    expect(low.res.statusCode).toBe(422);

    const highClient = stubClient(async () => makeResult('valid', 60));
    const highMw = deliverableEmail({ client: highClient, minConfidence: 60 });
    const high = fakeReqRes('user@example.com');
    await highMw(high.req, high.res, high.next);
    expect(high.next).toHaveBeenCalledWith();
    expect(high.res.statusCode).toBeUndefined();
  });

  it('invokes onInvalid instead of the default response when provided', async () => {
    const client = stubClient(async () => makeResult('invalid'));
    const onInvalid = vi.fn();
    const mw = deliverableEmail({ client, onInvalid });
    const { req, res, next } = fakeReqRes('bad@example.com');

    await mw(req, res, next);

    expect(onInvalid).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it('reads the email from a custom field', async () => {
    const client = stubClient(async () => makeResult('invalid'));
    const mw = deliverableEmail({ client, field: 'contactEmail' });
    const req = { body: { contactEmail: 'bad@example.com' } };
    const res = fakeReqRes().res;
    const next = vi.fn();

    await mw(req, res, next);

    expect(res.statusCode).toBe(422);
  });
});

describe('deliverableEmail — configuration', () => {
  it('throws when constructed without a client', () => {
    expect(() => deliverableEmail()).toThrow(BounceShiftError);
  });
});
