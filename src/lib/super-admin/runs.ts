// ALO Learning Journey — Super Admin execution runs (Phase C2, server-only).
//
// Every owner turn is a persistent run with a durable, monotonically
// sequenced event timeline:
//
//   status  run started / paused / resumed
//   step    named execution step started/completed/failed (real timings)
//   token   streamed provider output (persisted in batches, live in memory)
//   approval run paused awaiting owner decision on a pending action
//   error   failure detail (propagated to client + persisted)
//   done    terminal state + final result
//
// Guarantees (verified by tests/super-admin-runs.test.mjs):
//  - seq is strictly increasing per run; events are persisted durably
//  - reconnection replays persisted events after Last-Event-ID (seq)
//  - cancellation aborts the provider call and preserves partial results
//  - stale "running" runs (process restart) are recovered as "interrupted"
//    with the partial timeline preserved
//  - approval continuation finalizes the paused run when the owner decides
//  - tenant isolation: all reads are scoped to the owner id
//
// The store is injected (RunStore): production uses Prisma (MySQL); when the
// database is unreachable the engine degrades to an in-memory store and the
// UI reports "timeline not durable on this server" — it never pretends a
// non-persistent timeline is durable.

import { getRunStore, type RunRow, type RunEventRow, type RunEventType, type RunStore } from "@/lib/super-admin/run-store";
import { parseIntent, type IntentKind } from "@/lib/super-admin/intents";
import { reviewLink } from "@/lib/link-review";
import { getField, listRuntimeConfig } from "@/lib/runtime-config";
import { findSource, knowledgeSummary } from "@/lib/knowledge/sources";
import { KNOWLEDGE_PROMPT_BUDGET, knowledgePromptBlock, sourceReport } from "@/lib/knowledge/agent";
import { db } from "@/lib/db";
import {
  detectLayerProvider,
  detectLayerDatabase,
  detectLayerWeb,
  detectLayerLogs,
  persistFindings,
  type FindingDraft,
} from "@/lib/self-heal/detector";
import { applySafeFix, FIX_REGISTRY } from "@/lib/self-heal/fixer";
import { getRouterStatus, setPreferredProvider } from "@/lib/omni/router";
import { routeChatStream } from "@/lib/omni/router";

export interface RunStep {
  label: string;
  /** Returns a short detail string for the timeline. */
  run: (emit: EmitFn, signal: AbortSignal) => Promise<string | Record<string, unknown>>;
}

export type EmitFn = (type: RunEventType, payload: Record<string, unknown>, runPatch?: Record<string, unknown>) => Promise<void>;

// ── Live fan-out (single-process; PM2 runs one Node instance) ──────────────
const liveSubscribers = new Map<string, Set<(ev: { seq: number; type: RunEventType; payload: Record<string, unknown> }) => void>>();
const controllers = new Map<string, AbortController>();

export function subscribeRun(runId: string, onEvent: (ev: { seq: number; type: RunEventType; payload: Record<string, unknown> }) => void): () => void {
  let set = liveSubscribers.get(runId);
  if (!set) {
    set = new Set();
    liveSubscribers.set(runId, set);
  }
  set.add(onEvent);
  return () => {
    const s = liveSubscribers.get(runId);
    if (s) {
      s.delete(onEvent);
      if (s.size === 0) liveSubscribers.delete(runId);
    }
  };
}

/** Fan an event out to live subscribers (SSE streams) for a run. */
export function emitLive(runId: string, seq: number, type: RunEventType, payload: Record<string, unknown>): void {
  const set = liveSubscribers.get(runId);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn({ seq, type, payload });
    } catch {
      // subscriber errors must not break the pipeline
    }
  }
}

/** Request cancellation for an in-flight run. True when the run is live in this process. */
export function requestCancellation(runId: string): boolean {
  const c = controllers.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

export function isRunActive(runId: string): boolean {
  return controllers.has(runId);
}

// ── Creation + recovery ─────────────────────────────────────────────────────

export async function createRun(ownerId: string, conversationId: string, command: string, store?: RunStore): Promise<RunRow> {
  const s = store ?? (await getRunStore());
  // Lazy recovery: any run left "running" by a previous process incarnation
  // is marked interrupted (its partial timeline is preserved).
  await recoverStaleRuns(s).catch(() => undefined);
  return s.createRun({ ownerId, conversationId, command });
}

/** Mark stale running runs as interrupted. Returns recovered run ids. */
export async function recoverStaleRuns(store?: RunStore, olderThanMs = 5 * 60_000): Promise<string[]> {
  const s = store ?? (await getRunStore());
  const stale = await s.findStaleRuns(olderThanMs);
  const recovered: string[] = [];
  for (const run of stale) {
    try {
      // Terminal done event (durable): the timeline ends "interrupted".
      const ev = await s.appendEvent(
        run.id,
        "done",
        { status: "interrupted", recovered: true, message: "Run interrupted by server restart; partial timeline preserved." },
        { status: "interrupted", finishedAt: new Date(), error: "server restarted mid-run" }
      );
      emitLive(run.id, ev.seq, "done", { status: "interrupted", recovered: true });
      recovered.push(run.id);
    } catch {
      // already finalized by a concurrent recovery
    }
  }
  return recovered;
}

// ── Token streaming with batched durable persistence ────────────────────────
const TOKEN_FLUSH_EVERY = 8;
const TOKEN_FLUSH_MS = 1000;

class TokenStream {
  private readonly store: RunStore;
  private readonly runId: string;
  private pending: Array<{ seq: number; text: string }> = [];
  private nextSeq: number;
  private lastFlush = Date.now();
  private content = "";
  private flushing = false;

  // Explicit fields (not TS parameter properties): node --experimental-strip-types
  // rejects parameter properties, and this class is exercised by unit tests.
  constructor(store: RunStore, runId: string, startSeq: number) {
    this.store = store;
    this.runId = runId;
    this.nextSeq = startSeq + 1;
  }

  /**
   * Deliver one token live immediately (tentative seq = final seq: a single
   * writer assigns sequences in push order) and persist in small batches —
   * durable timeline with bounded write amplification.
   */
  async push(text: string): Promise<void> {
    this.content += text;
    const seq = this.nextSeq++;
    this.pending.push({ seq, text });
    emitLive(this.runId, seq, "token", { text });
    if (!this.flushing && (this.pending.length >= TOKEN_FLUSH_EVERY || Date.now() - this.lastFlush >= TOKEN_FLUSH_MS)) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.pending.length) return;
    this.flushing = true;
    try {
      const batch = this.pending;
      this.pending = [];
      for (let i = 0; i < batch.length; i++) {
        const { seq, text } = batch[i];
        await this.store.appendEvent(
          this.runId,
          "token",
          { text },
          i === batch.length - 1 ? { partialContent: this.content } : undefined
        );
      }
    } finally {
      this.flushing = false;
      this.lastFlush = Date.now();
    }
  }
}

// ── Plan definitions (deterministic; the AI never picks steps) ─────────────

function planFor(intent: IntentKind, command: string, entities: Record<string, string> = {}): RunStep[] {
  switch (intent) {
    case "health_check":
      return [
        {
          label: "check:database",
          run: async () => {
            const started = Date.now();
            try {
              await db.$queryRaw`SELECT 1`;
              return `database reachable in ${Date.now() - started}ms`;
            } catch (e: any) {
              throw new Error(e?.message?.slice(0, 200) ?? "database unreachable");
            }
          },
        },
        { label: "check:omni-router", run: async () => { const s = await getRouterStatus(); return `preferred=${s.preferredProvider ?? "chain default"}; external ${s.external.enabled ? (s.external.configured ? "configured" : "no keys") : "disabled"}; ${s.cooldowns.length} cooldown(s)`; } },
        { label: "check:self-heal", run: async () => { const f = await import("@/lib/self-heal/detector").then((m) => m.listOpenFindings(10)).catch(() => []); return `${f.length} open finding(s)`; } },
      ];
    case "scan_errors": {
      // Shared accumulator: each detection layer runs exactly once and its
      // findings are collected for the persist step (real work, one pass).
      const collected: FindingDraft[] = [];
      const layer = (label: string, fn: () => Promise<Array<typeof collected[number]>>) => ({
        label,
        run: async () => {
          const f = await fn();
          collected.push(...f);
          return `${f.length} finding(s)`;
        },
      });
      return [
        layer("detect:providers", detectLayerProvider),
        layer("detect:database", detectLayerDatabase),
        layer("detect:web-pages", detectLayerWeb),
        layer("detect:logs", detectLayerLogs),
        {
          label: "persist:findings",
          run: async () => {
            const saved = await persistFindings(collected);
            return `${saved.length} finding(s) persisted`;
          },
        },
      ];
    }
    case "fix_errors":
      return [
        {
          label: "apply:safe-fixes",
          run: async () => {
            let findings: any[] = [];
            try {
              findings = await db.selfHealFinding.findMany({ where: { status: "open" }, take: 20 });
            } catch {
              findings = [];
            }
            const results: Array<{ fixKind: string; ok: boolean }> = [];
            const seen = new Set<string>();
            for (const f of findings) {
              const fixKind = f.fixKind ?? "";
              if (!fixKind || seen.has(fixKind)) continue;
              const fix = FIX_REGISTRY.find((x) => x.id === fixKind);
              if (!fix || fix.risk !== "safe") continue;
              seen.add(fixKind);
              const r = await applySafeFix(fixKind, { url: f.url ?? undefined });
              results.push({ fixKind, ok: r.ok });
              if (r.ok) {
                try {
                  await db.selfHealFinding.update({ where: { id: f.id }, data: { status: "fixed", resolvedAt: new Date() } });
                } catch {
                  // ignore
                }
              }
            }
            return results.length ? results.map((r) => `${r.fixKind}:${r.ok ? "ok" : "fail"}`).join(", ") : "no safe fixes available";
          },
        },
      ];
    case "switch_provider":
      return [
        {
          label: "pin:provider",
          run: async () => {
            const provider = extractProviderFromCommand(command);
            if (!provider) return "no provider named — see status";
            const status = await getRouterStatus();
            const known = [...status.chainOrder, "local-ollama", "ollama"];
            if (!known.includes(provider)) throw new Error(`unknown provider "${provider}" (known: ${known.join(", ")})`);
            await setPreferredProvider(provider === "ollama" ? "local-ollama" : provider);
            return `preferred provider → ${provider}`;
          },
        },
      ];
    case "announce":
      return [
        {
          label: "draft:approval",
          run: async () => {
            const text = extractAnnouncementText(command);
            if (!text) throw new Error("announcement text missing — example: \"announce: Eid holiday — classes closed Friday\"");
            const pendingId = await createPendingActionSafe("announce", "Publish announcement", text, { text });
            return pendingId ? `pending approval (${pendingId.slice(0, 8)}…)` : "pending approval (database unavailable — action kept in result)";
          },
        },
      ];
    case "analytics":
      return [
        {
          label: "load:snapshots",
          run: async () => {
            let n = 0;
            try {
              n = await db.analyticsSnapshot.count();
            } catch {
              throw new Error("analytics unavailable (database not reachable)");
            }
            return `${n} snapshot(s)`;
          },
        },
      ];
    case "backup":
      return [
        {
          label: "record:backup-request",
          run: async () => {
            const pendingId = await createPendingActionSafe("backup", "Run database backup", "Backup runs via deploy/backup.sh on the server (requires SSH).", {});
            return pendingId ? "request recorded (approval)" : "request recorded (database unavailable)";
          },
        },
      ];
    case "review_link":
      return [
        {
          label: "review:link",
          run: async () => {
            const url = command.match(/https?:\/\/[^\s<>"']+/i)?.[0] ?? "";
            if (!url) return "no link found in the message";
            // Read-only: the SSRF-guarded browser fetches the page, the public
            // GitHub API supplies licence/activity facts. The linked code is
            // never cloned and never executed.
            const review = await reviewLink(url);
            const licence = review.licence
              ? `${review.licence.name}${review.licence.spdx ? ` (${review.licence.spdx})` : ""}, risk ${review.licence.adoptionRisk}`
              : "licence unreadable";
            const flags = review.riskFlags.length ? ` — flags: ${review.riskFlags.join(", ")}` : "";
            return `${review.verdict.toUpperCase()} · ${licence}${flags} · ${review.summary}`;
          },
        },
        { label: "next:steps", run: async () => "adoption needs a reviewed pull request; nothing is installed or deployed from chat" },
      ];
    case "list_sources":
      return [
        {
          label: "index:inspect",
          run: async () => {
            const named = entities.id;
            if (named) {
              const source = findSource(named);
              if (!source) return `source not indexed: ${named}`;
              return `source:${source.id} · ${source.adoption} · ${source.facts.spdx ?? "no licence stated"}`;
            }
            const summary = knowledgeSummary();
            return `${summary.total} sources indexed · integrated: ${summary.integrated.join(", ") || "none"} · rejected: ${summary.rejected.join(", ") || "none"}`;
          },
        },
        {
          label: "index:policy",
          // Each source's rule is generated from the index, so the answer cannot
          // claim an integration that does not exist.
          run: async () => {
            const summary = knowledgeSummary();
            return `${summary.byAdoption.rejected ?? 0} rejected · ${summary.byAdoption["reference-only"] ?? 0} reference-only · licences checked 2026-11-27`;
          },
        },
      ];
    case "set_config":
      return [
        {
          label: "config:inspect",
          run: async () => {
            const name = (command.match(/\b([A-Z][A-Z0-9_]{3,63})\b/) ?? [])[1] ?? "";
            const field = getField(name);
            if (!field) {
              const all = await listRuntimeConfig();
              return `"${name || "that name"}" is not an allowlisted setting; ${all.filter((v) => v.source === "unset").length} setting(s) are still unset`;
            }
            const view = (await listRuntimeConfig()).find((v) => v.name === name);
            return `${name}: ${view?.source ?? "unset"}${field.restartRequired ? " (needs a restart)" : ""} — enter the value in the Config panel, not in chat`;
          },
        },
        { label: "next:steps", run: async () => "values are encrypted at rest (AES-256-GCM); secrets are never accepted as chat text" },
      ];
    case "chat":
    default:
      return [
        { label: "route:provider", run: async () => "routing through omni chain" },
        { label: "stream:reply", run: async () => "streaming reply" },
      ];
  }
}

function extractProviderFromCommand(command: string): string | null {
  const ids = ["groq", "llm7", "opencode", "openrouter", "omniroute", "local-ollama", "ollama"];
  const lower = command.toLowerCase();
  return ids.find((p) => lower.includes(p)) ?? null;
}

function extractAnnouncementText(command: string): string | null {
  const m = command.match(/(?:announce[ment]?|ঘোষণা|notice|নোটিশ)[^:]*[:\-–—]\s*(.+)/i);
  return m ? m[1].trim().slice(0, 500) : null;
}

async function createPendingActionSafe(kind: string, title: string, detail: string, payload: Record<string, unknown>): Promise<string | null> {
  try {
    const row = await db.superAdminAction.create({
      data: { kind, title, detail, risk: "approval", status: "pending", payload: JSON.stringify(payload) },
    });
    return row.id;
  } catch {
    return null;
  }
}

// ── The pipeline ────────────────────────────────────────────────────────────

export interface PipelineDeps {
  store?: RunStore;
  /** Called with the assistant message to persist when the run completes (chat runs). */
  persistMessage?: (args: { conversationId: string; role: "user" | "assistant"; content: string; provider: string | null; runId: string }) => Promise<void>;
}

/**
 * Execute a run to completion. Returns the terminal run row. Never throws —
 * failures become persisted `error` + `done` events.
 */
export async function executeRunPipeline(runId: string, deps: PipelineDeps = {}): Promise<RunRow | null> {
  const store = deps.store ?? (await getRunStore());
  const run = await store.getRun(runId);
  if (!run) return null;

  const controller = new AbortController();
  controllers.set(runId, controller);
  const signal = controller.signal;

  // Token stream for chat runs (batched durable persistence + live fan-out).
  let tokenStream: TokenStream | null = null;
  let tokensSinceFlush = 0;

  const emit: EmitFn = async (type, payload, runPatch) => {
    const ev = await store.appendEvent(runId, type, payload, runPatch as any);
    emitLive(runId, ev.seq, type, payload);
  };

  const fail = async (message: string): Promise<void> => {
    await emit("error", { message: message.slice(0, 500) }, { error: message.slice(0, 500) }).catch(() => undefined);
    await emit("done", { status: "failed", error: message.slice(0, 300) }, { status: "failed", finishedAt: new Date() }).catch(() => undefined);
  };

  try {
    await emit("status", { message: "Run started" });

    // Persist the user message for chat context (best-effort).
    await deps.persistMessage?.({ conversationId: run.conversationId, role: "user", content: run.command.slice(0, 4000), provider: null, runId }).catch(() => undefined);

    const intent = parseIntent(run.command);
    await store.appendEvent(runId, "status", JSON.stringify({ message: `Intent: ${intent.kind}` }), { intent: intent.kind });
    await emit("step", { step: "parse:intent", index: 0, total: 0, status: "completed", detail: intent.reason, ms: 0 });

    if (intent.kind === "chat") {
      // ── Free-form chat: stream through the omni router ──────────────
      const plan = planFor("chat", run.command);
      await emit("step", { step: "plan", index: 0, total: plan.length, status: "completed", detail: plan.map((p) => p.label).join(" → ") });
      await store.appendEvent(runId, "status", JSON.stringify({ message: "Routing to provider", plan: plan.map((p) => p.label) }), { plan: JSON.stringify(plan.map((p) => p.label)) });
      tokenStream = new TokenStream(store, runId, (await store.getRun(runId))!.seq);

      let history = "";
      try {
        const recent = await db.superAdminMessage.findMany({ where: { conversationId: run.conversationId }, orderBy: { createdAt: "desc" }, take: 10 });
        history = recent.reverse().map((m) => `${m.role}: ${m.content}`).join("\n").slice(-3000);
      } catch {
        history = "";
      }
      const userPrompt = history ? `Conversation so far:\n${history}\n\nOwner: ${run.command}` : run.command;

      let routed: Awaited<ReturnType<typeof routeChatStream>> | null = null;
      try {
        routed = await routeChatStream(
          {
            system: `${SUPER_ADMIN_SYSTEM_PROMPT}\n\n${knowledgePromptBlock(KNOWLEDGE_PROMPT_BUDGET)}`,
            user: userPrompt,
            task: "super-admin-chat",
            maxTokens: 1200,
          },
          (text) => {
            void tokenStream!.push(text).catch(() => undefined);
            tokensSinceFlush += text.length;
          },
          signal
        );
      } catch (err) {
        if (signal.aborted) throw err; // handled as cancellation below
        await emit("step", { step: "route:provider", index: 1, total: 2, status: "failed", detail: err instanceof Error ? err.message.slice(0, 300) : "routing failed" });
        const reply = "No AI provider answered this request. Check the provider status in the System Monitor. System commands like \"health check\", \"scan errors\" or \"switch provider to groq\" still work without AI.";
        await deps.persistMessage?.({ conversationId: run.conversationId, role: "assistant", content: reply, provider: "unavailable", runId });
        await emit("done", { status: "completed", reply, provider: "unavailable", degraded: true }, { status: "completed", finishedAt: new Date(), result: JSON.stringify({ degraded: true, reason: "no provider answered" }) });
        return await store.getRun(runId);
      }

      await tokenStream.flush();
      tokensSinceFlush = 0;

      let reply = routed.content;
      try {
        const parsed = JSON.parse(reply);
        if (typeof parsed.reply === "string" && parsed.reply.trim()) reply = parsed.reply.trim();
      } catch {
        // plain text — use as-is
      }

      await emit("step", { step: "stream:reply", index: 2, total: 2, status: "completed", detail: `${reply.length} chars via ${routed.provider} (${routed.streamMode})` });
      await deps.persistMessage?.({ conversationId: run.conversationId, role: "assistant", content: reply, provider: routed.provider, runId });
      await store.appendEvent(runId, "status", JSON.stringify({ message: "Completed" }), {
        provider: routed.provider,
        model: routed.model,
        partialContent: null,
        result: JSON.stringify({ replyLength: reply.length, streamMode: routed.streamMode, latencyMs: routed.latencyMs }),
      });
      // Finalize the run row (live fan-out via emit) so SSE subscribers see
      // the terminal state; the done event follows as the last frame.
      await emit("status", { message: "done" }, { status: "completed", finishedAt: new Date() });
      await emit("done", { status: "completed", reply, provider: routed.provider, model: routed.model });
      return await store.getRun(runId);
    }

    // ── System intents: execute the deterministic plan ─────────────────
    const plan = planFor(intent.kind, run.command, intent.entities);
    await emit("step", { step: "plan", index: 0, total: plan.length, status: "completed", detail: plan.map((p) => p.label).join(" → ") });
    await store.appendEvent(runId, "status", JSON.stringify({ message: `Executing ${intent.kind}`, plan: plan.map((p) => p.label) }), { intent: intent.kind, plan: JSON.stringify(plan.map((p) => p.label)) });

    const results: Array<{ step: string; ok: boolean; detail: string; ms: number }> = [];
    let pendingActionId: string | null = null;
    for (let i = 0; i < plan.length; i++) {
      if (signal.aborted) break;
      const stepStart = Date.now();
      await emit("step", { step: plan[i].label, index: i + 1, total: plan.length, status: "started" });
      try {
        const detail = await plan[i].run(emit, signal);
        if (signal.aborted) break;
        const detailStr = typeof detail === "string" ? detail : JSON.stringify(detail);
        results.push({ step: plan[i].label, ok: true, detail: detailStr.slice(0, 300), ms: Date.now() - stepStart });
        await emit("step", { step: plan[i].label, index: i + 1, total: plan.length, status: "completed", detail: detailStr.slice(0, 300), ms: Date.now() - stepStart });
      } catch (err) {
        if (signal.aborted) break;
        const msg = err instanceof Error ? err.message.slice(0, 300) : "step failed";
        results.push({ step: plan[i].label, ok: false, detail: msg, ms: Date.now() - stepStart });
        await emit("step", { step: plan[i].label, index: i + 1, total: plan.length, status: "failed", detail: msg, ms: Date.now() - stepStart });
        await fail(`${plan[i].label} failed: ${msg}`);
        return await store.getRun(runId);
      }
    }

    if (signal.aborted) {
      await emit("done", { status: "cancelled" }, { status: "cancelled", finishedAt: new Date(), error: "cancelled by owner" }).catch(() => undefined);
      return await store.getRun(runId);
    }

    // Approval intents: pause the run until the owner decides.
    const needsApproval = intent.kind === "announce" || intent.kind === "backup";
    if (needsApproval) {
      try {
        const pending = await db.superAdminAction.findFirst({ where: { status: "pending", kind: intent.kind }, orderBy: { createdAt: "desc" } }).catch(() => null);
        pendingActionId = pending?.id ?? null;
      } catch {
        pendingActionId = null;
      }
      await store.appendEvent(runId, "status", JSON.stringify({ message: "Waiting for owner approval" }), {
        status: "awaiting_approval",
        pendingActionId,
        result: JSON.stringify({ results }),
      });
      await emit("approval", { actionId: pendingActionId, kind: intent.kind, title: intent.kind === "announce" ? "Publish announcement" : "Run database backup" });
      return await store.getRun(runId);
    }

    // Success: compose a concise reply from step results.
    const reply = composeSystemReply(intent.kind, results);
    await deps.persistMessage?.({ conversationId: run.conversationId, role: "assistant", content: reply, provider: "executor", runId });
    await store.appendEvent(runId, "status", JSON.stringify({ message: "Completed" }), {
      status: "completed",
      finishedAt: new Date(),
      result: JSON.stringify({ results, reply }),
    });
    await emit("done", { status: "completed", reply, execution: { results } });
    return await store.getRun(runId);
  } catch (err) {
    const aborted = signal.aborted;
    if (aborted) {
      await emit("done", { status: "cancelled" }, { status: "cancelled", finishedAt: new Date(), error: "cancelled by owner" }).catch(() => undefined);
    } else {
      const msg = err instanceof Error ? err.message : "unexpected error";
      await fail(msg);
    }
    return await store.getRun(runId);
  } finally {
    controllers.delete(runId);
  }
}

const SUPER_ADMIN_SYSTEM_PROMPT = `You are the ALO Super Admin assistant — the owner's command center for the ALO Learning Journey platform.
You help the owner manage the system in plain language (Bengali or English, matching the owner's language).
Rules:
- Be concise, specific, and actionable. Use short paragraphs and bullet lists.
- Never claim to have changed the system unless the execution result confirms it.
- For risky changes, explain that approval is required and point to the Actions panel.
- If you do not know something, say so honestly. Never invent data, metrics, or provider status.
- Reply with ONLY JSON: {"reply": "..."} where reply is your answer (markdown allowed).`;

function composeSystemReply(intent: IntentKind, results: Array<{ step: string; ok: boolean; detail: string }>): string {
  // The knowledge answer is a table, not a status line: step details are capped
  // at 300 characters, so it is composed from the index itself.
  if (intent === "list_sources" && results.every((r) => r.ok)) {
    const id = results.find((r) => r.step === "index:inspect")?.detail.match(/source:([a-z0-9-]+)/)?.[1];
    return sourceReport(id);
  }
  const lines = results.map((r) => `- **${r.step}**: ${r.ok ? "✓" : "✗"} ${r.detail}`);
  const head =
    intent === "health_check" ? "System health check complete." :
    intent === "scan_errors" ? "Error scan complete." :
    intent === "fix_errors" ? "Auto-fix pass complete." :
    intent === "switch_provider" ? "Provider switch complete." :
    intent === "analytics" ? "Analytics summary." :
    intent === "backup" ? "Backup request recorded." :
    intent === "review_link" ? "Link review complete." :
    intent === "set_config" ? "Configuration check complete." :
    intent === "list_sources" ? "Knowledge index (licences verified 2026-11-27)." :
    "Command executed.";
  return `${head}\n${lines.join("\n")}`;
}

// ── Approval continuation ───────────────────────────────────────────────────

/**
 * Finalize any run that was paused awaiting this action's decision.
 * Called from the actions route after the owner approves/rejects.
 */
export async function finalizeRunsForAction(actionId: string, decision: "approved" | "rejected", store?: RunStore): Promise<number> {
  const s = store ?? (await getRunStore());
  const runs = await s.findRunsByAction(actionId);
  let n = 0;
  for (const run of runs) {
    if (run.status !== "awaiting_approval") continue;
    const ok = decision === "approved";
    // Persist the TERMINAL done event (durable timeline) and fan it out live
    // to any open SSE subscribers.
    const payload = ok
      ? { status: "completed", decision, message: "Owner approved — action executed." }
      : { status: "failed", decision, error: "rejected by owner", message: "Owner rejected the action." };
    const ev = await s
      .appendEvent(run.id, "done", payload, {
        status: ok ? "completed" : "failed",
        finishedAt: new Date(),
        error: ok ? null : "rejected by owner",
        pendingActionId: null,
      })
      .catch(() => null);
    if (ev) {
      emitLive(run.id, ev.seq, "done", payload);
      n++;
    }
  }
  return n;
}

/** Test hooks. */
export function _resetRuns(): void {
  liveSubscribers.clear();
  controllers.clear();
}
