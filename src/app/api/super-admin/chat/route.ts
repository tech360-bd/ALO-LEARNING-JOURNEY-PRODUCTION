import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { handleSuperAdminMessage } from "@/lib/super-admin/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MESSAGE_CHARS = 4000;

async function guard() {
  try {
    return await requireOwner();
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json({ error: status === 503 ? "auth_not_configured" : "unauthorized" }, { status });
  }
}

/** GET /api/super-admin/chat?conversationId=... — conversation history. */
export async function GET(req: NextRequest) {
  const g = await guard();
  if (g instanceof NextResponse) return g;
  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  try {
    const messages = await db.superAdminMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return NextResponse.json({
      messages: messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        provider: m.provider ?? null,
        runId: m.runId ?? null,
        createdAt: m.createdAt,
      })),
    });
  } catch {
    return NextResponse.json({ messages: [], note: "History unavailable (database not reachable)." });
  }
}

/** POST /api/super-admin/chat { conversationId?, message } — send one turn. */
export async function POST(req: NextRequest) {
  const g = await guard();
  if (g instanceof NextResponse) return g;
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

  // Every turn is a persistent run; the runId is returned for the timeline.
  const turn = await handleSuperAdminMessage(conversationId, message, g.ownerId);
  try {
    await db.auditLog.create({
      data: { actor: "SuperAdmin", action: "superadmin.chat", detail: `${message.slice(0, 150)} → run=${turn.runId}`, severity: "info" },
    });
  } catch {
    // audit is best-effort
  }
  return NextResponse.json({ conversationId, ...turn });
}
