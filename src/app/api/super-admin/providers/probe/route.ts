import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { getRouterStatus } from "@/lib/omni/router";
import { getLocalAiStatus } from "@/lib/local-models";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/super-admin/providers/probe — verify real provider connectivity.
 *
 * Body: { live?: boolean }
 *  - Always (free, read-only): configuration state of every provider
 *    (key present? model valid? guard on/off?) + a live Ollama /api/tags
 *    probe (which local models are actually loaded).
 *  - live: true (owner-triggered, costs a tiny bit of free quota): one real
 *    minimal completion through the active chain, reported with provider,
 *    model and latency. This is the honest "does a real AI call work?" check
 *    — it runs on the server where the keys exist, never from this repo.
 *
 * Results are audit-logged. Nothing is mutated.
 */
export async function POST(req: NextRequest) {
  try {
    await requireOwner();
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json({ error: status === 503 ? "auth_not_configured" : "unauthorized" }, { status });
  }

  const body = await req.json().catch(() => ({}));
  const live = body.live === true;
  const results: Record<string, unknown> = {
    probedAt: new Date().toISOString(),
    configuration: null,
    local: null,
    liveCall: null,
  };

  // 1) Configuration state (free).
  try {
    const status = await getRouterStatus();
    results.configuration = {
      guardEnabled: status.external.enabled,
      anyConfigured: status.external.configured,
      chainOrder: status.chainOrder,
      preferredProvider: status.preferredProvider,
      providers: status.external.providers.map((p: any) => ({ provider: p.provider, configured: p.configured, model: p.model, reason: p.reason })),
      health: status.health,
      cooldowns: status.cooldowns,
    };
  } catch (err) {
    results.configuration = { error: err instanceof Error ? err.message.slice(0, 200) : "status failed" };
  }

  // 2) Local Ollama: real /api/tags probe (which models are loaded).
  try {
    const local = await getLocalAiStatus();
    results.local = {
      model: local.text.model,
      serviceAvailable: local.text.serviceAvailable,
      modelInstalled: local.text.available,
      installedModels: local.text.installedModels,
      error: local.text.error,
    };
  } catch (err) {
    results.local = { error: err instanceof Error ? err.message.slice(0, 200) : "local probe failed" };
  }

  // 3) Optional real completion (owner-triggered).
  if (live) {
    try {
      const { routeChat } = await import("@/lib/omni/router");
      const started = Date.now();
      const routed = await routeChat({
        system: "You are a connectivity probe. Reply with exactly: OK",
        user: "probe",
        task: "provider-probe",
        maxTokens: 8,
        timeoutMs: 30_000,
      });
      results.liveCall = {
        ok: true,
        provider: routed.provider,
        model: routed.model,
        latencyMs: routed.latencyMs ?? Date.now() - started,
        sample: routed.content.slice(0, 80),
      };
    } catch (err) {
      results.liveCall = {
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 300) : "live call failed",
        hint: "Check the owner switches (ALO_PAID_AI_API_ALLOWED, ALO_OWNER_APPROVED_PAID_AI_API) and a free provider key, or that local Ollama is running.",
      };
    }
  }

  try {
    await db.auditLog.create({
      data: {
        actor: "SuperAdmin",
        action: "superadmin.provider_probe",
        detail: `live=${live} local=${results.local && !("error" in (results.local as any)) ? "ok" : "n/a"} liveCall=${results.liveCall ? (results.liveCall as any).ok === true ? "ok" : "fail" : "skipped"}`,
        severity: "info",
      },
    });
  } catch {
    // ignore
  }

  return NextResponse.json(results);
}
