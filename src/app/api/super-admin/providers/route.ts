import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { getRouterStatus, setPreferredProvider } from "@/lib/omni/router";
import { OMNI_CATALOG, catalogSummary } from "@/lib/omni/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard() {
  try {
    await requireOwner();
    return null;
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json({ error: status === 503 ? "auth_not_configured" : "unauthorized" }, { status });
  }
}

/**
 * GET /api/super-admin/providers — full omni-router status:
 * chain order, preferred provider, per-provider health, catalog.
 */
export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    const status = await getRouterStatus();
    return NextResponse.json({ router: status, catalog: OMNI_CATALOG, catalogSummary: catalogSummary() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "status failed" }, { status: 500 });
  }
}

/**
 * POST /api/super-admin/providers { providerId: string | null }
 * Set the preferred provider (null = chain default).
 */
export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const providerId =
    typeof body.providerId === "string" && body.providerId.trim() ? body.providerId.trim().toLowerCase() : null;

  if (providerId) {
    const known = OMNI_CATALOG.filter((e) => e.callable).map((e) => e.id);
    if (!known.includes(providerId)) {
      return NextResponse.json(
        { error: `unknown provider: ${providerId}`, known: known },
        { status: 400 }
      );
    }
  }

  try {
    await setPreferredProvider(providerId);
    try {
      await db.auditLog.create({
        data: {
          actor: "SuperAdmin",
          action: "superadmin.set_preferred_provider",
          detail: `preferred=${providerId ?? "(chain default)"}`,
          severity: "info",
        },
      });
    } catch {
      // ignore
    }
    const status = await getRouterStatus();
    return NextResponse.json({ router: status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to set provider" }, { status: 500 });
  }
}
