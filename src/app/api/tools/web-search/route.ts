import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { localSearchStatus, localWebSearch } from "@/lib/local-web-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };

async function guard() {
  try {
    await requireOwner();
    return null;
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json(
      { error: status === 503 ? "auth_not_configured" : "unauthorized" },
      { status, headers: NO_STORE },
    );
  }
}

/** GET — which local backends are configured, and what they cost (nothing). */
export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  return NextResponse.json({ status: localSearchStatus() }, { headers: NO_STORE });
}

/**
 * POST /api/tools/web-search
 * Body: { query: string, limit?: number }
 *
 * Searches through the owner's own SearXNG/Wigolo. There is no paid backend to
 * fall back to: if every local backend is down, the response is `ok:false` with
 * the per-backend reasons, and the caller decides what to say.
 */
export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const query = typeof body?.query === "string" ? body.query : "";
  if (query.trim().length < 2) {
    return NextResponse.json({ error: "query_required", message: "provide a query of at least 2 characters" }, { status: 400, headers: NO_STORE });
  }
  const limit = typeof body?.limit === "number" ? body.limit : undefined;

  const result = await localWebSearch(query, { limit });
  return NextResponse.json(result, { status: result.ok ? 200 : 502, headers: NO_STORE });
}
