# "Add all the free systems" — what was actually adopted, and what cannot be

Every repository on the list was checked against **this** application (Next.js
standalone + Prisma/MySQL + PM2 on one VPS). The rule that decided each row is
the project's standing one: **real functionality, no fake integration, no
second product bolted onto the box.**

## Adopted (code changed, tested)

| System | How it is integrated | Why this way |
| --- | --- | --- |
| [LiteLLM](https://github.com/BerriAI/litellm) | New owner-gateway alias in `src/lib/external-ai.ts`: `LITELLM_API_KEY` / `LITELLM_MODEL` / `LITELLM_BASE_URL` (default `http://127.0.0.1:4000/v1`) | It is a proxy *server* that speaks OpenAI chat-completions. Vendoring its Python code would duplicate a proven router; calling it over loopback gives every model LiteLLM can reach, with the existing payment guard, free-only allowlist and no-PII rule unchanged. |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | Owner-gateway alias `LIBRECHAT_*` (no default URL — its API port is deployment-specific) | Same protocol. It stays a separate UI on the operator's machine; this app only borrows its model endpoint when the owner names it. |

Both are **env-only**, behind **both** owner switches
(`ALO_PAID_AI_API_ALLOWED` + `ALO_OWNER_APPROVED_PAID_AI_API`), reachable only
over a private/loopback host (plain `http` to a public host is rejected), and a
model id is **mandatory** — a missing one reports `missing_model` rather than
guessing a paid or nonexistent model. Tests: `tests/external-ai.test.mjs`
(25 tests, including the gateway fall-through, the missing-model refusal, and
the public-http rejection).

This is the same pattern the repo already used for OmniRoute and for
`ALO_CUSTOM_AI_PROVIDERS_JSON`; LiteLLM and LibreChat simply stop requiring a
hand-written JSON blob.

## Already present — nothing to add

| Capability | Existing implementation |
| --- | --- |
| Free-only omni AI chain | `src/lib/ai-chain.ts`, `src/lib/external-ai.ts` (Groq, LLM7, OpenCode Zen, OpenRouter `:free`, OmniRoute, custom) |
| Local models | Ollama at `OLLAMA_BASE_URL` (`qwen2.5:7b`), `src/lib/local-models.ts` |
| Agent loop + tools + approvals | `src/lib/agent-loop.ts`, `agent-tools.ts`, `agent-runtime.ts`, `/api/approvals` |
| Self-healing | `/api/health`, `/api/health/diagnose`, `deploy/monitor.sh` |
| Local TTS/ASR + video | Piper → eSpeak → formant, whisper, ffmpeg burn-in (`/api/ai/voice`, `/api/asr-transcribe`, `/api/video/from-photo`) |

## Deliberately not vendored

These are **whole platforms** (own database, own auth, own UI, often their own
webserver and 700 MB–3 GB of source). Copying them into this repository would
mean two competing admin consoles, two session systems, and a second schema on
a single small VPS. They remain *compatible neighbours*: anything that speaks
OpenAI chat-completions can be attached through the gateway aliases above.

| Project | What it is | Could it be attached? |
| --- | --- | --- |
| [open-webui](https://github.com/orgs/open-webui/repositories) | Full chat UI | No — it is a UI, not a model endpoint; it would duplicate `/dashboard` |
| [Aider-AI](https://github.com/orgs/Aider-AI/repositories) | Terminal pair-programmer | No — developer tool, not a runtime dependency |
| [SWE-agent](https://github.com/orgs/SWE-agent/repositories) | Autonomous repo fixer | No — same, and it needs a sandbox + paid model budget |
| [directus](https://github.com/orgs/directus/repositories) | Headless CMS + own DB | No — would compete with Prisma/MySQL as the single source of truth |
| [nocobase](https://github.com/orgs/nocobase/repositories) | No-code app builder + own DB | No — same reason |
| [activepieces](https://github.com/activepieces/activepieces) | Automation platform | No — the app already has `invoice`/`cron`/approval automation in-process |
| [temporalio](https://github.com/orgs/temporalio/repositories) | Durable workflow engine (Go server) | No — a cluster of its own; PM2 + Prisma jobs already cover this scale |
| [GrapesJS](https://github.com/GrapesJS/grapesjs) | MIT web-page builder library | **Possible later** — it is a real library and could power a page builder inside `/content`; not needed for the current cutover |
| [caprover](https://github.com/caprover/caprover) | Self-hosted PaaS | No — the box is already managed by PM2 + Caddy + GitHub Actions |
| [dokku](https://github.com/dokku/dokku) | Heroku-like PaaS (needs root) | No — same, and it demands root/docker control of the host |
| [InfiniteTalk](https://github.com/MeiGen-AI/InfiniteTalk) | Talking-head video model (GPU) | No GPU on this VPS; the existing photo→video pipeline is CPU-only |
| [OmniCopilot](https://github.com/cheaper-inference/OmniCopilot), [free-claude-code](https://github.com/Alishahryar1/free-claude-code) | Coding copilots | No — and `free-claude-code` is **AGPL-3.0-only**, which would relicense obligations onto this app |
| [call-gpt](https://github.com/twilio-labs/call-gpt), [ai-native-callcenter](https://github.com/rasonyang/ai-native-callcenter), [AI-Powered-Call-Center-Intelligence](https://github.com/amulchapla/AI-Powered-Call-Center-Intelligence) | Twilio/Go/Node call-centre demos | The app already has a voice contact centre (`docs/voice-contact-center`, `/api/sms/*`, local ASR/TTS). Copying a demo would add a second telephony stack, and Twilio is a paid external service — the standing rule forbids routing student/family PII off the box |
| [jarvis.institute](https://jarvis.institute), [topics/jarvis-ai](https://github.com/topics/jarvis-ai) | Inspiration / topic index | Already reflected in the 20 applied repository topics |

## Licence reality check (this is why "free" ≠ "open source")

| Project | Licence as published |
| --- | --- |
| open-webui | Custom "Open WebUI License": BSD-3 style **plus** a clause forbidding removal of "Open WebUI" branding above 50 users in 30 days |
| LiteLLM | MIT **except** `litellm/enterprise/`, which carries its own licence |
| LibreChat | MIT |
| Aider | Apache-2.0 |
| SWE-agent | MIT |
| GrapesJS | BSD-3 |
| caprover / dokku / Temporal | Apache-2.0 / MIT / MIT |
| free-claude-code | **AGPL-3.0-only** |
| open-webui, directus, nocobase, activepieces | GitHub reports `NOASSERTION` — each has bespoke terms, so read them before redistribution |

Nothing from the "not vendored" list was added, so none of those terms apply to
this repository.
