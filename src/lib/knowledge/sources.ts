/**
 * Knowledge sources — "add these repos as knowledge for the agents".
 *
 * Every entry was checked against the GitHub API on 2026-11-27 (licence, stars,
 * archived flag, last push). The purpose of this file is NOT to link out: it
 * records, per source, **what may legally and technically be taken from it**, so
 * the agents answer from that boundary instead of from memory.
 *
 * ── Why a policy per source instead of "vendor everything" ────────────────
 *  - A permissive licence (MIT/Apache-2.0) allows copying code with attribution;
 *    a copyleft licence (AGPL) still allows use but obliges publication of
 *    modifications to that program; a custom/source-available licence
 *    ("NOASSERTION": NocoBase, Directus, Activepieces, open-webui, LiteLLM) often
 *    forbids exactly what we would want (branding removal, resale).
 *  - Most of these are whole products (Temporal, Directus, NocoBase, vLLM,
 *    SignuDoc, Monid). Vendoring a product would replace this application, not
 *    extend it, so they are indexed as knowledge + an optional loopback service.
 *  - A licence index (free-for-dev), an API client (Postman) and a hosted browser
 *    (FloppyData) have no code to take at all; they are reference material and
 *    are marked as such.
 *
 * ── Hard rules ────────────────────────────────────────────────────────────
 *  - `adoption` is the only decision that matters; a "rejected" or
 *    "reference-only" source may never be presented as integrated.
 *  - Nothing is fetched at request time: the index is static, reviewable and
 *    offline, so a vanished URL cannot silently change an answer.
 *  - Adding a source is a reviewed code change, never a runtime upload.
 */

export type Adoption =
  /** Concepts/protocols re-implemented here; no code copied. */
  | "pattern"
  /** Installed/run as a separate service the owner starts; we only call it. */
  | "service"
  /** Already wired: speaks the OpenAI chat-completions protocol. */
  | "integrated"
  /** Wired as an owner-gated tool surface (not a chat model). */
  | "integrated-tools"
  /** Read as documentation only; no code, no data copied. */
  | "reference-only"
  /** Deliberately not adopted; the reason is recorded so it is not re-litigated. */
  | "rejected";

export type SourceKind =
  | "model-runtime"
  | "gateway"
  | "agent-tools"
  | "workflow-automation"
  | "low-code-backend"
  | "durable-workflow"
  | "headless-cms"
  | "coding-agent"
  | "chat-ui"
  | "document-signature"
  | "api-tooling"
  | "hosted-browser"
  | "free-tier-index";

export interface KnowledgeSource {
  /** Stable id used in chat answers and in /api/super-admin/knowledge. */
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  /** GitHub API facts from 2026-11-27; null when not measurable. */
  facts: {
    spdx: string | null;
    stars: number | null;
    archived: boolean;
    lastPush: string | null;
    language: string | null;
  };
  adoption: Adoption;
  /** What may actually be taken. One enforceable sentence. */
  mayUse: string;
  /** What may not be done, or what would bite us. One enforceable sentence. */
  mustNot: string;
  /** How an agent should use it today (the only actionable instruction). */
  agentUse: string;
  /** Env var names that make the source reachable, when it is a service. */
  configEnv?: string[];
  /** The decisive licensing sentence, when the licence decides the outcome. */
  licenceNote?: string;
}

const GH = "https://github.com";

export const KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  {
    id: "litellm",
    name: "LiteLLM",
    url: `${GH}/BerriAI/litellm`,
    kind: "gateway",
    facts: { spdx: "NOASSERTION", stars: 64009, archived: false, lastPush: "2026-11-27T09:40:26Z", language: "Python" },
    adoption: "integrated",
    mayUse: "Call its OpenAI-compatible /v1/chat/completions endpoint over loopback as an owner gateway.",
    mustNot: "Do not vendor it, and do not treat litellm/enterprise/ as MIT — that directory has separate commercial terms.",
    agentUse: "Set LITELLM_BASE_URL + LITELLM_MODEL (plus LITELLM_API_KEY if the proxy requires one); both owner switches and the payment guard still apply.",
    configEnv: ["LITELLM_BASE_URL", "LITELLM_MODEL", "LITELLM_API_KEY"],
    licenceNote: "GitHub reports 'Other': the core is MIT, the enterprise directory is not.",
  },
  {
    id: "librechat",
    name: "LibreChat",
    url: `${GH}/LibreChat-AI/LibreChat`,
    kind: "chat-ui",
    facts: { spdx: "MIT", stars: 47577, archived: false, lastPush: "2026-11-27T09:37:24Z", language: "TypeScript" },
    adoption: "integrated",
    mayUse: "Call its OpenAI-compatible endpoint over loopback as a second owner gateway; MIT allows code reuse with attribution.",
    mustNot: "Do not copy its UI/assets to replace this application's front end — only the model endpoint is borrowed.",
    agentUse: "LIBRECHAT_BASE_URL has no default (its API port is deployment-specific) plus LIBRECHAT_MODEL; stays disabled until both are named.",
    configEnv: ["LIBRECHAT_BASE_URL", "LIBRECHAT_MODEL", "LIBRECHAT_API_KEY"],
  },
  {
    id: "ollama",
    name: "Ollama",
    url: `${GH}/ollama/ollama`,
    kind: "model-runtime",
    facts: { spdx: "MIT", stars: null, archived: false, lastPush: null, language: "Go" },
    adoption: "service",
    mayUse: "Run locally on 127.0.0.1:11434; it is first in the chain and keeps student data on the server.",
    mustNot: "Do not expose the port publicly, and do not point it at a remote host (only loopback/private hosts are accepted).",
    agentUse: "OLLAMA_BASE_URL + OLLAMA_MODEL (default qwen2.5:7b, Bengali-capable). Local calls are not subject to the external-input cap.",
    configEnv: ["OLLAMA_BASE_URL", "OLLAMA_MODEL"],
  },
  {
    id: "vllm",
    name: "vLLM",
    url: `${GH}/vllm-project/vllm`,
    kind: "model-runtime",
    facts: { spdx: "Apache-2.0", stars: 97683, archived: false, lastPush: "2026-11-27T09:41:32Z", language: "Python" },
    adoption: "service",
    mayUse: "Optionally run as a separate inference server elsewhere and call it as an owner gateway (it serves the OpenAI protocol).",
    mustNot: "Do not install it on the application host: it needs a GPU and a heavy Python/CUDA stack this box does not have.",
    agentUse: "Only when the owner runs vLLM elsewhere: name its base URL and an explicit model id — a model is never guessed.",
    configEnv: ["LITELLM_BASE_URL", "OMNIROUTE_BASE_URL"],
    licenceNote: "Apache-2.0 — permissive; the GPU requirement, not the licence, is why it is not installed here.",
  },
  {
    id: "monid",
    name: "Monid (OpenRouter for agent tools)",
    url: `${GH}/monid-ai/monid`,
    kind: "agent-tools",
    facts: { spdx: "MIT", stars: 5683, archived: false, lastPush: "2026-11-17T00:37:15Z", language: "TypeScript" },
    adoption: "integrated-tools",
    mayUse: "discover/inspect (free) and approval-gated run, wired in src/lib/monid.ts; the MIT connector schema was the source for src/lib/monid-catalog.ts.",
    mustNot: "Never present it as a chat model and never call run without an owner approval — every run spends the owner's Monid balance.",
    agentUse: "Ask 'what can monid tools do' for the local catalogue (no key needed). discover/inspect need ALO_MONID_ENABLED + MONID_API_KEY; run also needs both AI switches and an approval.",
    configEnv: ["ALO_MONID_ENABLED", "MONID_API_KEY", "MONID_BASE_URL"],
    licenceNote: "MIT for the connector layer; using the hosted service is billed per call.",
  },
  {
    id: "signudoc",
    name: "SignuDoc",
    url: `${GH}/NYLLON-SOFTWARE/SignuDoc`,
    kind: "document-signature",
    facts: { spdx: "MIT", stars: 3313, archived: false, lastPush: "2026-11-27T06:35:54Z", language: "TypeScript" },
    adoption: "reference-only",
    mayUse: "Read its signing/audit model when designing admission-document or consent-form signatures.",
    mustNot: "Do not deploy it as a second application on the same box, and do not claim document signing exists here until it is built and tested.",
    agentUse: "Use it to answer 'how would signing and audit trails work', and state plainly that this app does not have that feature yet.",
  },
  {
    id: "free-for-dev",
    name: "free-for-dev",
    url: `${GH}/ripienaar/free-for-dev`,
    kind: "free-tier-index",
    facts: { spdx: null, stars: 143796, archived: false, lastPush: "2026-11-27T06:56:24Z", language: "HTML" },
    adoption: "reference-only",
    mayUse: "Use it as a checklist when evaluating a free tier; it is a curated list, not software.",
    mustNot: "Do not copy its list wholesale into answers (it changes daily and is not licence-reviewed per vendor), and never enable a paid service because it was listed as having a free tier.",
    agentUse: "When asked 'is X free?', report the current free-tier terms as unverified unless the provider is already configured here.",
    licenceNote: "No licence file: readable, but there is nothing to reuse as code.",
  },
  {
    id: "nocobase",
    name: "NocoBase",
    url: `${GH}/nocobase/nocobase`,
    kind: "low-code-backend",
    facts: { spdx: "NOASSERTION", stars: 25028, archived: false, lastPush: "2026-11-27T09:38:24Z", language: "TypeScript" },
    adoption: "rejected",
    mayUse: "Read the plugin/data-model ideas if a no-code admin panel is ever requested.",
    mustNot: "Do not adopt: the licence is source-available/aggregate (NOASSERTION) and it would duplicate the Prisma + Next.js admin this project already has.",
    agentUse: "If asked, say it was evaluated and rejected, with the licence and duplicate-product reasons.",
    licenceNote: "GitHub reports 'Other' (NOASSERTION): core is AGPL-style with separate commercial/enterprise terms — read LICENSE before any reuse.",
  },
  {
    id: "directus",
    name: "Directus",
    url: `${GH}/directus/directus`,
    kind: "headless-cms",
    facts: { spdx: "NOASSERTION", stars: 38699, archived: false, lastPush: "2026-11-26T14:15:45Z", language: "TypeScript" },
    adoption: "rejected",
    mayUse: "Study its REST/GraphQL data-modelling conventions if a public content API is ever needed.",
    mustNot: "Do not adopt: NOASSERTION licence (BSL-style for parts) and a second backend over the same MySQL would compete with Prisma, which is this project's only data layer.",
    agentUse: "Answer with the rejection reason; never propose it as the fix for a missing admin page.",
    licenceNote: "GitHub reports 'Other' (NOASSERTION): the licence is BSL-style for parts of the product, not a plain OSS licence.",
  },
  {
    id: "activepieces",
    name: "Activepieces",
    url: `${GH}/activepieces/activepieces`,
    kind: "workflow-automation",
    facts: { spdx: "NOASSERTION", stars: 25753, archived: false, lastPush: "2026-11-27T09:34:50Z", language: "TypeScript" },
    adoption: "rejected",
    mayUse: "Read its trigger/action abstraction when designing webhook automations.",
    mustNot: "Do not adopt: parts carry separate/enterprise terms (NOASSERTION) and running it adds a Node service, a queue and its own database to a single-VPS deployment.",
    agentUse: "Say it was evaluated and rejected for licence plus operational cost; the existing scheduler/self-heal jobs cover the need.",
    licenceNote: "GitHub reports 'Other' (NOASSERTION): MIT core with enterprise-licensed portions, so a subset is not open source.",
  },
  {
    id: "temporal",
    name: "Temporal",
    url: `${GH}/temporalio/temporal`,
    kind: "durable-workflow",
    facts: { spdx: "MIT", stars: 24626, archived: false, lastPush: "2026-11-27T00:44:39Z", language: "Go" },
    adoption: "pattern",
    mayUse: "Copy the idea (deterministic workflow code + retries + timers) into this repo's run records and schedulers; MIT also allows code reuse with attribution.",
    mustNot: "Do not run the Temporal server here: it is a Go service plus a history store, far beyond a one-VPS footprint.",
    agentUse: "Use it as vocabulary when explaining retries and durable steps in the Super Admin runs; never claim a Temporal cluster exists.",
  },
  {
    id: "aider",
    name: "Aider",
    url: `${GH}/Aider-AI/aider`,
    kind: "coding-agent",
    facts: { spdx: "Apache-2.0", stars: 50282, archived: false, lastPush: "2026-05-22T14:02:20Z", language: "Python" },
    adoption: "pattern",
    mayUse: "Reuse its 'targeted edit + run the tests' loop design when the owner approves an automated fix.",
    mustNot: "Do not let an agent edit files and push unattended: every change here is a reviewed PR, and upstream last pushed 2026-05-22 (activity is slowing).",
    agentUse: "Propose the edit as a patch for human review; never 'aider in a cron'.",
    licenceNote: "Apache-2.0; roughly six months since the last upstream push at the time of this index.",
  },
  {
    id: "open-webui",
    name: "Open WebUI",
    url: `${GH}/open-webui/open-webui`,
    kind: "chat-ui",
    facts: { spdx: "NOASSERTION", stars: 159669, archived: false, lastPush: "2026-11-27T00:38:20Z", language: "Svelte" },
    adoption: "rejected",
    mayUse: "Read its Ollama integration and prompt-library UX for ideas.",
    mustNot: "Do not adopt: its licence forbids removing the 'Open WebUI' branding above 50 users/30 days without permission or an enterprise licence, so it cannot be white-labelled.",
    agentUse: "Give that branding clause as the reason; this app already has its own Super Admin chat.",
    licenceNote: "Branded source-available: the branding clause is the blocker, not code quality.",
  },
  {
    id: "postman",
    name: "Postman",
    url: "https://www.postman.com",
    kind: "api-tooling",
    facts: { spdx: null, stars: null, archived: false, lastPush: null, language: null },
    adoption: "reference-only",
    mayUse: "Import this repo's request examples into a local Postman workspace; the HTTP client is free.",
    mustNot: "Do not upload collections containing real secrets or student data, and do not add a Postman cloud dependency to CI.",
    agentUse: "Offer a curl example built from this repo's own scripts instead of a workspace-specific link.",
  },
  {
    id: "floppydata-cloud-browser",
    name: "FloppyData Cloud Browser",
    url: "https://floppydata.com/cloud-browser/",
    kind: "hosted-browser",
    facts: { spdx: null, stars: null, archived: false, lastPush: null, language: null },
    adoption: "rejected",
    mayUse: "Read the API shape if a hosted browser is ever needed for the self-heal checks.",
    mustNot: "Do not use it: a paid hosted service, and routing page fetches through a third party would defeat this repo's SSRF guard and data policy.",
    agentUse: "Say the self-heal browser is local (browseUrl + SSRF guard); a hosted browser was rejected for cost and data-egress reasons.",
  },
];

export interface AgentGuidance {
  keywords: string[];
  guidance: string;
}

/** What the chat should SAY about these sources, so a model cannot invent one. */
export const AGENT_GUIDANCE: AgentGuidance[] = [
  {
    keywords: ["add", "knowledge", "repo", "repository", "index"],
    guidance:
      "Answer from KNOWLEDGE_SOURCES only: name the source, its licence and its adoption state. Never call a source 'integrated' unless adoption is 'integrated' or 'service'.",
  },
  {
    keywords: ["free", "cost", "paid", "billing"],
    guidance:
      "Only self-hosted litellm/librechat/ollama/vllm are cost-free here. monid, floppydata and every hosted tier cost money per call and need both owner switches.",
  },
  {
    keywords: ["licence", "license", "legal"],
    guidance:
      "Quote facts.spdx. NOASSERTION means 'read the actual file first' — for NocoBase, Directus, Activepieces, open-webui and LiteLLM the answer is in licenceNote.",
  },
];

/** Look a source up by id, name or URL host+path fragment. */
export function findSource(query: string): KnowledgeSource | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  return KNOWLEDGE_SOURCES.find(
    (source) =>
      source.id === needle ||
      source.name.toLowerCase() === needle ||
      source.url.toLowerCase().includes(needle) ||
      needle.includes(source.id),
  );
}

/** Totals for the dashboard/health view. Derived, never invented. */
export function knowledgeSummary() {
  const byAdoption = KNOWLEDGE_SOURCES.reduce<Record<string, number>>((acc, source) => {
    acc[source.adoption] = (acc[source.adoption] ?? 0) + 1;
    return acc;
  }, {});
  return {
    total: KNOWLEDGE_SOURCES.length,
    byAdoption,
    integrated: KNOWLEDGE_SOURCES.filter((s) => s.adoption === "integrated").map((s) => s.id),
    rejected: KNOWLEDGE_SOURCES.filter((s) => s.adoption === "rejected").map((s) => s.id),
    /** Sources an agent may describe as usable today without new setup. */
    usableToday: KNOWLEDGE_SOURCES.filter((s) => s.adoption === "integrated" || s.id === "ollama").map((s) => s.id),
    /** Wired but owner-gated: describing these as "on" would be a lie. */
    gated: KNOWLEDGE_SOURCES.filter((s) => s.adoption === "integrated-tools").map((s) => s.id),
  };
}
