/**
 * Monid — the owner-gated tool marketplace ("OpenRouter for agent tools").
 *
 * Monid exposes 2,000+ tools across 72+ providers behind one base URL and one
 * key, over three verbs: `discover` and `inspect` are free, `run` is **billed
 * per call**. That asymmetry is the whole design of this module:
 *
 * ── What is free and what costs money ──────────────────────────────────────
 *  - `discover` / `inspect` / `wallet balance`: a normal `fetch`, no approval.
 *    They let the owner see the catalogue and the price *before* spending.
 *  - `run`: **never** called directly. It must go through `requestMonidRun()`,
 *    which enforces — in this order — the explicit owner switch, the shared
 *    payment guard (both AI switches), a configured key, and a recorded owner
 *    approval naming the exact provider+endpoint and the quoted price.
 *
 * ── Why it is not in the model chain ──────────────────────────────────────
 * Monid does not serve chat completions. It returns *data* for a tool call, so
 * wiring it into `DEFAULT_ORDER` (as if it were an LLM) would be a fake
 * integration: the app would "fall back" to an endpoint that cannot answer a
 * prompt. It is a tool surface an agent may propose, nothing more.
 *
 * ── Endpoints (verified against @monid-ai/cli 0.1.9 on 2026-11-27) ────────
 *   POST {base}/v1/discover        {query, limit?, minScore?, includeUnavailable?}
 *   POST {base}/v1/inspect         {provider, endpoint}
 *   POST {base}/v1/run             {provider, endpoint, input?: {body?, queryParams?, pathParams?}}
 *   GET  {base}/v1/runs/{runId}
 *   GET  {base}/v1/wallet/balance
 *   auth: `Authorization: Bearer <key>`, base default `https://api.monid.ai`
 *
 * Response bodies are NOT invented here. This module returns whatever the API
 * returned, trimmed, so a shape change upstream shows up as data instead of
 * being silently mis-parsed into a confident wrong answer.
 *
 * ── Rules that do not bend ────────────────────────────────────────────────
 *  - The key is a secret: it comes from the runtime config (encrypted at rest)
 *    or the real environment, and is never logged, echoed or returned.
 *  - PII is scrubbed before anything is sent, on the same code path the agent
 *    loop uses for external providers.
 *  - HTTPS only. A plain-http base is refused except for loopback, so a typo in
 *    the base URL cannot leak the key in clear text over the network.
 */

import { isExternalAiAllowed } from "@/lib/agentos/payment-guard";
import { scrubPii } from "@/lib/pii-filter";
import { runtimeEnvSync } from "@/lib/runtime-config";
import { estimateCallCost } from "@/lib/monid-catalog";

/** Enabled by default: the two operations below cost nothing. */
const DEFAULT_BASE_URL = "https://api.monid.ai";
const DISCOVER_TIMEOUT_MS = 15_000;
const INSPECT_TIMEOUT_MS = 15_000;
/** A billed run may be a long scrape; the owner sees the wait, so allow more. */
const RUN_TIMEOUT_MS = 120_000;
const MAX_PAYLOAD_CHARS = 4_000;

export type MonidErrorCode =
  | "not_enabled"
  | "payment_guard"
  | "missing_key"
  | "invalid_base_url"
  | "approval_required"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response";

export class MonidError extends Error {
  code: MonidErrorCode;
  constructor(code: MonidErrorCode, message: string) {
    super(message);
    this.name = "MonidError";
    this.code = code;
  }
}

function flag(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  try {
    return runtimeEnvSync(name);
  } catch {
    return undefined;
  }
}

/** `ALO_MONID_ENABLED` — the owner's switch for this integration (default off). */
export function isMonidEnabled(): boolean {
  return flag("ALO_MONID_ENABLED") === "true";
}

function apiKey(): string | undefined {
  const key = flag("MONID_API_KEY")?.trim();
  return key ? key : undefined;
}

/**
 * A base URL is only accepted when it is https, or plain http to a loopback
 * host (a self-hosted shim during testing). Anything else would send the Bearer
 * key in clear text.
 */
export function resolveMonidBaseUrl(raw?: string): string {
  const candidate = (raw ?? flag("MONID_BASE_URL") ?? DEFAULT_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new MonidError("invalid_base_url", `malformed MONID_BASE_URL: ${candidate.slice(0, 80)}`);
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new MonidError("invalid_base_url", "MONID_BASE_URL must be https (plain http only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MonidError("invalid_base_url", "MONID_BASE_URL must not carry credentials, a query or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

/** What the UI shows about the integration; never includes the key. */
export function monidStatus(): {
  enabled: boolean;
  keyConfigured: boolean;
  paymentGuardOpen: boolean;
  baseUrl: string | null;
  /** `discover` and `inspect` are free; only `run` is billed. */
  freeOperations: string[];
  billedOperations: string[];
  ready: { discover: boolean; run: boolean };
  reason: string;
} {
  let baseUrl: string | null = null;
  let baseProblem: string | null = null;
  try {
    baseUrl = resolveMonidBaseUrl();
  } catch (err) {
    baseProblem = err instanceof Error ? err.message : "invalid base url";
  }
  const enabled = isMonidEnabled();
  const keyConfigured = Boolean(apiKey());
  const paymentGuardOpen = isExternalAiAllowed();

  const discover = enabled && keyConfigured && Boolean(baseUrl);
  const run = discover && paymentGuardOpen;

  const reason = !enabled
    ? "ALO_MONID_ENABLED is not true — the integration is off."
    : entryBlocker(keyConfigured, baseUrl, baseProblem) ??
      (!paymentGuardOpen ? "discover/inspect work; run needs both owner AI switches." : "discover, inspect and approved runs are available.");

  return {
    enabled,
    keyConfigured,
    paymentGuardOpen,
    baseUrl,
    freeOperations: ["discover", "inspect", "wallet/balance"],
    billedOperations: ["run"],
    ready: { discover, run },
    reason,
  };
}

function entryBlocker(keyConfigured: boolean, baseUrl: string | null, baseProblem: string | null): string | null {
  if (baseProblem) return baseProblem;
  if (!baseUrl) return "no usable base URL";
  if (!keyConfigured) return "MONID_API_KEY is not set — nothing can be called yet.";
  return null;
}

async function post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  if (!isMonidEnabled()) throw new MonidError("not_enabled", "Monid integration is off (ALO_MONID_ENABLED)");
  const key = apiKey();
  if (!key) throw new MonidError("missing_key", "MONID_API_KEY is not configured");

  const base = resolveMonidBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Never let a proxy cache a billed/metered response.
      cache: "no-store",
    });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    throw new MonidError(
      aborted ? "timeout" : "network_error",
      aborted ? `Monid did not answer within ${Math.round(timeoutMs / 1000)}s` : "could not reach Monid",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // The key is never echoed: the upstream body is truncated and the status is
    // the thing the owner needs.
    throw new MonidError("http_error", `Monid returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MonidError("invalid_response", `Monid returned non-JSON (HTTP ${res.status})`);
  }
}

function trim(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_PAYLOAD_CHARS) return text;
  return `${text.slice(0, MAX_PAYLOAD_CHARS)}\n… (${text.length - MAX_PAYLOAD_CHARS} more characters not shown)`;
}

// ─── Free operations ────────────────────────────────────────────────────────

export interface MonidDiscoverArgs {
  query: string;
  limit?: number;
  minScore?: number;
  includeUnavailable?: boolean;
}

/**
 * Search the whole catalogue for endpoints that fit a task.
 * FREE. `limit` is clamped (1..50) so one call cannot dump a huge payload.
 */
export async function monidDiscover(args: MonidDiscoverArgs): Promise<{ ok: true; payload: unknown; text: string }> {
  const query = scrubPii(String(args.query ?? "")).redacted.slice(0, 500).trim();
  if (query.length < 3) throw new MonidError("invalid_response", "discover needs a query of at least 3 characters");
  const body: Record<string, unknown> = { query };
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
    body.limit = Math.max(1, Math.min(50, Math.trunc(args.limit)));
  }
  if (typeof args.minScore === "number" && Number.isFinite(args.minScore)) body.minScore = args.minScore;
  if (args.includeUnavailable) body.includeUnavailable = true;

  const payload = await post("/v1/discover", body, DISCOVER_TIMEOUT_MS);
  return { ok: true, payload, text: trim(payload) };
}

/** Read one endpoint's input schema and price. FREE. */
export async function monidInspect(provider: string, endpoint: string): Promise<{ ok: true; payload: unknown; text: string }> {
  const p = String(provider ?? "").trim();
  const e = String(endpoint ?? "").trim();
  if (!p || !e) throw new MonidError("invalid_response", "inspect needs both a provider and an endpoint id");
  const payload = await post("/v1/inspect", { provider: p, endpoint: e }, INSPECT_TIMEOUT_MS);
  return { ok: true, payload, text: trim(payload) };
}

// ─── Billed operation (approval-gated) ──────────────────────────────────────

export interface MonidRunRequest {
  provider: string;
  endpoint: string;
  /** The tool's input, e.g. {body: {...}} or {queryParams: {...}} — from inspect. */
  input?: Record<string, unknown>;
  /** The price quoted by `inspect`, recorded with the approval. */
  quotedPrice?: string;
  /** The owner's approval id (from the actions panel). Required. */
  approvalId?: string;
}

/** What the owner must be shown before a billed call is even requested. */
export interface MonidRunProposal {
  provider: string;
  endpoint: string;
  quotedPrice: string | null;
  /** Offline estimate from the declared rates; null when unreadable. */
  estimatedUsd: number | null;
  /** The sentence to show the owner next to the price. */
  estimateText: string;
  input: Record<string, unknown> | null;
  /** Always true for `run`: every call spends the owner's balance. */
  billed: true;
  warnings: string[];
}

export function proposeMonidRun(req: MonidRunRequest): MonidRunProposal {
  const p = String(req.provider ?? "").trim();
  const e = String(req.endpoint ?? "").trim();
  if (!p || !e) throw new MonidError("invalid_response", "a run needs a provider and an endpoint id");
  const input = req.input && typeof req.input === "object" ? req.input : null;

  const warnings: string[] = [];
  if (!req.quotedPrice) {
    warnings.push("No price was quoted — run `inspect` first so the owner approves an actual cost, not a guess.");
  }
  if (!input) {
    warnings.push("No input was supplied — some endpoints require body/queryParams/pathParams from `inspect`.");
  }
  if (!isExternalAiAllowed()) {
    warnings.push("Both owner AI switches are off, so an approval would still be refused.");
  }

  const estimate = estimateCallCost(p, e, input ?? undefined);

  return {
    provider: p,
    endpoint: e,
    quotedPrice: req.quotedPrice ?? null,
    estimatedUsd: estimate.usd,
    estimateText: estimate.text,
    input,
    billed: true,
    warnings,
  };
}

/**
 * Execute one billed endpoint call.
 *
 * Refuses unless ALL of these hold:
 *   1. `ALO_MONID_ENABLED=true`             (this integration is on)
 *   2. `isExternalAiAllowed()`              (both owner AI switches are on)
 *   3. `MONID_API_KEY` is configured        (there is a wallet to spend)
 *   4. an approval id was supplied          (a human said yes to this exact call)
 *
 * There is deliberately no "skip approval" flag: a code path that can spend
 * money unattended is exactly what this repository must not contain.
 */
export async function runMonidEndpoint(req: MonidRunRequest): Promise<{ ok: true; payload: unknown; text: string; billed: true }> {
  const proposal = proposeMonidRun(req);

  if (!isMonidEnabled()) throw new MonidError("not_enabled", "Monid integration is off (ALO_MONID_ENABLED)");
  if (!isExternalAiAllowed()) {
    throw new MonidError("payment_guard", "both owner AI switches must be true before a billed call");
  }
  if (!apiKey()) throw new MonidError("missing_key", "MONID_API_KEY is not configured");
  if (!req.approvalId?.trim()) {
    throw new MonidError(
      "approval_required",
      `billed call not started: ask the owner to approve ${proposal.provider}#${proposal.endpoint}${proposal.quotedPrice ? ` (${proposal.quotedPrice})` : ""}`,
    );
  }

  const body: Record<string, unknown> = { provider: proposal.provider, endpoint: proposal.endpoint };
  if (proposal.input) body.input = proposal.input;

  const payload = await post("/v1/run", body, RUN_TIMEOUT_MS);
  return { ok: true, payload, text: trim(payload), billed: true };
}

/** Remaining balance, so the owner can see the cost side before approving. FREE. */
export async function monidBalance(): Promise<{ ok: true; payload: unknown; text: string }> {
  if (!isMonidEnabled()) throw new MonidError("not_enabled", "Monid integration is off (ALO_MONID_ENABLED)");
  const key = apiKey();
  if (!key) throw new MonidError("missing_key", "MONID_API_KEY is not configured");
  const base = resolveMonidBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/v1/wallet/balance`, {
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS),
    });
  } catch {
    throw new MonidError("network_error", "could not reach Monid");
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new MonidError("http_error", `Monid returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    const payload = JSON.parse(text);
    return { ok: true, payload, text: trim(payload) };
  } catch {
    throw new MonidError("invalid_response", `Monid returned non-JSON (HTTP ${res.status})`);
  }
}
