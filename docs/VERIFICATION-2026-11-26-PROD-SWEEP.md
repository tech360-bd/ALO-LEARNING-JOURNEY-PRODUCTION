# Production verification sweep — 2026-11-26

Scope: audit the whole codebase for stubbed handlers and fake success paths,
fix what was found, and verify the real pipeline end to end. Nothing in this
document is a claim about the production VPS — see "What is still unverified".

## Verification results (this environment)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | 0 errors |
| Lint | `npm run lint` | 0 errors |
| Tests | `npm test` | **292/292 pass** (repeated runs) |
| Build | `npm run build` | compiled, standalone output + `.next/static` + `public` copied |
| Boot | `node .next/standalone/server.js` | boots, `/login` 200, `/` 307 → `/login` |
| Health | `GET /api/health` | **200** (`degraded`: SMTP unset, admin auth unset in this sandbox) |
| Admin sign-in | next-auth credentials through the standalone build | session issued (`role: admin`) |
| Bangla TTS | `POST /api/voice/generate` `{language:"bn"}` | 200, real 3.11 s / 22050 Hz mono WAV (137 244 bytes), `engine: builtin-formant` |
| Photo → video | `POST /api/video/from-photo` (multipart, `narration`) | 200, real MP4: 1080×1920 H.264 + AAC, `captionsBurned: true`, sidecar `.srt` with the Bengali line |
| ASR | `POST /api/asr-transcribe` | **503** `asr_engine_unavailable` + provider matrix (no whisper daemon here) |

`ffmpeg`/`ffprobe` resolve to `node_modules/@ffmpeg-installer` and
`@ffprobe-installer`; `espeak` is absent and the built-in formant synthesizer
covers it, which is why the TTS probe still produced audible, decodable audio.

## Bugs found and fixed

### 1. `ADMIN_PASSWORD_HASH` was destroyed by `.env` interpolation
Symptom: the login page showed **"Administrator sign-in is not configured"**
even when the hash was visibly present in `.next/standalone/.env`, and sign-in
returned 401.

Cause: the hash is `scrypt$<salt>$<hash>`, and every env loader this app uses
(`@next/env`, `next start`, `--env-file`, Docker `--env-file`) substitutes
`$VAR`. `$YwZ…` was treated as a variable reference and deleted, leaving an
80-character value that fails validation:

```
file:  ADMIN_PASSWORD_HASH=scrypt$YwZ-v2IOaiUqBLugnR5qbg$T5_KTWnDgo4V…
env:   scrypt-v2IOaiUqBLugnR5qbg-ZkJrRwkLhUS1Jf…            (invalid)
```

Fix, in three parts:
- `src/lib/auth-config.ts` — `parseAdminPasswordHash()` accepts a literal hash
  or the escaped form (`scrypt\$…\$…`, which is what `.env` needs) and rejects
  everything else; `adminPasswordHashStatus()` distinguishes `missing` from
  `interpolated` so the operator sees the real cause. `src/lib/admin-password.ts`
  uses the same parser, so a value accepted as "configured" also verifies.
- `scripts/hash-admin-password.mjs` now prints the `.env`-safe escaped line
  **and** the direct value for PM2 / `docker -e` / CI secrets.
- `GET /api/auth/otp/config` returns `passwordHash: "ok" | "missing" |
  "interpolated"` and the login page explains exactly what happened instead of a
  generic banner.

`ADMIN_OTP_REQUIRED=false` now also behaves as documented: the OTP field is
hidden, the button is not blocked, and no SMS provider is required — the banner
previously still demanded `ADMIN_OTP_PHONE`, `HTTPSMS_API_KEY`, `HTTPSMS_FROM`.

### 2. `/api/health` returned 503 in every non-production environment
The `MySQL configuration` check was critical even outside production, where
`src/lib/db.ts` explicitly supports a development-only JSON fallback. Every
local and preview environment therefore reported an unhealthy app while the
database check itself passed. The policy now lives in
`src/lib/health-policy.mjs` (production still requires MySQL, nothing else
does), and the probe returns **200** with the reasons in `?details=1`.

### 3. Simulated SMS was stored and counted as `sent`
`/api/sms/send`, `/api/sms/otp` and `/api/sms/broadcast` rewrote
`status === "simulation"` to `"sent"`, so an undelivered message (no gateway
configured) looked delivered in the CRM timeline and in the audit event title.
Broadcast also incremented `sent` for simulated recipients. All three now store
and count the real outcome, expose `undelivered`, and `otpSent` is only true
when a provider accepted the message.

### 4. ASR studio returned a provider parse error to the browser
`/api/asr-transcribe` called the Z.AI SDK directly and returned
`500 {"error":"No number after minus sign in JSON at position 1"}` when no
daemon or key was configured — bypassing the local-first chain in
`src/lib/asr-engine.ts`. It now uses `transcribe()` (faster-whisper → WhisperX →
whisper.cpp → approved cloud fallback), fails with
`503 asr_engine_unavailable` plus the provider matrix, records the row as
`failed` instead of storing an empty "completed" transcription, and never echoes
raw provider or JSON-parse text.

### 5. Avatar routes answered 201 with nothing in them
`POST /api/ai/avatar` swallowed every image-provider failure and still created
an avatar row with `faceImageUrl: null` and a random `voiceId`.
`POST /api/ai/avatar-video` labelled every failure `rate_limited` and returned a
content id for an empty draft. Both now return `503` with the real reason
(`avatar_portrait_unavailable`, `avatar_render_unavailable`) and keep provider
messages out of the response.

### 6. `/api/approvals` relied on the request gateway only
Approving an item is what turns a proposal into an executed mutation (publishing
job + audit entry + notification), yet the route had no session check of its own
and trusted `src/proxy.ts`. `GET` and `POST` now call `requireOwner()` and fail
closed with `401`/`503`, and the test asserts the MarketingOS bearer allowlist
never includes this path.

### 7. Test-runner compatibility
`src/lib/admin-otp.ts` used a constructor parameter property, which
`--experimental-strip-types` cannot erase, so any test that reached `auth.ts`
crashed on import. Converted to an explicit field.

## Regression coverage added

| Test file | Guards |
| --- | --- |
| `tests/admin-hash-env-interpolation.test.mjs` | real `@next/env` load of a bare vs escaped hash; parser accepts literal + escaped, rejects interpolated; `verifyAdminCredentials` round-trip; `ADMIN_OTP_REQUIRED=false` needs no SMS provider |
| `tests/health-policy.test.mjs` | production requires MySQL, development fallback is not a failure, details never leak credentials |
| `tests/sms-delivery-truthfulness.test.mjs` | no route maps simulation → sent; only a provider-accepted message counts as sent |
| `tests/asr-local-first.test.mjs` | ASR goes through the engine chain, 503 on no engine, raw errors never returned, local daemons stay ahead of cloud |
| `tests/avatar-fake-success.test.mjs` | avatar routes refuse to report success with no media; no 501/TODO/FIXME in `src`; approvals gated by the owner session |

## Deliberately not "fixed"

These are truthful refusals, not stubs, and stay as they are:

- `src/app/api/family-projects` → `family_media_pipeline_not_implemented` (409):
  no identity-aware family-media worker exists; the route refuses to mark stages
  complete.
- `src/app/api/publishing` → `external_setup_required`: a stored `connected` flag
  is not an OAuth token, so delivery is blocked and no post is sent.
- `src/app/api/cron/social-publish` → `simulated: true` with a message when
  Postiz is not configured.
- AI chat/image/video provider calls stay behind `assertExternalAiAllowed()` and
  the `ALO_PAID_AI_API_ALLOWED` + `ALO_OWNER_APPROVED_PAID_AI_API` switches.

## What is still unverified (honest limits)

- **No MySQL and no root in this sandbox.** `prisma generate` could not fetch the
  query engine (egress is limited to GitHub/npm/PyPI), so Prisma cannot connect
  here. `/api/health` therefore exercises the development fallback, and the
  MySQL path — including `/api/health` returning **200 against a real database** —
  must be confirmed on the VPS.
- **No whisper daemon** here, so ASR is verified only up to its (correct) 503.
- **No Ollama** here: `/api/ai/local-status` correctly reports
  `mode: local-only`, `serviceAvailable: false`, `paidApiCalls: false`.
- The VPS deploy chain (Tailscale join → SSH → PM2 reload) is still blocked on
  the reusable auth key described in `docs/DEPLOY-STATUS-2026-11-26.md`.
