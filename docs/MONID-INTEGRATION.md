# Monid — how the paid tool marketplace is wired, and what stops it spending

Monid ("OpenRouter for agent tools") is now integrated, but **it is not a chat
model and it is not free**. This document records the exact boundary, because a
mistake here spends the owner's balance.

## What Monid actually is (verified, not assumed)

Checked against `monid-ai/monid` (MIT, 5,683★, last push 2026-11-17) and
`@monid-ai/cli@0.1.9` on 2026-11-27:

| Verb | Endpoint | Cost |
| --- | --- | --- |
| discover | `POST /v1/discover` | **free** |
| inspect | `POST /v1/inspect` | **free** |
| balance | `GET /v1/wallet/balance` | **free** |
| run | `POST /v1/run` | **billed per call** (settled on the vendor's response envelope) |

Auth is `Authorization: Bearer <key>`; the base URL is `https://api.monid.ai`.
It returns **data for a tool call**, so it was deliberately *not* put in the
model chain (`DEFAULT_ORDER`) — a provider that cannot answer a prompt must
never be a fallback.

## The four gates on a billed call

`runMonidEndpoint()` in `src/lib/monid.ts` refuses unless **all** of these hold:

1. `ALO_MONID_ENABLED=true` — the integration's own switch (default **off**).
2. `isExternalAiAllowed()` — both existing owner switches
   (`ALO_PAID_AI_API_ALLOWED` + `ALO_OWNER_APPROVED_PAID_AI_API`).
3. `MONID_API_KEY` is configured (there is a wallet to spend).
4. An `approvalId` for **this exact** provider+endpoint is supplied — the
   `monid_run` tool is marked `requiresApproval`, so the agent loop suspends and
   the owner decides in the Actions panel.

There is no "skip approval" parameter anywhere, and
`POST /api/super-admin/monid` deliberately has **no `action: "run"`** — asking
for one returns `409 approval_required`. A code path that can spend money
unattended does not exist in this repository.

## What was added

| Piece | Where |
| --- | --- |
| Client + gates | `src/lib/monid.ts` |
| Catalogue facts (5 verified providers, 33 endpoints, exa pricing) | `src/lib/monid-catalog.ts` |
| Estimated price before approving | `estimateCallCost()` — null when unreadable, never a guess |
| Tools | `monid_discover` (free), `monid_inspect` (free), `monid_run` (sensitive) |
| Owner API | `GET/POST /api/super-admin/monid` — `discover`, `inspect`, `balance`, `propose` |
| Chat | "what can monid tools do" → `monid_status`, answered from local facts with **no network call** |
| Config | `ALO_MONID_ENABLED`, `MONID_API_KEY` (encrypted), `MONID_BASE_URL` |

PII is scrubbed from a discover query before it leaves the box (tested with a
Bangladeshi phone number), and `MONID_BASE_URL` must be `https` — plain `http` is
accepted only for loopback, so a typo cannot leak the key in clear text.

## What the owner does

1. Create a key at `app.monid.ai/access/api-keys`.
2. Dashboard → Config → set `MONID_API_KEY` (encrypted at rest) and
   `ALO_MONID_ENABLED=true`.
3. Leave the two AI switches **off** while only browsing: discover/inspect work
   without them.
4. To allow a paid run, turn both AI switches on **and** approve the specific
   proposal in the Actions panel.

## What the tests prove (12 + 7, all against a real local server)

- the request bodies are the ones the official CLI sends (`{query,limit,minScore}`,
  `{provider,endpoint}`, `{provider,endpoint,input}`);
- a billed run is refused in **each** of: integration off, guard closed, only one
  AI switch, no approval id — and in all four cases the network call count is
  zero;
- a wrong key surfaces `http_error 401`, an unreachable host `network_error` —
  never a fake success;
- the status payload cannot contain the key;
- `limit` is clamped to 50, a 2-character query is refused before any request;
- the exa estimate follows the declared `$0.007 + $0.001/extra result` model, and
  an unknown endpoint returns `null` plus "run inspect" rather than a number.
