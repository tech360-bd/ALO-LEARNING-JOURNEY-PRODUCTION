# Super-admin chat, self-verification and "add this GitHub link" — what is real

Written after the owner asked for one chat dashboard that drives every AI/coding
agent, browses the web to check its own output, fixes itself, and can decide
whether a shared GitHub link is safe to adopt. Each row below is checked against
the code in this repository, not against a plan.

## Already implemented (before this change)

| Capability | Where |
| --- | --- |
| Chat dashboard ("Super Admin") with conversations, run timeline, approvals, system monitor | `src/app/super-admin/page.tsx`, `/api/super-admin/*` |
| Natural-language instructions → executed operations, Bengali + English, rule-based routing (works with no AI model at all) | `src/lib/super-admin/intents.ts`, `runs.ts` |
| Omni-routing, local-first, free-tier-only, one provider in flight | `src/lib/omni/router.ts`, `src/lib/ai-chain.ts`, `src/lib/external-ai.ts` |
| Approval gate for anything with real-world effect (deploy, publish, send, pay) | `src/lib/super-admin/runs.ts` → `/api/super-admin/actions` |
| Self-healing: browse → detect → fix → learn | `src/lib/self-heal/{browser,detector,fixer,learner}.ts` |
| Safe browsing with SSRF guard, size cap, redirect cap, no credentials | `src/lib/self-heal/browser.ts`, `src/lib/ssrf.ts` |
| Bounded agent loop with allowlisted tools, PII scrubbing, iteration cap | `src/lib/agent-loop.ts`, `agent-tools.ts` |
| Local Bangla TTS/ASR, photo→video, image studio | `/api/ai/voice`, `/api/asr-transcribe`, `/api/video/from-photo` |

So the chat interface and the agent plumbing exist. What was genuinely missing is
the part the owner emphasised: **the agent checking its own answer**. The chat
reply was returned without any evidence that what it claimed was true.

## Added now

### `src/lib/agent-verify.ts` — verification with one bounded repair

- **Browse assertions.** Every URL in the final answer is fetched through the
  SSRF-guarded browser module. A URL the agent cites must actually load
  (`HTTP < 400`, not an error page). Loopback, private ranges and cloud-metadata
  addresses are *reported as failures*, never fetched — the guard is not relaxed
  for convenience.
- **Deterministic checks.** The caller supplies small predicates
  (`answer => /https?:/.test(answer)`), so "it looks fine" is never decided by
  the same model that produced the answer.
- **One repair, quoting the failure.** A failed verification produces a single
  retry instruction listing the exact failures. Not "try again" — the specific
  broken assertions. Exactly one retry: no loop, no unbounded spend.
- **An honest verdict.** If the repair also fails, the report says `failed` with
  the evidence. A false `completed` is worse than a failure, because an admin
  would act on it.

### `/api/super-admin/chat` now returns `verification`

Each turn is verified before the answer is returned (owner-session only;
`?verify=0` opts out for an air-gapped caller). The response carries
`verification: { ok, checks, browsed, failures, repaired }`, so the dashboard can
show *why* an answer is trusted.

### `scripts/verification/live-rules.mjs`

The deploy acceptance rules (health verdict, 40-hex release identity, jar
replayability) moved out of the script into pure functions with 11 tests, so the
same question — "is this serving?" — is answered identically by the CLI check and
by anything that reuses it.

## What is deliberately NOT automatic

The owner's example: share a GitHub link, the agent checks it thoroughly and, if
the code is suitable and carries no risk, integrates it.

**What the system does:** fetch and inspect the link (public URL only, SSRF
guarded), report what it is, run the checks, and prepare the work.

**What it does not do:** silently modify this repository, run its tests against a
new dependency tree, commit, push or deploy. That is not a limitation to
apologise for — it is the standing rule of this project (*approval-gated
self-healing*, "production approval reviewers stay deliberately manual"). An
agent that can rewrite the app and deploy itself without a human is a single
bad prompt away from an outage, and the mandatory-review gate exists for exactly
that reason.

The honest middle ground, already in place:

1. The agent verifies what it can (links load, claims hold, checks pass).
2. Anything that touches production, money, messaging or the database becomes a
   `pending` action in `/api/super-admin/actions`.
3. The owner approves in the dashboard; only then does it execute, and the run
   timeline records who approved what.

Additional guardrails a GitHub-import feature must keep, if it is built next:

- **Licence gate first.** Several "free" projects on the owner's list are not
  plain open source — open-webui's branding clause, LiteLLM's `enterprise/`
  directory, `free-claude-code`'s AGPL-3.0-only. See
  [`FREE-SYSTEMS-INTEGRATION.md`](./FREE-SYSTEMS-INTEGRATION.md).
- **No arbitrary code execution** on the app host during review: static reading,
  dependency diff, and CI in a throwaway container, never `npm postinstall` from
  an unreviewed repo.
- **No direct `main` push.** A branch + PR + the normal CI gate, as every other
  change goes through.

## Verification

`tsc` 0 · lint clean · **336/336** tests · production build OK · secret scan 0
findings. New tests: `tests/agent-verify.test.mjs` (14) cover live-server browse
pass/fail, a fetcher that throws, the production default blocking loopback and
metadata hosts, repair-once semantics, repair-fails-again, and a repair callback
that throws. `tests/cookie-jar.test.mjs` (9) and `tests/verify-live.test.mjs` (5)
cover the acceptance path.
