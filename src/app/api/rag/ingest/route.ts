import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { ensureSeeded } from "@/lib/seed";

export async function GET() {
  try {
    await requireOwner();
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 401;
    return NextResponse.json({ error: "unauthorized" }, { status });
  }
  await ensureSeeded();
  const docs = await db.ragDocument.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ docs });
}

export async function POST(req: Request) {
  try {
    await requireOwner();
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 401;
    return NextResponse.json({ error: "unauthorized" }, { status });
  }
  await ensureSeeded();
  const body = (await req.json().catch(() => null)) as {
    title?: unknown;
    sourceType?: unknown;
    content?: unknown;
    tags?: unknown;
  } | null;
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return NextResponse.json({ error: "content_must_be_a_non_empty_string" }, { status: 400 });
  }
  if (body.content.length > 200_000) {
    return NextResponse.json({ error: "content_too_long" }, { status: 400 });
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Untitled";
  const sourceType = typeof body.sourceType === "string" && body.sourceType.trim() ? body.sourceType.trim().slice(0, 64) : "manual";
  const content = body.content.trim();
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string").slice(0, 20) : [];

  // naive chunking: split by sentences into ~300 char chunks
  const sentences = content.split(/(?<=[।.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > 300) {
      if (buf) chunks.push(buf.trim());
      buf = s;
    } else buf += " " + s;
  }
  if (buf.trim()) chunks.push(buf.trim());

  const doc = await db.ragDocument.create({
    data: {
      title,
      sourceType,
      content,
      tagsJson: JSON.stringify(tags ?? []),
      chunkCount: chunks.length,
    },
  });
  for (const c of chunks) {
    const keywords = c
      .split(/[\s,।.!?]+/)
      .filter((w) => w.length > 3)
      .slice(0, 8);
    await db.ragChunk.create({
      data: { documentId: doc.id, text: c, keywordsJson: JSON.stringify(keywords) },
    });
  }
  await db.auditLog.create({
    data: {
      actor: "admin",
      action: "rag.ingest",
      detail: `Ingested "${title}" (${chunks.length} chunks)`,
      severity: "info",
    },
  });
  return NextResponse.json({ doc, chunkCount: chunks.length });
}
