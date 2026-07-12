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
import { BounceShift, isSafeToSend, isSendable } from '@bounceshift/sdk';

const client = new BounceShift({
  apiKey: process.env.BOUNCESHIFT_API_KEY!,
  organizationId: process.env.BOUNCESHIFT_ORG_ID!,
  // baseUrl defaults to https://api.bounceshift.com/v1 (must be HTTPS)
  // timeoutMs defaults to 10000, retries defaults to 2
});

const result = await client.validate('user@example.com');

console.log(result.status);         // 'valid' | 'catch_all' | 'invalid' | ...
console.log(result.confidence);     // 0–100
console.log(result.smtpValid);      // boolean | null
console.log(result.recommendation); // 'deliverable' | 'send_with_caution' | ...
console.log(result.qualityScore);   // 0–100 | null
console.log(result.explanation);    // plain-English verdict | null
console.log(isSafeToSend(result));  // true when status is 'valid' or 'catch_all'
console.log(isSendable(result));    // true when recommendation says to send
```

`validate()` returns a `ValidationResult` with camelCase fields mapped from the
API's snake_case payload:

| Field               | Type                        |
| ------------------- | --------------------------- |
| `email`             | `string`                    |
| `status`            | `ValidationStatus`          |
| `confidence`        | `number` (0–100)            |
| `mxFound`           | `boolean`                   |
| `smtpValid`         | `boolean \| null`           |
| `isDisposable`      | `boolean`                   |
| `isCatchAll`        | `boolean`                   |
| `isRoleAccount`     | `boolean`                   |
| `fromCache`         | `boolean`                   |
| `creditsUsed`       | `number`                    |
| `result`            | `Record<string, unknown>`   |
| `subStatus`         | `string \| null`            |
| `recommendation`    | `Recommendation \| null`    |
| `recommendationRaw` | `string \| null`            |
| `qualityScore`      | `number \| null` (0–100)    |
| `explanation`       | `string \| null`            |

`ValidationStatus` is one of:
`valid`, `invalid`, `risky`, `catch_all`, `unknown`, `disposable`, `spamtrap`,
`abuse`, `do_not_mail`.

### Recommendation

`recommendation` is the API's action-oriented deliverability verdict, surfaced
as-is (the SDK does not re-derive it from `status`). It is one of:
`deliverable`, `send_with_caution`, `risky`, `undeliverable`, `unknown`.

`isSendable(result)` (or `isSendable(recommendation)`) returns `true` only for
`deliverable` and `send_with_caution`.

The SDK tolerates the unexpected: if the API omits `recommendation` or sends a
value this SDK version doesn't know, `recommendation` is `null` (the exact
string is still available on `recommendationRaw`) and `isSendable()` returns
`false` — it never throws. `subStatus`, `qualityScore`, and `explanation` are
`null` when the API omits them (e.g. some error paths).

- `subStatus` — granular reason for the verdict (e.g. `smtp_verified`).
- `qualityScore` — a 0–100 score modeled separately from `confidence`; it
  currently tracks `confidence` but may diverge.
- `explanation` — a plain-English sentence describing the verdict.

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

## Fail open — never block your users

On a hot path such as validate-on-signup, a validation problem should never
block the user. `validate()` throws; `validateSafe()` **never** does. If your
account runs out of credits, or the API is down or timing out, it returns a
degraded result instead of throwing, so you can let the address through:

```ts
import { BounceShift, isDegraded, isSafeToSend } from '@bounceshift/sdk';

const client = new BounceShift({
  apiKey: process.env.BOUNCESHIFT_API_KEY!,
  organizationId: process.env.BOUNCESHIFT_ORG_ID!,
  // Optional: observe every fail-open (out of credits, outage, timeout).
  onDegraded: (error, email) => logger.warn('bounceshift degraded', { email, error }),
});

const result = await client.validateSafe('user@example.com');

if (isDegraded(result)) {
  // We couldn't reach a verdict — let it through, and your onDegraded hook fired.
} else if (!isSafeToSend(result)) {
  // A real verdict came back and it's not safe — reject as usual.
}
```

A degraded result has `status: 'unknown'`, `creditsUsed: 0`, and
`isDegraded(result) === true`, so you can always tell "we couldn't check" apart
from a genuine `unknown` verdict. `timeoutMs` bounds how long a stalled API can
hold your request before `validateSafe()` gives up. Works on any stack —
Next.js route handlers, Fastify, serverless, workers — not just Express.

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

If the API is unreachable, times out, is rate limited, out of credits, or
misconfigured, the middleware **calls `next()`** and lets the request through —
even in `strict` mode — so an outage never blocks your signups. It fails open
via the client's `validateSafe()`, so pass an `onDegraded` hook to the client
(see [Fail open](#fail-open--never-block-your-users)) to log/alert when it does.
(Unexpected non-SDK errors are forwarded to `next(error)`.)

### ⚠️ `strict` / `minConfidence` can reject real users

Many legitimate mailboxes on throttled SMTP infrastructure — notably
**Outlook/Hotmail** and **Gmail** — routinely return a low-confidence
`unknown` verdict because the provider greylists or rate-limits verification
probes. Enabling `strict` or a high `minConfidence` will reject those real
users. Prefer the lenient default unless you have a strong reason to trade
signup conversion for stricter filtering.

## License

MIT © BounceShift
