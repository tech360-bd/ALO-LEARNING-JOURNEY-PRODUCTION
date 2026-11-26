import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { adminPasswordHashStatus, isAdminAuthenticationConfigured, isAdminOtpRequired } from "@/lib/auth-config";
import { mysqlConfigurationDetail, mysqlConfigurationOk } from "@/lib/health-policy.mjs";
import { RELEASE_SHA_FILES, resolveReleaseSha } from "@/lib/health-contract.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/health/diagnose` — explains why `/api/health` is not 200.
 *
 * The public probe deliberately returns only a status word, so an operator on a
 * 503 had no way to tell "MySQL unreachable" from "ADMIN_PASSWORD_HASH was
 * rewritten by dotenv" from "SMTP password missing". This endpoint answers that
 * in one request, on the server, without shell access.
 *
 * Guarantees:
 *   - never returns a secret value, a password, a token, or a full DSN;
 *   - never returns a filesystem path outside the app directory;
 *   - requires an admin session once admin auth is configured (`requireOwner`),
 *     so it is public only in the window where nothing is configured yet — the
 *     exact moment an operator needs it.
 */

type Finding = {
  area: string;
  ok: boolean;
  critical: boolean;
  detail: string;
  fix?: string;
};

const DSN_SCHEME = /^([a-z0-9+.-]+):\/\/([^@/]*)@?([^/:?#]*)?(?::(\d+))?\/?([^?#]*)?/i;

/** Parses a DSN into a credential-free description. */
export function describeDsn(raw: string | undefined): {
  scheme: string;
  host: string;
  port: string;
  database: string;
  hasPassword: boolean;
} {
  const value = (raw ?? "").trim();
  if (!value) return { scheme: "", host: "", port: "", database: "", hasPassword: false };
  const match = DSN_SCHEME.exec(value);
  if (!match) return { scheme: value.split(":")[0] ?? "", host: "", port: "", database: "", hasPassword: false };
  const [, scheme, userinfo, host, port, database] = match;
  return {
    scheme: scheme.toLowerCase(),
    host: host || "unix-socket-or-named-pipe",
    port: port || "",
    database: database || "",
    hasPassword: /:[^:]+$/.test(userinfo ?? ""),
  };
}

async function readReleaseFiles() {
  const files: Record<string, string> = {};
  const candidates = [
    ...RELEASE_SHA_FILES.map((name) => path.join(process.cwd(), name)),
    path.join(process.cwd(), "..", "..", "current", "RELEASE_SHA"),
  ];
  await Promise.all(
    candidates.map(async (file) => {
      const text = await fs.readFile(file, "utf8").catch(() => "");
      if (text.trim()) files[file] = text;
    }),
  );
  return files;
}

async function checkDatabase() {
  const url = process.env.DATABASE_URL;
  const dsn = describeDsn(url);
  if (!mysqlConfigurationOk({ nodeEnv: process.env.NODE_ENV, databaseUrl: url })) {
    return {
      ok: false,
      detail: mysqlConfigurationDetail({ nodeEnv: process.env.NODE_ENV, databaseUrl: url }),
      fix: "Set DATABASE_URL=mysql://user:password@127.0.0.1:3306/<database> in the PM2 environment or .next/standalone/.env, then `pm2 restart learn --update-env`.",
      dsn,
      rows: null as number | null,
      latencyMs: null as number | null,
      error: null as string | null,
    };
  }
  if (!url) {
    return {
      ok: true,
      detail: "unset; development fallback (not verifiable as MySQL outside production)",
      fix: undefined,
      dsn,
      rows: null,
      latencyMs: null,
      error: null,
    };
  }
  const started = Date.now();
  try {
    const { db } = await import("@/lib/db");
    await db.$queryRaw`SELECT 1`;
    const companies = await db.company.count();
    return {
      ok: true,
      detail: `${dsn.scheme}://${dsn.host}${dsn.port ? `:${dsn.port}` : ""}/${dsn.database} reachable; Company rows=${companies}`,
      fix: undefined,
      dsn,
      rows: companies,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: `cannot query ${dsn.scheme}://${dsn.host}${dsn.port ? `:${dsn.port}` : ""}/${dsn.database}`,
      fix: explainDatabaseError(message),
      dsn,
      rows: null,
      latencyMs: Date.now() - started,
      error: redact(message),
    };
  }
}

/** Turns a Prisma/MySQL error into the next action, without echoing credentials. */
function explainDatabaseError(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("did not initialize yet") || text.includes("prisma generate")) {
    return "Prisma client not generated for this build: run `npx prisma generate && npm run build` in the app directory, then `pm2 restart learn`.";
  }
  if (text.includes("query engine") || text.includes("could not locate")) {
    return "Prisma query engine missing: the binary target for this host is not downloaded (see binaryTargets in prisma/schema.prisma). Re-run `npx prisma generate` on the server.";
  }
  if (text.includes("econnrefused") || text.includes("can't reach database server")) {
    return "MySQL is not accepting connections on that host/port: check `systemctl status mysql` and that the socket/port in DATABASE_URL is correct.";
  }
  if (text.includes("access denied")) {
    return "MySQL rejected the credentials in DATABASE_URL: verify the user/password and its GRANTs on the target database.";
  }
  if (text.includes("unknown database")) {
    return "The database named in DATABASE_URL does not exist. Create it (owner action) or correct the name; do not run migrations against a different schema.";
  }
  if (text.includes("unknown column") || text.includes("doesn't exist") || text.includes("does not exist")) {
    return "Schema drift: the database exists but lacks the tables/columns this build expects. Review `prisma migrate status` and the rehearsal in MIGRATION-RECOVERY-PLAN.md — never `migrate reset`.";
  }
  if (text.includes("too many connections")) {
    return "MySQL connection limit reached: restart PM2 to drop stale pools and check that only one instance per port is running.";
  }
  return "Inspect `pm2 logs learn --lines 100` for the Prisma error; the message is redacted here.";
}

/** Removes credentials from an error string before it leaves the process. */
function redact(message: string): string {
  return message
    .replace(/([a-z0-9+.-]+:\/\/)[^@\s]+@/gi, "$1<credentials>@")
    .replace(/\bpassword=[^\s&]+/gi, "password=<redacted>")
    .replace(/\b(tskey|sk|ghp|xox[baprs])-[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .slice(0, 400);
}

export async function GET() {
  const { requireOwner } = await import("@/lib/auth");
  try {
    await requireOwner();
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 401;
    return NextResponse.json(
      {
        error: status === 503 ? "authentication_not_configured" : "unauthorized",
        message:
          status === 503
            ? "Admin authentication is not configured, so this diagnostic is the only unauthenticated route: set NEXTAUTH_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD_HASH."
            : "Sign in as the administrator to run server diagnostics.",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const findings: Finding[] = [];

  // --- release identity -----------------------------------------------------
  const releaseFiles = await readReleaseFiles();
  const release = resolveReleaseSha({ env: process.env, files: releaseFiles });
  findings.push({
    area: "Release SHA",
    ok: release.sha !== "unknown",
    // Not critical: an unidentified build is still a serving build. But the
    // deploy gate compares this SHA, so it must be reported loudly.
    critical: false,
    detail:
      release.sha === "unknown"
        ? "RELEASE_SHA is not set and no RELEASE_SHA marker file was found next to server.js"
        : `${release.sha} (source: ${release.source})`,
    fix:
      release.sha === "unknown"
        ? "Write the commit to RELEASE_SHA in the app directory before building, or set it in the PM2 env: `RELEASE_SHA=$(git rev-parse HEAD) pm2 restart learn --update-env`."
        : undefined,
  });

  // --- database -------------------------------------------------------------
  const database = await checkDatabase();
  findings.push({
    area: "MySQL / Prisma",
    ok: database.ok,
    critical: true,
    detail: database.detail,
    fix: database.fix,
  });

  // --- admin auth -----------------------------------------------------------
  const hashState = adminPasswordHashStatus().state;
  const authOk = isAdminAuthenticationConfigured();
  findings.push({
    area: "Administrator authentication",
    ok: authOk,
    critical: process.env.NODE_ENV === "production",
    detail: authOk
      ? `configured; OTP ${isAdminOtpRequired() ? "required" : "disabled"}`
      : `not usable; passwordHash=${hashState}`,
    fix: authOk
      ? undefined
      : hashState === "interpolated"
        ? "ADMIN_PASSWORD_HASH lost its `$` separators to dotenv interpolation. Regenerate with `node scripts/hash-admin-password.mjs` and paste the ESCAPED line (scrypt\\$…\\$…) into .env, or set the direct value in the PM2 environment."
        : "Set NEXTAUTH_SECRET, ADMIN_EMAIL and a scrypt ADMIN_PASSWORD_HASH (node scripts/hash-admin-password.mjs). With ADMIN_OTP_REQUIRED=false no SMS provider is needed.",
  });

  // --- MarketingOS secrets ---------------------------------------------------
  const jwtOk = (process.env.JWT_SECRET ?? "").trim().length >= 32;
  const vaultOk = (process.env.VAULT_MASTER_KEY ?? "").trim().length > 0;
  findings.push({
    area: "MarketingOS secrets",
    ok: jwtOk && vaultOk,
    critical: false,
    detail: `JWT_SECRET ${jwtOk ? "set" : "missing or shorter than 32 characters"}; VAULT_MASTER_KEY ${vaultOk ? "set" : "missing"}`,
    fix: jwtOk && vaultOk ? undefined : "Set both in the PM2 environment; the vault fails closed in production without VAULT_MASTER_KEY.",
  });

  // --- smtp -----------------------------------------------------------------
  const smtpSet = Boolean((process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD ?? process.env.SMTPPASS ?? "").trim());
  findings.push({
    area: "Email (SMTP)",
    ok: smtpSet,
    critical: false,
    detail: smtpSet ? "SMTP password present" : "SMTP_PASS missing — contact enquiries will not be emailed",
    fix: smtpSet ? undefined : "Set SMTP_PASS in the PM2 environment (cPanel → Email Accounts). Optional for the health probe.",
  });

  // --- local engines --------------------------------------------------------
  findings.push({
    area: "Local speech",
    ok: true,
    critical: false,
    detail: `PIPER_BIN=${process.env.PIPER_BIN ? "set" : "unset"}, PIPER_MODEL_PATH=${process.env.PIPER_MODEL_PATH ? "set" : "unset"}, ESPEAK_BIN=${process.env.ESPEAK_BIN ? "set" : "unset"} — the built-in formant synthesizer covers a missing eSpeak/Piper binary`,
  });

  const failing = findings.filter((f) => !f.ok);
  const blocking = failing.filter((f) => f.critical);
  return NextResponse.json(
    {
      summary: {
        status: blocking.length ? "unhealthy" : failing.length ? "degraded" : "healthy",
        blocking: blocking.map((f) => f.area),
        advisory: failing.filter((f) => !f.critical).map((f) => f.area),
      },
      environment: {
        nodeEnv: process.env.NODE_ENV ?? "unset",
        node: process.version,
        cwd: path.basename(process.cwd()) === "standalone" ? "<app>/.next/standalone" : "<app>",
        envFileLoaded: await fs.access(path.join(process.cwd(), ".env")).then(() => true, () => false),
        pmId: process.env.pm_id ?? null,
      },
      release,
      database: {
        dsn: database.dsn,
        latencyMs: database.latencyMs,
        error: database.error,
      },
      findings,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
