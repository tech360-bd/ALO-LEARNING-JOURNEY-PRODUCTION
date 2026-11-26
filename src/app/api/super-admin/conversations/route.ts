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

/** GET /api/super-admin/conversations — list conversations (newest first). */
export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    const conversations = await db.superAdminConversation.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    return NextResponse.json({
      conversations: conversations.map((c: any) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        lastMessage: (c.messages ?? [])[0]?.content ?? null,
      })),
    });
  } catch {
    return NextResponse.json({ conversations: [] });
  }
}

/** POST /api/super-admin/conversations { title? } — create a conversation. */
export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : "New conversation";
  try {
    const conv = await db.superAdminConversation.create({ data: { title } });
    return NextResponse.json({ conversation: conv }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "database unavailable" }, { status: 503 });
  }
}

/** DELETE /api/super-admin/conversations?id=... — delete a conversation. */
export async function DELETE(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    await db.superAdminConversation.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
}
