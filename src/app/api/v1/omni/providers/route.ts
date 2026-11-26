/**
 * GET /api/v1/omni/providers — Omni-router status for external apps.
 *
 * Read-only view of the routed provider chain: which providers are
 * configured, the single-active state, per-provider health, and the
 * free-tier catalog (terms are planning notes — verify before use).
 *
 * No API keys or secrets are ever returned (masked only).
 */
import { NextRequest } from "next/server";
import { getSessionContext, unauthorized, ok } from "@/lib/v1-middleware";
import { getRouterStatus } from "@/lib/omni/router";
import { OMNI_CATALOG, catalogSummary } from "@/lib/omni/catalog";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!("authenticated" in ctx && ctx.authenticated)) return unauthorized();

  const router = await getRouterStatus();

  // Include registry providers the owner configured (masked keys).
  let registryProviders: unknown[] = [];
  try {
    const rows = await db.aiModelProvider.findMany({
      select: { slug: true, label: true, category: true, priority: true, isEnabled: true, secretMasked: true },
      orderBy: [{ priority: "asc" }, { label: "asc" }],
    });
    registryProviders = rows;
  } catch {
    registryProviders = [];
  }

  return ok({
    singleActive: router.singleActive,
    externalInFlight: router.externalInFlight,
    preferredProvider: router.preferredProvider,
    chainOrder: router.chainOrder,
    external: {
      enabled: router.external.enabled,
      configured: router.external.configured,
      order: router.external.order,
      dataPolicy: router.external.dataPolicy,
      providers: router.external.providers.map((p: any) => ({
        provider: p.provider,
        kind: p.kind,
        configured: p.configured,
        model: p.model,
        reason: p.reason,
      })),
    },
    local: router.local,
    health: router.health,
    cooldowns: router.cooldowns,
    registryProviders,
    catalog: OMNI_CATALOG.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      tier: e.tier,
      callable: e.callable,
      freeTierNote: e.freeTierNote,
      docsUrl: e.docsUrl,
    })),
    catalogSummary: catalogSummary(),
  });
}
