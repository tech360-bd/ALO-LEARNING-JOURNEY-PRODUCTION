import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { getRouterStatus } from "@/lib/omni/router";
import { listOpenFindings } from "@/lib/self-heal/detector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/super-admin/health — consolidated system health for the
 * Super Admin dashboard header (admin session required).
 */
export async function GET() {
  try {
    await requireOwner();
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json({ error: status === 503 ? "auth_not_configured" : "unauthorized" }, { status });
  }

  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // Database
  try {
    const started = Date.now();
    await db.$queryRaw`SELECT 1`;
    checks.database = { ok: true, detail: `ok in ${Date.now() - started}ms` };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : "unreachable" };
  }

  // Omni router
  try {
    const status = await getRouterStatus();
    const downCount = status.health.filter((h) => h.status === "down" || h.status === "cooldown").length;
    checks.omniRouter = {
      ok: downCount === 0 || status.chainOrder.length > 0,
      detail: `preferred=${status.preferredProvider ?? "chain default"}, external=${status.external.enabled ? (status.external.configured ? "configured" : "no keys") : "disabled"}, cooldowns=${status.cooldowns.length}`,
    };
  } catch (err) {
    checks.omniRouter = { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : "status failed" };
  }

  // Open findings
  const findings = await listOpenFindings(10);
  checks.selfHeal = {
    ok: findings.length === 0,
    detail: `${findings.length} open finding(s)`,
  };

  // Pending approvals
  let pendingActions = 0;
  try {
    pendingActions = await db.superAdminAction.count({ where: { status: "pending" } });
  } catch {
    pendingActions = 0;
  }
  checks.approvals = { ok: true, detail: `${pendingActions} pending action(s)` };

  const ok = checks.database.ok && checks.omniRouter.ok;
  return NextResponse.json({ ok, checks, openFindings: findings.length, pendingActions, checkedAt: new Date().toISOString() });
}
