import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner, DEV_OWNER_ID } from "@/lib/auth";
import { getRunStore } from "@/lib/super-admin/run-store";
import { createRun, executeRunPipeline } from "@/lib/super-admin/runs";
import { checkLimit } from "@/lib/super-admin/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MESSAGE_CHARS = 4000;
const RUNS_PER_MIN = 10;

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
 * POST /api/super-admin/runs — start a turn as a persistent, streamable run.
 * Body: { conversationId?, message }
 * Returns 202 { runId, conversationId, persistent } immediately; the
 * execution timeline is delivered via GET /runs/:id/events (SSE) or
 * re-fetched from GET /runs/:id after a refresh.
 */
export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;

  const rate = checkLimit("super-admin:run", RUNS_PER_MIN);
  if (!rate.allowed) {
    return NextResponse.json({ error: "rate_limited", retryAfterMs: rate.retryAfterMs }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` }, { status: 400 });
  }

  let conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  try {
    if (!conversationId) {
      const conv = await db.superAdminConversation.create({
        data: { title: message.slice(0, 60) || "New conversation" },
      });
      conversationId = conv.id;
    } else {
      const existing = await db.superAdminConversation.findUnique({ where: { id: conversationId } });
      if (!existing) return NextResponse.json({ error: "conversation not found" }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ error: "database unavailable" }, { status: 503 });
  }

  const store = await getRunStore();
  const run = await createRun(DEV_OWNER_ID, conversationId, message, store);

  // Fire the pipeline in the background (single long-lived Node process).
  // Failures become persisted error/done events; they never crash the server.
  void executeRunPipeline(run.id, {
    store,
    persistMessage: async ({ role, content, provider, runId }) => {
      try {
        await db.superAdminMessage.create({
          data: { conversationId, role, content: content.slice(0, 8000), provider: provider ?? null, runId },
        });
        await db.superAdminConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      } catch {
        // DB unavailable — timeline still lives in the run store.
      }
    },
  }).catch((err) => {
    console.error("[super-admin] run pipeline error:", err?.message ?? err);
  });

  try {
    await db.auditLog.create({
      data: { actor: "SuperAdmin", action: "superadmin.run_created", detail: `run=${run.id} cmd=${message.slice(0, 120)}`, severity: "info" },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ runId: run.id, conversationId, persistent: store.persistent }, { status: 202 });
}

/** GET /api/super-admin/runs — list recent runs for the owner. */
export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    const store = await getRunStore();
    const runs = await store.listRuns(DEV_OWNER_ID, 50);
    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        command: r.command,
        intent: r.intent,
        status: r.status,
        provider: r.provider,
        seq: r.seq,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      })),
      persistent: (await getRunStore()).persistent,
    });
  } catch {
    return NextResponse.json({ runs: [] });
  }
}
