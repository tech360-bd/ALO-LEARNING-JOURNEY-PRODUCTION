import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { detectErrors, persistFindings, listOpenFindings } from "@/lib/self-heal/detector";
import { applySafeFix, FIX_REGISTRY } from "@/lib/self-heal/fixer";
import { topPatterns } from "@/lib/self-heal/learner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function guard() {
  try {
    await requireOwner();
    return null;
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json({ error: status === 503 ? "auth_not_configured" : "unauthorized" }, { status });
  }
}

/** GET /api/super-admin/self-heal — open findings + fix registry + learned patterns. */
export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  const findings = await listOpenFindings();
  const patterns = await topPatterns(20);
  return NextResponse.json({ findings, fixes: FIX_REGISTRY, learnedPatterns: patterns });
}

/**
 * POST /api/super-admin/self-heal { mode: "scan" | "fix" | "apply-fix", fixId?, url? }
 *  - scan: run the 4-layer detector and persist findings.
 *  - fix:  apply all safe fixes for open findings (sequential).
 *  - apply-fix: apply one named safe fix by id (approval/destructive refused).
 */
export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const mode = typeof body.mode === "string" ? body.mode : "scan";
  const url = typeof body.url === "string" ? body.url : undefined;

  if (mode === "scan") {
    const report = await detectErrors({ scanWeb: body.scanWeb !== false });
    const saved = await persistFindings(report.findings);
    try {
      await db.auditLog.create({
        data: { actor: "SelfHeal", action: "selfheal.scan", detail: `${report.findings.length} finding(s)`, severity: "info" },
      });
    } catch {
      // ignore
    }
    return NextResponse.json({
      ok: true,
      mode,
      count: report.findings.length,
      findings: saved.map((f: any) => ({ id: f.id, kind: f.kind, severity: f.severity, title: f.title, fixKind: f.fixKind, url: f.url })),
      layers: report.layers,
    });
  }

  if (mode === "fix") {
    let findings: any[] = [];
    try {
      findings = await db.selfHealFinding.findMany({ where: { status: "open" }, take: 20 });
    } catch {
      findings = [];
    }
    const results: Array<{ findingId: string; fixKind: string; ok: boolean; message: string }> = [];
    const seen = new Set<string>();
    for (const f of findings) {
      const fixKind = f.fixKind ?? "";
      if (!fixKind || seen.has(fixKind)) continue;
      const fix = FIX_REGISTRY.find((x) => x.id === fixKind);
      if (!fix || fix.risk !== "safe") continue;
      seen.add(fixKind);
      const r = await applySafeFix(fixKind, { url: f.url ?? undefined });
      results.push({ findingId: f.id, fixKind, ok: r.ok, message: r.message });
      if (r.ok) {
        try {
          await db.selfHealFinding.update({ where: { id: f.id }, data: { status: "fixed", resolvedAt: new Date() } });
        } catch {
          // ignore
        }
      }
    }
    try {
      await db.auditLog.create({
        data: { actor: "SelfHeal", action: "selfheal.fix", detail: results.map((r) => `${r.fixKind}:${r.ok ? "ok" : "fail"}`).join(",") || "none", severity: "info" },
      });
    } catch {
      // ignore
    }
    return NextResponse.json({ ok: true, mode, results });
  }

  if (mode === "apply-fix") {
    const fixId = typeof body.fixId === "string" ? body.fixId : "";
    if (!fixId) return NextResponse.json({ error: "fixId required" }, { status: 400 });
    const r = await applySafeFix(fixId, { url });
    return NextResponse.json(r);
  }

  return NextResponse.json({ error: "mode must be scan | fix | apply-fix" }, { status: 400 });
}
