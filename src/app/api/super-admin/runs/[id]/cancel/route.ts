import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { getRunStore } from "@/lib/super-admin/run-store";
import { requestCancellation, emitLive } from "@/lib/super-admin/runs";

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
 * POST /api/super-admin/runs/:id/cancel — cancel an in-flight run.
 *
 * - If the run is live in this process: its provider call is aborted and the
 *   pipeline finalizes as "cancelled" (partial timeline preserved).
 * - If the run row exists but is not live (e.g. the pipeline already ended,
 *   or the process restarted): the run is finalized as "cancelled" here so
 *   the UI never shows a stuck spinner.
 * - Already-terminal runs are returned unchanged (idempotent).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard();
  if (denied) return denied;
  const { id } = await params;

  const store = await getRunStore();
  const run = await store.getRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
    return NextResponse.json({ cancelled: false, status: run.status, reason: "already terminal" });
  }

  const live = requestCancellation(id);
  if (!live && run.status === "running") {
    // Not live in this process — finalize directly and fan the terminal
    // event out live so open SSE streams close instead of stalling.
    try {
      const ev = await store.appendEvent(id, "done", { status: "cancelled", reason: "cancel requested while not live" }, {
        status: "cancelled",
        finishedAt: new Date(),
        error: "cancelled",
      });
      emitLive(id, ev.seq, "done", { status: "cancelled" });
    } catch {
      // concurrent finalize — current status below reflects reality
    }
  }

  const after = await store.getRun(id).catch(() => run);
  try {
    await (await import("@/lib/db")).db.auditLog
      .create({ data: { actor: "SuperAdmin", action: "superadmin.run_cancelled", detail: `run=${id} live=${live}`, severity: "info" } })
      .catch(() => undefined);
  } catch {
    // ignore
  }
  return NextResponse.json({ cancelled: true, live, status: after?.status ?? "cancelled" });
}
