import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import {
  MonidError,
  isMonidEnabled,
  monidBalance,
  monidDiscover,
  monidInspect,
  monidStatus,
  proposeMonidRun,
} from "@/lib/monid";

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

function failure(err: unknown) {
  if (err instanceof MonidError) {
    // 409 for "you must approve first" (state), 400 for bad input, 502 upstream.
    const status =
      err.code === "approval_required" ? 409
      : err.code === "not_enabled" || err.code === "missing_key" ? 412
      : err.code === "payment_guard" ? 402
      : err.code === "invalid_base_url" || err.code === "invalid_response" ? 400
      : 502;
    return NextResponse.json({ error: err.code, message: err.message }, { status, headers: NO_STORE });
  }
  return NextResponse.json({ error: "unknown", message: "unexpected error" }, { status: 500, headers: NO_STORE });
}

/**
 * GET /api/super-admin/monid — the owner's view of the integration.
 * Status only: never the key, never a live call.
 */
export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  return NextResponse.json({ status: monidStatus(), enabled: isMonidEnabled() }, { headers: NO_STORE });
}

/**
 * POST /api/super-admin/monid
 *
 *   { action: "discover", query, limit?, minScore? }   FREE
 *   { action: "inspect", provider, endpoint }          FREE
 *   { action: "balance" }                              FREE
 *   { action: "propose", provider, endpoint, ... }     FREE — returns the
 *       approval proposal (price, input, warnings) so a billed run is never
 *       started without the owner seeing what it costs.
 *
 * There is NO `action: "run"` here on purpose. A billed call is only reachable
 * through the approval-gated tool (`monid_run`), which requires an approved
 * action id. Adding a run endpoint to this route would be a way around the
 * approval — the exact thing the guard exists to prevent.
 */
export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  const action = String(body?.action ?? "");

  try {
    switch (action) {
      case "discover": {
        const result = await monidDiscover({ query: String(body.query ?? ""), limit: body.limit, minScore: body.minScore });
        return NextResponse.json({ ok: true, billed: false, result: result.payload, text: result.text }, { headers: NO_STORE });
      }
      case "inspect": {
        const result = await monidInspect(String(body.provider ?? ""), String(body.endpoint ?? ""));
        return NextResponse.json({ ok: true, billed: false, result: result.payload, text: result.text }, { headers: NO_STORE });
      }
      case "balance": {
        const result = await monidBalance();
        return NextResponse.json({ ok: true, billed: false, result: result.payload, text: result.text }, { headers: NO_STORE });
      }
      case "propose": {
        const proposal = proposeMonidRun({
          provider: String(body.provider ?? ""),
          endpoint: String(body.endpoint ?? ""),
          input: body.input,
          quotedPrice: body.quotedPrice,
        });
        return NextResponse.json(
          {
            ok: true,
            billed: true,
            proposal,
            next:
              "Approve this call in the Actions panel, then the agent runs it with the approval id. Nothing has been charged yet.",
          },
          { headers: NO_STORE },
        );
      }
      case "run":
        return NextResponse.json(
          {
            error: "approval_required",
            message: "billed runs cannot start from this endpoint — approve the proposal and let the monid_run tool execute it",
          },
          { status: 409, headers: NO_STORE },
        );
      default:
        return NextResponse.json(
          { error: "unknown_action", allowed: ["discover", "inspect", "balance", "propose"] },
          { status: 400, headers: NO_STORE },
        );
    }
  } catch (err) {
    return failure(err);
  }
}
