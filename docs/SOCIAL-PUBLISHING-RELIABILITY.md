# Social publishing reliability

The cron publisher at `/api/cron/social-publish` and the manual `/api/v1/social/publish` route use a conditional MySQL update to claim content before contacting Postiz. Claims have a random token and a 60-second lease. Final writes require the same token and an unexpired lease, so another worker cannot finalize an attempt after replacing its lease.

The application records attempt count and a stable local attempt key in the existing `Content.engagement` JSON. The key is for correlation only: the repository's Postiz adapter uses `POST /api/posts`, but this checkout does not establish that Postiz honors an idempotency header or supports reliable lookup by caller-supplied key. The application does not send an assumed idempotency header.

Responses with a valid provider post ID can be recorded as published. An explicit 4xx rejection remains retryable up to the configured limit. A timeout, connection loss, redirect, 5xx response, malformed success body, missing provider ID, or expired lease after request start is persisted as `publishingState: "unknown"` and is not automatically sent again. This is deliberately at-most-one automatic attempt after an ambiguous outcome, not exactly-once delivery. Operators must reconcile such rows against the provider before any manual retry; the adapter currently has no verified per-attempt lookup endpoint.

An expired claim that never reached the request-start state can be reclaimed. An expired request-started claim is converted to unknown. No external social accounts or live provider behavior are exercised by the CI tests.
