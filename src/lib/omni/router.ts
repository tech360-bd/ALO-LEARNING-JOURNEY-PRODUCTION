// ALO Learning Journey — OmniRouter (server-only).
//
// Single-active sequential failover router over free-tier providers.
// Professional protocol (see docs/OMNI-ROUTING.md):
//   1. Local Ollama is tried first (no API cost, private data never
//      leaves the server) — the documented local-first policy.
//   2. External routing reuses the repo's registry-driven chain
//      (src/lib/ai-chain.ts -> chainChat): AiModelProvider table
//      (owner-configured providers, priority order) → Z.AI → Groq →
//      Gemini → OpenRouter (free models only) → Ollama. Providers are
//      tried SEQUENTIALLY, one at a time — never in parallel. This is
//      the "not all AI systems active at the same time" rule,
//      additionally enforced by an in-flight lock in this module.
//   3. Free-tier guard: the payment guard (isExternalAiAllowed) blocks
//      all non-local providers unless the owner enabled both switches;
//      OpenRouter only serves free models.
//   4. Circuit breaker: a provider with repeated failures enters
//      cooldown and is reported in the dashboard.
//   5. Health is persisted to OmniProviderHealth when the DB is
//      available; otherwise kept in memory (degraded but functional).
//
// Data policy: this module is only ever called with the owner's own
// system-management text. Student/family/personal data must never be
// routed through it (same policy as src/lib/ai.ts).

import { generateLocalChatJson, getPrivateLocalBaseUrl } from "@/lib/local-models";
import { chainChat } from "@/lib/ai-chain";
import { getExternalAiStatus, orderedProviders } from "@/lib/external-ai";
import { db } from "@/lib/db";

export interface OmniChatRequest {
  system: string;
  user: string;
  /** Task label for health attribution, e.g. "super-admin-chat". */
  task?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface OmniChatResult {
  content: string;
  /** Provider that actually served the answer, e.g. "groq". */
  provider: string;
  /** Model id reported by the provider. */
  model: string;
  /** True when no real model answered (should not happen: we throw instead). */
  degraded: boolean;
  latencyMs: number;
  tried: string[];
}

interface HealthRecord {
  providerId: string;
  status: "unknown" | "healthy" | "degraded" | "down" | "cooldown";
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

// In-memory health (primary when DB unavailable; merged with DB on read).
const memHealth = new Map<string, HealthRecord>();
// In-memory cooldowns: providerId -> cooldown-until timestamp.
const cooldowns = new Map<string, number>();
// Single-active lock: at most one external call in flight per process.
let externalInFlight = false;
// Preferred provider override (persisted to OmniRouterState when possible).
let preferredProvider: string | null = null;

function memRecord(providerId: string): HealthRecord {
  let r = memHealth.get(providerId);
  if (!r) {
    r = {
      providerId,
      status: "unknown",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastLatencyMs: null,
      lastError: null,
      lastCheckedAt: null,
    };
    memHealth.set(providerId, r);
  }
  return r;
}

function isCoolingDown(providerId: string): boolean {
  const until = cooldowns.get(providerId);
  if (!until) return false;
  if (Date.now() < until) return true;
  cooldowns.delete(providerId); // half-open: allow one probe
  return false;
}

async function persistHealth(r: HealthRecord): Promise<void> {
  try {
    await db.omniProviderHealth.upsert({
      where: { providerId: r.providerId },
      create: {
        providerId: r.providerId,
        status: r.status,
        consecutiveFailures: r.consecutiveFailures,
        consecutiveSuccesses: r.consecutiveSuccesses,
        lastLatencyMs: r.lastLatencyMs,
        lastError: r.lastError,
        lastCheckedAt: r.lastCheckedAt ? new Date(r.lastCheckedAt) : null,
      },
      update: {
        status: r.status,
        consecutiveFailures: r.consecutiveFailures,
        consecutiveSuccesses: r.consecutiveSuccesses,
        lastLatencyMs: r.lastLatencyMs,
        lastError: r.lastError,
        lastCheckedAt: r.lastCheckedAt ? new Date(r.lastCheckedAt) : null,
      },
    });
  } catch {
    // DB unavailable (pre-migration / local fallback) — memory record stands.
  }
}

function recordSuccess(providerId: string, latencyMs: number): void {
  const r = memRecord(providerId);
  r.status = "healthy";
  r.consecutiveSuccesses += 1;
  r.consecutiveFailures = 0;
  r.lastLatencyMs = latencyMs;
  r.lastError = null;
  r.lastCheckedAt = new Date().toISOString();
  cooldowns.delete(providerId);
  void persistHealth(r);
}

function recordFailure(providerId: string, error: string): void {
  const r = memRecord(providerId);
  r.consecutiveFailures += 1;
  r.consecutiveSuccesses = 0;
  r.lastError = error.slice(0, 500);
  r.lastCheckedAt = new Date().toISOString();
  if (r.consecutiveFailures >= FAILURE_THRESHOLD) {
    r.status = "cooldown";
    cooldowns.set(providerId, Date.now() + COOLDOWN_MS);
  } else if (r.consecutiveFailures >= 2) {
    r.status = "degraded";
  } else {
    r.status = "down";
  }
  void persistHealth(r);
}

async function loadPreferredProvider(): Promise<string | null> {
  if (preferredProvider) return preferredProvider;
  try {
    const row = await db.omniRouterState.findUnique({ where: { key: "preferred_provider" } });
    if (row?.value) {
      preferredProvider = row.value;
      return preferredProvider;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Pin (or clear) the preferred provider. The pin selects the model hint
 * passed to the env-var chain and is surfaced + audited in the dashboard.
 * Full failover order = registry priorities (AiModelProvider) → built-in
 * chain — see docs/OMNI-ROUTING.md.
 */
export async function setPreferredProvider(providerId: string | null): Promise<void> {
  preferredProvider = providerId;
  try {
    if (providerId) {
      await db.omniRouterState.upsert({
        where: { key: "preferred_provider" },
        create: { key: "preferred_provider", value: providerId },
        update: { value: providerId },
      });
    } else {
      await db.omniRouterState.delete({ where: { key: "preferred_provider" } }).catch(() => undefined);
    }
  } catch {
    // memory-only when DB unavailable
  }
}

/**
 * Route one chat completion through the omni chain.
 * Order: local Ollama first → registry/env-var chain (chainChat).
 * Sequential only; never parallel. Throws when no real model answers.
 */
export async function routeChat(req: OmniChatRequest): Promise<OmniChatResult> {
  const start = Date.now();
  const tried: string[] = [];

  // 1) Local Ollama first (private, free, no data leaves the server).
  tried.push("local-ollama");
  try {
    const local = await generateLocalChatJson(req.system, req.user, req.timeoutMs ?? 30_000);
    if (!local.model.includes("(built-in-local)")) {
      recordSuccess("local-ollama", Date.now() - start);
      return {
        content: local.content,
        provider: "local-ollama",
        model: local.model,
        degraded: false,
        latencyMs: Date.now() - start,
        tried,
      };
    }
    recordFailure("local-ollama", "local model unavailable (template fallback)");
  } catch (err) {
    recordFailure("local-ollama", err instanceof Error ? err.message : "local model error");
  }

  // 2) External free providers — ONE at a time, sequential failover.
  if (externalInFlight) {
    throw new Error("omni_router_busy: another provider call is in flight (single-active rule)");
  }
  externalInFlight = true;
  try {
    const status = getExternalAiStatus();
    if (!status.enabled) {
      throw new Error(
        "external_ai_blocked_by_payment_guard: both owner switches (ALO_PAID_AI_API_ALLOWED + ALO_OWNER_APPROVED_PAID_AI_API) must be true"
      );
    }

    // Preferred-provider hint for the env-var chain (model selection).
    const preferred = await loadPreferredProvider();
    const preferredModel = preferred ? `${preferred === "local-ollama" ? "ollama" : preferred}:` : undefined;

    tried.push(...orderedProviders().map((p) => p.id));
    const chain = await chainChat(
      [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      { maxTokens: req.maxTokens ?? 1200, temperature: 0.4, preferredModel },
    );

    if (chain.fallback) {
      // Rule-based fallback = no real model answered. Record + throw so
      // the caller can surface an honest "AI unavailable" message.
      for (const id of tried) recordFailure(id, "no real model answered (chain fell back to rule-based)");
      throw new Error("omni_router_no_provider_answered");
    }

    const providerId = chain.provider === "ollama" ? "local-ollama" : chain.provider;
    recordSuccess(providerId, chain.durationMs);
    return {
      content: chain.text,
      provider: providerId,
      model: chain.model,
      degraded: false,
      latencyMs: Date.now() - start,
      tried,
    };
  } finally {
    externalInFlight = false;
  }
}

/**
 * Streaming variant of routeChat.
 *
 * - Local Ollama: true incremental token streaming (Ollama NDJSON
 *   `stream:true`). Each token is delivered to `onToken` as it arrives.
 * - External free providers: the shared chain is non-streaming, so the full
 *   answer is delivered in small word-boundary chunks (honestly labelled
 *   `streamMode: "chunked"`). Both paths honor `signal` for cancellation.
 *
 * Returns the same shape as routeChat plus `streamMode`. Throws when no real
 * model answers (same policy as routeChat).
 */
export interface OmniChatStreamResult extends OmniChatResult {
  streamMode: "tokens" | "chunked";
}

export async function routeChatStream(
  req: OmniChatRequest,
  onToken: (text: string) => void,
  signal?: AbortSignal
): Promise<OmniChatStreamResult> {
  const start = Date.now();
  const tried: string[] = [];
  const timeoutMs = req.timeoutMs ?? 30_000;

  if (signal?.aborted) throw new Error("aborted");

  // 1) Local Ollama — real token streaming (private, free, first).
  tried.push("local-ollama");
  try {
    const base = getPrivateLocalBaseUrl("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    const model = process.env.OLLAMA_MODEL?.trim() || "qwen2.5:7b";
    const url = new URL("/api/chat", base.toString());
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(Math.max(1_000, Math.min(timeoutMs, 300_000))),
      body: JSON.stringify({
        model,
        stream: true,
        format: "json",
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        options: { temperature: 0.7, num_predict: req.maxTokens ?? 1200 },
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Local Ollama returned HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let done = false;
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let json: any;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        if (json.error) throw new Error(`Local Ollama error: ${String(json.error).slice(0, 180)}`);
        const chunk = typeof json.message?.content === "string" ? json.message.content : "";
        if (chunk) {
          content += chunk;
          onToken(chunk);
        }
        if (json.done) done = true;
      }
    }
    if (!content.trim()) throw new Error("Local Ollama returned an empty stream");
    recordSuccess("local-ollama", Date.now() - start);
    return {
      content,
      provider: "local-ollama",
      model,
      degraded: false,
      latencyMs: Date.now() - start,
      tried,
      streamMode: "tokens",
    };
  } catch (err) {
    if (signal?.aborted) throw new Error("aborted");
    recordFailure("local-ollama", err instanceof Error ? err.message : "local stream error");
  }

  // 2) External free providers — non-streaming chain, chunked delivery.
  const plain = await routeChat(req);
  // Word-boundary chunks (~200 chars) for progressive rendering.
  const words = plain.content.split(/(\s+)/);
  let chunk = "";
  for (const w of words) {
    chunk += w;
    if (chunk.length >= 160 && /\s$/.test(chunk)) {
      onToken(chunk);
      chunk = "";
    }
  }
  if (chunk) onToken(chunk);
  return { ...plain, streamMode: "chunked" };
}

export interface RouterStatus {
  singleActive: true;
  externalInFlight: boolean;
  preferredProvider: string | null;
  chainOrder: string[];
  external: ReturnType<typeof getExternalAiStatus>;
  local: { model: string; baseUrl: string } | null;
  health: HealthRecord[];
  cooldowns: Array<{ providerId: string; retryAfterMs: number }>;
}

export async function getRouterStatus(): Promise<RouterStatus> {
  const external = getExternalAiStatus();
  const chainOrder = orderedProviders().map((p) => p.id);
  const preferred = await loadPreferredProvider();

  // Merge DB health with memory health (memory wins — it is fresher).
  let dbHealth: HealthRecord[] = [];
  try {
    const rows = await db.omniProviderHealth.findMany({ orderBy: { providerId: "asc" } });
    dbHealth = (rows as any[]).map((r) => ({
      providerId: r.providerId,
      status: r.status,
      consecutiveFailures: r.consecutiveFailures,
      consecutiveSuccesses: r.consecutiveSuccesses,
      lastLatencyMs: r.lastLatencyMs,
      lastError: r.lastError,
      lastCheckedAt: r.lastCheckedAt ? new Date(r.lastCheckedAt).toISOString() : null,
    }));
  } catch {
    dbHealth = [];
  }
  const merged = new Map<string, HealthRecord>();
  for (const r of dbHealth) merged.set(r.providerId, r);
  for (const [id, r] of memHealth) merged.set(id, r);

  let local: RouterStatus["local"] = null;
  try {
    const s = await (await import("@/lib/local-models")).getLocalAiStatus();
    const anyS = s as any;
    local = { model: anyS?.ollama?.model || anyS?.model || "unknown", baseUrl: anyS?.ollama?.baseUrl || anyS?.baseUrl || "" };
  } catch {
    local = null;
  }

  const now = Date.now();
  const cooldownList = [...cooldowns.entries()]
    .filter(([, until]) => until > now)
    .map(([providerId, until]) => ({ providerId, retryAfterMs: until - now }));

  return {
    singleActive: true,
    externalInFlight,
    preferredProvider: preferred,
    chainOrder,
    external,
    local,
    health: [...merged.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
    cooldowns: cooldownList,
  };
}

/** Test hook: reset in-memory router state (used by unit tests). */
export function _resetRouterState(): void {
  memHealth.clear();
  cooldowns.clear();
  externalInFlight = false;
  preferredProvider = null;
}
