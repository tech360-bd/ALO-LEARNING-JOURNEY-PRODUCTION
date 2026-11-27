import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";

// The register is static; a stale browser copy would mislead, so no caching.
import { KNOWLEDGE_SOURCES, findSource, knowledgeSummary } from "@/lib/knowledge/sources";
import { KNOWLEDGE_PROMPT_BUDGET, knowledgePromptBlock, sourceReport } from "@/lib/knowledge/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };

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
 * GET /api/super-admin/knowledge[?id=litellm|?prompt=1|?report=1]
 *
 * The owner's view of what the agents are allowed to treat as knowledge. It
 * returns the static index (licence facts verified 2026-11-27), never a live
 * fetch — a URL that changes upstream cannot silently change what an agent
 * claims about this system.
 */
export async function GET(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const source = findSource(id);
    if (!source) return NextResponse.json({ error: "unknown_source", id }, { status: 404 });
    return NextResponse.json({ source }, { headers: NO_STORE });
  }
  if (req.nextUrl.searchParams.get("report") === "1") {
    return NextResponse.json({ report: sourceReport(), summary: knowledgeSummary() }, { headers: NO_STORE });
  }
  if (req.nextUrl.searchParams.get("prompt") === "1") {
    const block = knowledgePromptBlock();
    return NextResponse.json({ prompt: block, chars: block.length, budget: KNOWLEDGE_PROMPT_BUDGET }, { headers: NO_STORE });
  }
  return NextResponse.json({ sources: KNOWLEDGE_SOURCES, summary: knowledgeSummary() }, { headers: NO_STORE });
}
