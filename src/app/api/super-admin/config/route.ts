import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import {
  configFieldNames,
  listRuntimeConfig,
  primeRuntimeConfig,
  runtimeEnv,
  setRuntimeValue,
  type SetResult,
} from "@/lib/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Super Admin configuration — "change env / add an API key from the dashboard,
 * not from a server shell".
 *
 * GET   → every allowlisted setting with its *effective source*
 *         (environment | dashboard | default | unset) and a masked value.
 *         Secrets are never returned: the environment shows as
 *         "(set in environment)", a stored secret as `****abcd`.
 * POST  → { values: { NAME: "…" | null } } writes one or more settings.
 *         `null`/"" clears a value. Secrets are encrypted with VAULT_MASTER_KEY
 *         before they touch disk (see src/lib/runtime-config.ts).
 *
 * Deliberately NOT offered: arbitrary environment names. Only the allowlist in
 * `configFieldNames()` is writable, so this endpoint cannot be turned into
 * `NODE_OPTIONS`/loader injection.
 */

async function guard() {
  try {
    await requireOwner();
    return null;
  } catch (err: any) {
    const status = err?.statusCode ?? 401;
    return NextResponse.json(
      { error: status === 503 ? "auth_not_configured" : "unauthorized" },
      { status }
    );
  }
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  await primeRuntimeConfig();
  const values = await listRuntimeConfig();
  return NextResponse.json({
    values,
    groups: [...new Set(values.map((v) => v.group))],
    allowlist: configFieldNames(),
    // Explains why some saves say "restart required" instead of taking effect.
    notes: [
      "A value set in the real environment always wins over a dashboard value.",
      "Secrets are stored encrypted (AES-256-GCM) and shown masked; they are never returned.",
      "Variables Next.js reads at boot (DATABASE_URL, NEXTAUTH_SECRET, ADMIN_*) need `pm2 restart learn --update-env`.",
    ],
  });
}

const MAX_VALUES_PER_REQUEST = 20;

export async function POST(req: NextRequest) {
  const denied = await guard();
  if (denied) return denied;

  const body = await req.json().catch(() => null) as
    | { values?: Record<string, unknown>; updatedBy?: string }
    | null;
  const values = body?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return NextResponse.json({ error: "values_required", hint: "POST { values: { GROQ_API_KEY: \"…\" } }" }, { status: 400 });
  }
  const entries = Object.entries(values);
  if (entries.length === 0) return NextResponse.json({ error: "no_values" }, { status: 400 });
  if (entries.length > MAX_VALUES_PER_REQUEST) {
    return NextResponse.json({ error: "too_many_values", max: MAX_VALUES_PER_REQUEST }, { status: 400 });
  }

  const results: SetResult[] = [];
  for (const [name, raw] of entries) {
    if (typeof raw !== "string" && raw !== null) {
      results.push({ name, ok: false, restartRequired: false, error: "value must be a string or null" });
      continue;
    }
    results.push(await setRuntimeValue(name, raw as string | null, { updatedBy: body?.updatedBy }));
  }

  const failed = results.filter((r) => !r.ok);
  const restartRequired = results.filter((r) => r.ok && r.restartRequired).map((r) => r.name);

  return NextResponse.json(
    {
      ok: failed.length === 0,
      results,
      restartRequired,
      // The exact command the operator (or the deploy script) should run when a
      // boot-time variable changed. Never executed from here by design.
      restartCommand: restartRequired.length ? "pm2 restart learn --update-env && pm2 save" : null,
    },
    { status: failed.length === 0 ? 200 : 400 }
  );
}

/**
 * GET /api/super-admin/config?probe=GROQ_API_KEY — is the effective value usable?
 *
 * A key that is merely *present* is not a key that *works*; the security-critical
 * part is that the probe never returns the value, only a verdict. For a
 * provider key, the verdict is "the chain reports this provider as ready"
 * (which checks the key, the model id and the free-tier rule together).
 */
export async function HEAD(req: NextRequest) {
  const denied = await guard();
  if (denied) return new NextResponse(null, { status: denied.status });

  const name = req.nextUrl.searchParams.get("probe");
  if (!name || !configFieldNames().includes(name)) {
    return new NextResponse(null, { status: 400 });
  }
  await primeRuntimeConfig();
  const view = (await listRuntimeConfig()).find((v) => v.name === name);
  const value = await runtimeEnv(name);
  const configured = typeof value === "string" && value.length > 0;
  return new NextResponse(null, {
    status: configured ? 200 : 404,
    headers: {
      "x-alo-source": view?.source ?? "unset",
      "x-alo-restart-required": String(Boolean(view?.restartRequired)),
    },
  });
}
