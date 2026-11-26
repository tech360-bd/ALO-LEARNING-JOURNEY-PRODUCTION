# GitHub repository metadata (topics + description)

The repository had **no topics and no description** (`topics: []`,
`description: null`), so it was invisible in topic listings such as
[`github.com/topics/jarvis-ai`](https://github.com/topics/jarvis-ai) — 242
public repositories, filterable by language, sortable by stars.

`scripts/apply-repo-metadata.mjs` is the single source of truth for both.

```bash
node scripts/apply-repo-metadata.mjs --dry-run     # print the plan, no API call
GH_TOKEN=... node scripts/apply-repo-metadata.mjs  # apply
```

> **Write access note:** the automation token used here is read-only for this
> endpoint — `PUT /repos/{owner}/{repo}/topics` returns
> `403 Resource not accessible by integration`. Topics and description must
> therefore be applied from a session whose token has `administration` on the
> repository (the owner's own terminal or the GitHub UI, Settings → General).

The script merges with any topics that already exist (GitHub allows 20), so
running it never silently drops something set elsewhere.

## Topics (20/20)

| Topic | Backed by |
| --- | --- |
| `jarvis-ai` | `src/lib/super-admin/runs.ts`, `src/lib/super-admin/chat.ts` |
| `ai-agent` | `src/lib/agent-runtime.ts`, `src/lib/agent-loop.ts` |
| `agent-os` | `src/lib/agentos/skill-validator.ts`, `src/lib/agentos/payment-guard.ts` |
| `agent-orchestration` | `src/lib/omni/router.ts` |
| `ai-assistant` | `src/app/super-admin/page.tsx` |
| `bengali` / `bangla` | `src/lib/voice-engine.ts`, `src/lib/asr-engine.ts` |
| `llm` | `src/lib/external-ai.ts` |
| `ai-routing` | `src/lib/omni/catalog.ts`, `src/lib/ai-chain.ts` |
| `self-healing` | `src/lib/self-heal/{detector,fixer}.ts` |
| `openai-alternative` | `src/lib/omni/catalog.ts` (free-tier-only provider chain) |
| `text-to-speech` | `src/lib/voice-engine.ts` (Piper `bn_BD`) |
| `speech-recognition` / `whisper` | `src/lib/asr-engine.ts` (faster-whisper) |
| `voice-assistant` | `src/components/alo/VoiceStudioView.tsx` |
| `ffmpeg` | `src/lib/local-audio.ts`, `scripts/verify-media-pipeline.mjs` |
| `nextjs` / `typescript` / `prisma` / `mysql` | `next.config.ts`, `tsconfig.json`, `prisma/schema.prisma` |

## Description

> Bengali-first AI learning and workforce platform: Super Admin command center,
> omni-routed free-tier AI, local Bangla voice (TTS/ASR), photo-to-video studio,
> CRM, and self-healing operations.

## Why `tests/repo-metadata.test.mjs` exists

Topics are claims. This repository's audits already reject unverified claims, so
the test asserts every advertised topic resolves to real files, that the
language/ORM topics match `package.json` and `prisma/schema.prisma`, and that a
deliberately withheld topic stays absent.

`mcp` was considered and **dropped**: there is no `/mcp`, no `ModelContextProtocol`
usage, and no MCP server or client anywhere in `src/` or `scripts/`. The test
fails if that changes without the topic being added back.

## Why `jarvis-ai` alone is not enough

The listing is sorted by stars and dominated by Python voice assistants. This
project's differentiators — Bangla-first TTS/ASR, free-tier-only omni routing,
approval-gated self-healing — are what `bengali`, `bangla`,
`openai-alternative`, and `self-healing` signal. Discovery also needs a
description and a README that leads with them; both are in place.
