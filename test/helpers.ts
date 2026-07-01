import { vi } from 'vitest';

/** A raw 200 body from the API, with sensible defaults for overriding. */
export function rawSuccessBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    email: 'user@example.com',
    status: 'valid',
    confidence: 95,
    mx_found: true,
    smtp_valid: true,
    is_disposable: false,
    is_catch_all: false,
    is_role_account: false,
    from_cache: false,
    credits_used: 1,
    result: { sub_status: 'mailbox_found' },
    ...overrides,
  };
}

/** Build a `Response`-like object suitable for a mocked `fetch`. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/**
 * Install a mocked global `fetch` that returns the given responses in order.
 * Returns the mock so tests can assert on call arguments.
 */
export function mockFetchSequence(
  responses: Array<Response | (() => Response | Promise<Response>)>
) {
  const mock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
    const next = responses.shift();
    if (next === undefined) {
      throw new Error('mockFetchSequence: no more responses queued');
    }
    return typeof next === 'function' ? next() : next;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
