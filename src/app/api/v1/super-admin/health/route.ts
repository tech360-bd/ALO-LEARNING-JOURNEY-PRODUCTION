/**
 * GET /api/v1/super-admin/health — System health for external monitoring.
 *
 * Authenticated (MarketingOS JWT) and restricted to the super_admin role.
 * Returns a compact, machine-readable health payload for dashboards and
 * uptime monitors owned by the tenant: database, omni-router, open
 * self-heal findings, and pending approvals.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok } from "@/lib/v1-middleware";
import { db } from "@/lib/db";
import { getRouterStatus } from "@/lib/omni/router";
import { listOpenFindings } from "@/lib/self-heal/detector";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ctx = await requireRole(request, "super_admin");
  if (ctx instanceof NextResponse) return ctx;

  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    const started = Date.now();
    await db.$queryRaw`SELECT 1`;
    checks.database = { ok: true, detail: `ok in ${Date.now() - started}ms` };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : "unreachable" };
  }

  let routerDown = false;
  try {
    const status = await getRouterStatus();
    routerDown = !status.external.enabled && !status.local;
    checks.omniRouter = {
      ok: !routerDown,
      detail: `preferred=${status.preferredProvider ?? "chain default"}, external=${status.external.enabled ? (status.external.configured ? "configured" : "no keys") : "disabled"}`,
    };
  } catch (err) {
    routerDown = true;
    checks.omniRouter = { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : "status failed" };
  }

  const findings = await listOpenFindings(10);
  checks.selfHeal = { ok: findings.length === 0, detail: `${findings.length} open finding(s)` };

  let pendingActions = 0;
  try {
    pendingActions = await db.superAdminAction.count({ where: { status: "pending" } }).catch(() => 0);
  } catch {
    pendingActions = 0;
  }
  checks.approvals = { ok: true, detail: `${pendingActions} pending action(s)` };

  const okAll = Object.values(checks).every((c) => c.ok) && !routerDown;
  return ok({
    ok: okAll,
    checks,
    openFindings: findings.length,
    pendingActions,
    checkedAt: new Date().toISOString(),
  });
}
