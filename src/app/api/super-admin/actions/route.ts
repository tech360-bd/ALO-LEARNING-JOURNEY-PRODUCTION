import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";

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

/** GET /api/super-admin/actions?status=pending — list actions. */
export async function GET(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;
  const status = req.nextUrl.searchParams.get("status") ?? "pending";
  try {
    const actions = await db.superAdminAction.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ actions });
  } catch {
    return NextResponse.json({ actions: [] });
  }
}

/**
 * POST /api/super-admin/actions { id, decision: "approve" | "reject" }
 * Approving an "announce" action publishes the announcement (MarketingOS
 * Announcement table, scoped to the owner's company). Other kinds are
 * marked executed with a note (backup runs on the server via SSH).
 */
export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const decision = body.decision === "reject" ? "rejected" : "approved";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const action = await db.superAdminAction.findUnique({ where: { id } });
    if (!action) return NextResponse.json({ error: "action not found" }, { status: 404 });
    if (action.status !== "pending") {
      return NextResponse.json({ error: `action already ${action.status}` }, { status: 409 });
    }

    let resultNote = "";
    if (decision === "approved" && action.kind === "announce") {
      let text = "";
      try {
        text = (JSON.parse(action.payload ?? "{}") as any).text ?? action.detail ?? "";
      } catch {
        text = action.detail ?? "";
      }
      // Publish to the owner's company (first MosCompany). Announcement
      // requires a company; if none exists, record the approval honestly.
      const company = await db.mosCompany.findFirst({ orderBy: { createdAt: "asc" } }).catch(() => null);
      if (company && text.trim()) {
        await db.announcement.create({
          data: {
            title: "Announcement",
            content: text.trim(),
            targetRoles: JSON.stringify(["all"]),
            companyId: company.id,
            isActive: true,
          },
        });
        resultNote = "Announcement published.";
      } else {
        resultNote = "Approved but not published: no company found or empty text.";
      }
    } else if (decision === "approved") {
      resultNote = "Approved. Recorded as executed (no automated side effect for this kind).";
    } else {
      resultNote = "Rejected by owner.";
    }

    const updated = await db.superAdminAction.update({
      where: { id },
      data: {
        status: decision === "approved" ? "executed" : "rejected",
        result: resultNote,
        decidedAt: new Date(),
      },
    });
    try {
      await db.auditLog.create({
        data: { actor: "SuperAdmin", action: `superadmin.action_${decision}`, detail: `${action.kind}: ${action.title}`, severity: "info" },
      });
    } catch {
      // ignore
    }
    // Approval continuation: finalize any run paused awaiting this decision
    // (streams the outcome live to open timelines, persists otherwise).
    let resumedRuns = 0;
    try {
      const { finalizeRunsForAction } = await import("@/lib/super-admin/runs");
      resumedRuns = await finalizeRunsForAction(id, decision);
    } catch {
      // Runs store unavailable — the decision is still recorded on the action.
    }
    return NextResponse.json({ action: updated, note: resultNote, resumedRuns });
  } catch {
    return NextResponse.json({ error: "database unavailable" }, { status: 503 });
  }
}
