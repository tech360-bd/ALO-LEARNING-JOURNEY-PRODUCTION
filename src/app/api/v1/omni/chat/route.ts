/**
 * POST /api/v1/omni/chat — Omni-routed chat completion for external apps.
 *
 * This is the service-delivery endpoint of the ALO API architecture:
 * external applications authenticate with a MarketingOS JWT (or a bound
 * tenant credential) and get one chat completion routed automatically
 * across the owner-configured free-tier provider chain (single-active,
 * sequential failover — see docs/OMNI-ROUTING.md).
 *
 * Body:
 *   { "system": "Optional system prompt (max 2000 chars)",
 *     "message": "Required user message (max 4000 chars)",
 *     "maxTokens": 1200 }
 *
 * Response 200:
 *   { "ok": true, "data": { "reply", "provider", "model", "latencyMs" } }
 * Response 503: no real model answered (all providers down / not enabled).
 *
 * Data policy: send business content only. Never send ALO student or
 * family records; external routing is gated by the owner's payment guard.
 */
import { NextRequest } from "next/server";
import { getSessionContext, unauthorized, badRequest, ok, notConfigured } from "@/lib/v1-middleware";
import { routeChat } from "@/lib/omni/router";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MESSAGE = 4000;
const MAX_SYSTEM = 2000;

export async function POST(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!("authenticated" in ctx && ctx.authenticated)) return unauthorized();

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return badRequest("JSON body required");
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const system = typeof body.system === "string" ? body.system.trim() : "";
  if (!message) return badRequest('"message" is required');
  if (message.length > MAX_MESSAGE) return badRequest(`message exceeds ${MAX_MESSAGE} characters`);
  if (system.length > MAX_SYSTEM) return badRequest(`system exceeds ${MAX_SYSTEM} characters`);
  const maxTokens =
    typeof body.maxTokens === "number" && body.maxTokens > 0 ? Math.min(body.maxTokens, 2000) : 1200;

  try {
    const result = await routeChat({
      system: system || "You are a helpful assistant. Reply concisely.",
      user: message,
      task: "v1-omni-chat",
      maxTokens,
    });
    try {
      await db.auditLog.create({
        data: {
          actor: `v1:${ctx.email}`,
          action: "v1.omni_chat",
          detail: `provider=${result.provider} model=${result.model} chars=${message.length}`,
          severity: "info",
        },
      });
    } catch {
      // ignore
    }
    return ok({
      reply: result.content,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "omni routing failed";
    if (msg.includes("omni_router_busy")) {
      return ok({
        reply: null,
        provider: null,
        model: null,
        error: "ai_busy: another routed call is in flight (single-active rule). Retry shortly.",
      });
    }
    return notConfigured(
      "omni_chat",
      "No provider answered. The owner may need to enable a free-tier provider key (see /api/v1/omni/providers for status)."
    );
  }
}
