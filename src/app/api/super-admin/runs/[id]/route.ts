import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { getRunStore } from "@/lib/super-admin/run-store";

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
 * GET /api/super-admin/runs/:id — run row + full persisted timeline.
 * Used by the UI to restore an execution timeline after a page refresh
 * (the timeline is durable, so it survives reloads and server restarts).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard();
  if (denied) return denied;
  const { id } = await params;

  const store = await getRunStore();
  const run = await store.getRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const events = await store.listEvents(id).catch(() => []);
  return NextResponse.json({
    run: {
      id: run.id,
      conversationId: run.conversationId,
      command: run.command,
      intent: run.intent,
      status: run.status,
      provider: run.provider,
      model: run.model,
      plan: run.plan,
      result: run.result,
      error: run.error,
      pendingActionId: run.pendingActionId,
      seq: run.seq,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    events: events.map((e) => ({
      seq: e.seq,
      type: e.type,
      payload: e.payload ? safeParse(e.payload) : null,
      createdAt: e.createdAt,
    })),
    persistent: store.persistent,
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
