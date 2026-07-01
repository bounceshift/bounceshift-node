# @bounceshift/sdk

Official [BounceShift](https://bounceshift.com) TypeScript SDK — real-time email
validation and deliverability, with a drop-in Express middleware for gating
signups.

- Zero runtime dependencies (uses the global `fetch`, Node ≥ 18).
- Dual ESM + CommonJS build with full TypeScript types.
- Typed error classes, automatic retries with `Retry-After` support.

API reference: <https://bounceshift.com/docs/api>

## Install

```bash
npm install @bounceshift/sdk
```

## Quickstart

```ts
import { BounceShift, isSafeToSend } from '@bounceshift/sdk';

const client = new BounceShift({
  apiKey: process.env.BOUNCESHIFT_API_KEY!,
  organizationId: process.env.BOUNCESHIFT_ORG_ID!,
  // baseUrl defaults to https://api.bounceshift.com/v1 (must be HTTPS)
  // timeoutMs defaults to 10000, retries defaults to 2
});

const result = await client.validate('user@example.com');

console.log(result.status);       // 'valid' | 'catch_all' | 'invalid' | ...
console.log(result.confidence);   // 0–100
console.log(result.smtpValid);    // boolean | null
console.log(isSafeToSend(result)); // true when status is 'valid' or 'catch_all'
```

`validate()` returns a `ValidationResult` with camelCase fields mapped from the
API's snake_case payload:

| Field           | Type                      |
| --------------- | ------------------------- |
| `email`         | `string`                  |
| `status`        | `ValidationStatus`        |
| `confidence`    | `number` (0–100)          |
| `mxFound`       | `boolean`                 |
| `smtpValid`     | `boolean \| null`         |
| `isDisposable`  | `boolean`                 |
| `isCatchAll`    | `boolean`                 |
| `isRoleAccount` | `boolean`                 |
| `fromCache`     | `boolean`                 |
| `creditsUsed`   | `number`                  |
| `result`        | `Record<string, unknown>` |

`ValidationStatus` is one of:
`valid`, `invalid`, `risky`, `catch_all`, `unknown`, `disposable`, `spamtrap`,
`abuse`, `do_not_mail`.

## Error handling

Every failure throws a subclass of `BounceShiftError`:

```ts
import {
  BounceShift,
  AuthenticationError,
  InsufficientCreditsError,
  ForbiddenError,
  RateLimitError,
  ApiError,
  BounceShiftError,
} from '@bounceshift/sdk';

try {
  await client.validate('user@example.com');
} catch (error) {
  if (error instanceof InsufficientCreditsError) {
    // 402 — top up credits
  } else if (error instanceof RateLimitError) {
    // 429 — error.retryAfter is the (clamped) seconds to wait
  } else if (error instanceof AuthenticationError) {
    // 401
  } else if (error instanceof ForbiddenError) {
    // 403
  } else if (error instanceof ApiError) {
    // any other non-2xx — error.statusCode, error.body
  } else if (error instanceof BounceShiftError) {
    // transport failure, timeout, or a malformed response
  }
}
```

`429` and `5xx` responses are retried automatically (up to `retries`), honoring
a numeric `Retry-After` header clamped to 60 seconds. Your API key is never
logged or included in error output.

## Express middleware

`deliverableEmail` validates an email on the request body and rejects
undeliverable ones before your handler runs.

```ts
import express from 'express';
import { BounceShift, deliverableEmail } from '@bounceshift/sdk';

const client = new BounceShift({
  apiKey: process.env.BOUNCESHIFT_API_KEY!,
  organizationId: process.env.BOUNCESHIFT_ORG_ID!,
});

const app = express();
app.use(express.json());

app.post('/signup', deliverableEmail({ client }), (req, res) => {
  // Only reached for deliverable emails.
  res.json({ ok: true });
});
```

### Policy

By default the middleware mirrors BounceShift's Laravel `Deliverable` rule and
blocks **only** clearly bad addresses:

- Blocked: `invalid`, `disposable`, `do_not_mail`, `abuse`, `spamtrap`
- Allowed: `valid`, `catch_all`, `unknown`, `risky`

Options:

| Option          | Default   | Effect                                                        |
| --------------- | --------- | ------------------------------------------------------------- |
| `client`        | —         | **Required.** A configured `BounceShift` instance.            |
| `field`         | `'email'` | Body/query field to read the email from.                      |
| `strict`        | `false`   | Also block `risky` and `unknown`.                             |
| `minConfidence` | —         | Also block results with `confidence` below this threshold.    |
| `status`        | `422`     | HTTP status returned on block.                                |
| `message`       | —         | Error message returned on block.                              |
| `onInvalid`     | —         | `(result, req, res, next)` handler run on block instead of the default JSON response. |

### Fail-open by design

If the API is unreachable, times out, is rate limited, or misconfigured, the
middleware **calls `next()`** and lets the request through — an outage will
never block your signups. (Unexpected non-SDK errors are forwarded to
`next(error)`.)

### ⚠️ `strict` / `minConfidence` can reject real users

Many legitimate mailboxes on throttled SMTP infrastructure — notably
**Outlook/Hotmail** and **Gmail** — routinely return a low-confidence
`unknown` verdict because the provider greylists or rate-limits verification
probes. Enabling `strict` or a high `minConfidence` will reject those real
users. Prefer the lenient default unless you have a strong reason to trade
signup conversion for stricter filtering.

## License

MIT © BounceShift
