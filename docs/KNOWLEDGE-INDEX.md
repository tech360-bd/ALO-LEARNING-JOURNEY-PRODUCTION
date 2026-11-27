# Knowledge index — what the agents may say about the pasted repositories

The owner pasted a list of repositories and asked for them to be added "as
knowledge for the agents". This document is the resulting register: **one row
per source, the licence as the GitHub API reports it on 2026-11-27, and what may
actually be taken from it.**

The implementation is `src/lib/knowledge/sources.ts` (the register) and
`src/lib/knowledge/agent.ts` (the prompt/report generated from it). The register
is static and reviewable: nothing is fetched at request time, so a URL that
changes upstream cannot silently change an answer, and adding a source is a
reviewed code change rather than a runtime upload.

## Adoption states

| State | Meaning |
| --- | --- |
| `integrated` | Already wired: speaks the OpenAI chat-completions protocol and is reachable through an owner gateway. |
| `integrated-tools` | Wired as an owner-gated tool surface (Monid): free search, billed runs behind approval. |
| `service` | Installed/run separately by the owner; this app only calls it (loopback/private hosts only). |
| `pattern` | The *idea* is reused in this repo's own code; no server, no vendored source. |
| `reference-only` | Documentation to read. No code and no data copied. |
| `rejected` | Evaluated and refused; the reason is stored so it is not re-litigated. |

## The register

| Source | Licence (2026-11-27) | ★ | Adoption | What may be used |
| --- | --- | --- | --- | --- |
| LiteLLM | `NOASSERTION` (MIT core, `enterprise/` separate) | 64,009 | `integrated` | `LITELLM_BASE_URL` + `LITELLM_MODEL` owner gateway |
| LibreChat | MIT | 47,577 | `integrated` | `LIBRECHAT_BASE_URL` + `LIBRECHAT_MODEL` owner gateway |
| Ollama | MIT | — | `service` | local models on `127.0.0.1:11434` (first in the chain) |
| vLLM | Apache-2.0 | 97,683 | `service` | only if the owner runs it elsewhere; needs a GPU |
| Monid | MIT (connector layer; hosted calls **billed**) | 5,683 | `integrated-tools` | free `discover`/`inspect`; `run` needs approval — see [`MONID-INTEGRATION.md`](./MONID-INTEGRATION.md) |
| SignuDoc | MIT | 3,313 | `reference-only` | signing/audit model, if signatures are ever built |
| free-for-dev | none stated | 143,796 | `reference-only` | a checklist; never copied wholesale |
| Postman | proprietary (free client) | — | `reference-only` | build a local collection; no secrets uploaded |
| Temporal | MIT | 24,626 | `pattern` | durable-retry *design*; no Temporal server here |
| Aider | Apache-2.0 | 50,282 | `pattern` | "targeted edit + run tests" loop, human-reviewed |
| NocoBase | `NOASSERTION` | 25,028 | `rejected` | licence is not plain OSS; duplicates the Prisma admin |
| Directus | `NOASSERTION` | 38,699 | `rejected` | BSL-style parts; a second backend over the same MySQL |
| Activepieces | `NOASSERTION` | 25,753 | `rejected` | enterprise terms + another service, queue and database |
| Open WebUI | `NOASSERTION` (branding clause) | 159,669 | `rejected` | may not remove the branding above 50 users/30 days |
| FloppyData Cloud Browser | proprietary, paid | — | `rejected` | a hosted browser defeats this repo's SSRF guard |

## Why "add all of them" is not "vendor all of them"

The list mixes five different kinds of thing:

1. **Protocol-compatible model servers** (LiteLLM, LibreChat, vLLM, Ollama) — worth
   wiring, because the app already speaks that protocol. Done for LiteLLM and
   LibreChat (see `docs/FREE-SYSTEMS-INTEGRATION.md`); vLLM/Ollama stay
   owner-run services so no GPU stack lands on the application host.
2. **Whole products** (Directus, NocoBase, Activepieces, Temporal, SignuDoc) —
   each brings its own database, auth and webserver. Installing one would replace
   this application's Prisma/MySQL admin rather than extend it, so their *ideas*
   are reused and the products are not installed.
3. **A metered tool marketplace** (Monid) — genuinely useful as a catalogue of
   2,000+ tools, but every `run` is **billed per call**. The no-paid rule is a
   standing owner instruction, so it is indexed as reference only; enabling it
   needs an explicit owner decision (and a key that is never committed).
4. **A branded source-available chat UI** (Open WebUI) — the licence forbids
   removing its branding above 50 users/30 days, which is incompatible with
   white-labelling for this school.
5. **Lists and clients** (free-for-dev, Postman, FloppyData) — no code at all.

## How the agents use it

- `parseIntent()` gained a `list_sources` intent, matched **before** the URL rules:
  "add all repo agent with all knowledge" is an inventory question, while a
  single pasted link is still a `review_link`.
- The chat run composes the answer from the register (`sourceReport()`), so it
  cannot describe a rejected source as usable, and the prompt itself carries the
  register (`knowledgePromptBlock()`), so a free-form answer cannot invent an
  integration.
- `GET /api/super-admin/knowledge` (owner only) returns the register; add
  `?id=`, `?report=1` or `?prompt=1` for a single source, the chat answer, or the
  exact prompt block.
- Verified live: `GET /api/super-admin/knowledge` → HTTP 200, 15 sources, summary
  `integrated: litellm, librechat`, `rejected: nocobase, directus, activepieces,
  open-webui, floppydata-cloud-browser`; and a real run of the owner's own
  sentence completed with a 3,376-character answer listing all 15 sources.

## Not added on purpose

- **Vendored source** from any `NOASSERTION`/no-licence repository — no.
- **A paid key** anywhere in the repo — no.
- **A runtime "add a repo" upload** — no: it would let a link change what the
  agents assert without review.
