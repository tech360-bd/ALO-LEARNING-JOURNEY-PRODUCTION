// ALO Learning Journey — OmniRouter free-tier provider catalog (server-only).
//
// Declarative catalog of free-tier AI providers reachable through routing
// platforms. Only providers that are ALSO configured in src/lib/external-ai.ts
// (built-in free providers + owner gateways) can actually serve traffic.
// Catalog-only entries are documented for the owner to add later via env
// (ALO_CUSTOM_AI_PROVIDERS_JSON) — they are never called automatically.
//
// Honesty rules:
//  - Free tiers change often; every entry carries a `freeTierNote` and the
//    model IDs are env-overridable. This catalog never claims a provider is
//    free today — it records the last known free-tier terms.
//  - "300+ free APIs" refers to the aggregate catalog across routing
//    platforms (OpenRouter alone lists 300+ models). Each entry below is a
//    provider; model counts are noted, not invented.
//  - Paid models are blocked at the router (free-model guard in external-ai.ts).

export type CatalogTier = "builtin" | "gateway" | "catalog-only";
export type CatalogKind = "chat" | "embedding" | "image" | "tts" | "stt" | "search" | "vision";

export interface CatalogEntry {
  id: string;
  name: string;
  kind: CatalogKind;
  tier: CatalogTier;
  /** OpenAI-compatible chat endpoint, when the provider speaks that protocol. */
  endpoint?: string;
  /** Env var holding the free-tier API key (never the key itself). */
  apiKeyEnv?: string;
  /** Env var holding the model id. */
  modelEnv?: string;
  defaultModel?: string;
  /** Last known free-tier terms (verify before use; terms change). */
  freeTierNote: string;
  docsUrl: string;
  /** Approximate number of free models on this platform (for planning only). */
  freeModelCountHint?: number;
  /** Whether the router may call this entry today (built-in + configured). */
  callable: boolean;
}

export const OMNI_CATALOG: CatalogEntry[] = [
  // ── Built-in free-tier providers (callable via external-ai.ts) ──────────
  {
    id: "groq",
    name: "Groq",
    kind: "chat",
    tier: "builtin",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    apiKeyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile",
    freeTierNote: "Free tier with daily token quotas; no billing key = free quota only.",
    docsUrl: "https://console.groq.com",
    freeModelCountHint: 10,
    callable: true,
  },
  {
    id: "llm7",
    name: "LLM7",
    kind: "chat",
    tier: "builtin",
    endpoint: "https://api.llm7.io/v1/chat/completions",
    apiKeyEnv: "LLM7_API_KEY",
    modelEnv: "LLM7_MODEL",
    defaultModel: "default",
    freeTierNote: "Free token via token.llm7.io; 'pro' selector is paid and blocked.",
    docsUrl: "https://token.llm7.io",
    freeModelCountHint: 5,
    callable: true,
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    kind: "chat",
    tier: "builtin",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    apiKeyEnv: "OPENCODE_API_KEY",
    modelEnv: "OPENCODE_MODEL",
    defaultModel: "big-pickle",
    freeTierNote: "Zen free models only (big-pickle or *-free); other models blocked.",
    docsUrl: "https://opencode.ai/auth",
    freeModelCountHint: 8,
    callable: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "chat",
    tier: "builtin",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "openrouter/free",
    freeTierNote: "Free models (openrouter/free or *:free) with rate limits; paid models blocked.",
    docsUrl: "https://openrouter.ai/settings/keys",
    freeModelCountHint: 300,
    callable: true,
  },
  {
    id: "omniroute",
    name: "OmniRoute (self-hosted gateway)",
    kind: "chat",
    tier: "gateway",
    apiKeyEnv: "OMNIROUTE_API_KEY",
    modelEnv: "OMNIROUTE_MODEL",
    defaultModel: "auto",
    freeTierNote: "Owner-operated gateway; routes per its own config. Owner-trusted.",
    docsUrl: "https://github.com/diegosouzapw/OmniRoute",
    callable: true,
  },
  {
    id: "local-ollama",
    name: "Local Ollama (self-hosted)",
    kind: "chat",
    tier: "gateway",
    apiKeyEnv: "OLLAMA_BASE_URL",
    modelEnv: "OLLAMA_MODEL",
    defaultModel: "qwen2.5:7b",
    freeTierNote: "Runs on this server; no API cost. Always tried first.",
    docsUrl: "https://ollama.com",
    callable: true,
  },

  // ── Catalog-only free-tier providers (documented; add via env to call) ──
  // These are NOT called automatically. To enable one, add it as a custom
  // gateway in ALO_CUSTOM_AI_PROVIDERS_JSON (see .env.example) after
  // verifying its current free-tier terms.
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
    apiKeyEnv: "CEREBRAS_API_KEY",
    freeTierNote: "Free tier with daily quotas (verify current limits).",
    docsUrl: "https://inference-docs.cerebras.ai",
    freeModelCountHint: 12,
    callable: false,
  },
  {
    id: "together",
    name: "Together AI",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api.together.xyz/v1/chat/completions",
    apiKeyEnv: "TOGETHER_API_KEY",
    freeTierNote: "Limited free credits on signup; verify before use.",
    docsUrl: "https://docs.together.ai",
    freeModelCountHint: 40,
    callable: false,
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
    apiKeyEnv: "FIREWORKS_API_KEY",
    freeTierNote: "Free tier for select models; verify current catalog.",
    docsUrl: "https://docs.fireworks.ai",
    freeModelCountHint: 30,
    callable: false,
  },
  {
    id: "mistral",
    name: "Mistral AI (La Plateforme)",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    apiKeyEnv: "MISTRAL_API_KEY",
    freeTierNote: "Free tier with rate limits on select models.",
    docsUrl: "https://docs.mistral.ai",
    freeModelCountHint: 15,
    callable: false,
  },
  {
    id: "cohere",
    name: "Cohere",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api.cohere.ai/v2/chat",
    apiKeyEnv: "COHERE_API_KEY",
    freeTierNote: "Trial keys with limited calls; verify current terms.",
    docsUrl: "https://docs.cohere.ai",
    freeModelCountHint: 10,
    callable: false,
  },
  {
    id: "google-ai-studio",
    name: "Google AI Studio (Gemini)",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    apiKeyEnv: "GOOGLE_AI_STUDIO_API_KEY",
    freeTierNote: "Free tier with per-minute quotas on Gemini Flash models.",
    docsUrl: "https://aistudio.google.com/apikey",
    freeModelCountHint: 6,
    callable: false,
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api-inference.huggingface.co/models",
    apiKeyEnv: "HUGGINGFACE_API_KEY",
    freeTierNote: "Free serverless inference with rate limits on many models.",
    docsUrl: "https://huggingface.co/docs/api-inference",
    freeModelCountHint: 100,
    callable: false,
  },
  {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    kind: "chat",
    tier: "catalog-only",
    apiKeyEnv: "CLOUDFLARE_API_KEY",
    freeTierNote: "Daily free neuron allocation; verify current pricing page.",
    docsUrl: "https://developers.cloudflare.com/workers-ai",
    freeModelCountHint: 50,
    callable: false,
  },
  {
    id: "pollinations",
    name: "Pollinations",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://text.pollinations.ai/openai",
    freeTierNote: "Free anonymous tier with rate limits (no key required).",
    docsUrl: "https://pollinations.ai",
    freeModelCountHint: 5,
    callable: false,
  },
  {
    id: "duckduckgo-ai",
    name: "DuckDuckGo AI Chat",
    kind: "chat",
    tier: "catalog-only",
    freeTierNote: "Free anonymous chat; no official API — do not automate against ToS.",
    docsUrl: "https://duckduckgo.com/chat",
    freeModelCountHint: 4,
    callable: false,
  },
  {
    id: "github-models",
    name: "GitHub Models",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://models.inference.ai.azure.com/chat/completions",
    apiKeyEnv: "GITHUB_TOKEN",
    freeTierNote: "Free tier with rate limits for GitHub account holders.",
    docsUrl: "https://docs.github.com/en/github-models",
    freeModelCountHint: 30,
    callable: false,
  },
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    apiKeyEnv: "NVIDIA_API_KEY",
    freeTierNote: "Free credits for evaluation; verify current terms.",
    docsUrl: "https://docs.nvidia.com/nim",
    freeModelCountHint: 20,
    callable: false,
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api.deepinfra.com/v1/openai/chat/completions",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    freeTierNote: "Free credits on signup; verify current terms.",
    docsUrl: "https://docs.deepinfra.com",
    freeModelCountHint: 60,
    callable: false,
  },
  {
    id: "anyscale",
    name: "Anyscale",
    kind: "chat",
    tier: "catalog-only",
    endpoint: "https://api.anyscale.com/v1/chat/completions",
    apiKeyEnv: "ANYSCALE_API_KEY",
    freeTierNote: "Free credits on signup; verify current terms.",
    docsUrl: "https://docs.anyscale.com",
    freeModelCountHint: 25,
    callable: false,
  },
  {
    id: "replicate",
    name: "Replicate",
    kind: "image",
    tier: "catalog-only",
    endpoint: "https://api.replicate.com/v1/models",
    apiKeyEnv: "REPLICATE_API_TOKEN",
    freeTierNote: "Free credits on signup; per-run billing after.",
    docsUrl: "https://replicate.com/docs",
    freeModelCountHint: 80,
    callable: false,
  },
  {
    id: "fal-ai",
    name: "fal.ai",
    kind: "image",
    tier: "catalog-only",
    endpoint: "https://queue.fal.run",
    apiKeyEnv: "FAL_KEY",
    freeTierNote: "Free credits on signup; verify current terms.",
    docsUrl: "https://docs.fal.ai",
    freeModelCountHint: 100,
    callable: false,
  },
  {
    id: "edge-tts",
    name: "Edge TTS (Microsoft Edge)",
    kind: "tts",
    tier: "catalog-only",
    freeTierNote: "Free via Edge browser voices; no official API key.",
    docsUrl: "https://github.com/rany2/edge-tts",
    callable: false,
  },
  {
    id: "whisper-local",
    name: "Whisper (local)",
    kind: "stt",
    tier: "catalog-only",
    freeTierNote: "Runs locally via faster-whisper; no API cost.",
    docsUrl: "https://github.com/SYSTRAN/faster-whisper",
    callable: false,
  },
  {
    id: "tavily",
    name: "Tavily Search",
    kind: "search",
    tier: "catalog-only",
    endpoint: "https://api.tavily.com/search",
    apiKeyEnv: "TAVILY_API_KEY",
    freeTierNote: "Free tier with monthly search credits.",
    docsUrl: "https://docs.tavily.com",
    callable: false,
  },
  {
    id: "brave-search",
    name: "Brave Search API",
    kind: "search",
    tier: "catalog-only",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    apiKeyEnv: "BRAVE_API_KEY",
    freeTierNote: "Free tier with monthly query credits.",
    docsUrl: "https://api.search.brave.com",
    callable: false,
  },
  {
    id: "serper",
    name: "Serper",
    kind: "search",
    tier: "catalog-only",
    endpoint: "https://google.serper.dev/search",
    apiKeyEnv: "SERPER_API_KEY",
    freeTierNote: "Free credits on signup.",
    docsUrl: "https://serper.dev/docs",
    callable: false,
  },
  {
    id: "jina-reader",
    name: "Jina Reader",
    kind: "search",
    tier: "catalog-only",
    endpoint: "https://r.jina.ai",
    freeTierNote: "Free anonymous tier with rate limits.",
    docsUrl: "https://github.com/jina-ai/reader",
    callable: false,
  },
];

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return OMNI_CATALOG.find((e) => e.id === id);
}

export function catalogSummary() {
  const callable = OMNI_CATALOG.filter((e) => e.callable);
  const catalogOnly = OMNI_CATALOG.filter((e) => !e.callable);
  const freeModelHints = OMNI_CATALOG.reduce((sum, e) => sum + (e.freeModelCountHint ?? 0), 0);
  return {
    totalEntries: OMNI_CATALOG.length,
    callableNow: callable.length,
    catalogOnly: catalogOnly.length,
    freeModelHints,
    note: "Catalog entries marked catalog-only are documented free-tier providers. They become callable only after the owner adds them via ALO_CUSTOM_AI_PROVIDERS_JSON and verifies current terms. Model counts are planning hints, not guarantees.",
  };
}
