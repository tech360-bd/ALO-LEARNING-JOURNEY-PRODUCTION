import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { localMediaBinaries, resolveFfmpegBinary, resolveFfprobeBinary } from "@/lib/local-audio";
import { getAudioStorageDir, getBackupStorageDir, getVideoStorageDir } from "@/lib/storage-paths";
import { mysqlConfigurationDetail, mysqlConfigurationOk } from "@/lib/health-policy.mjs";
import { RELEASE_SHA_FILES, resolveReleaseSha, summarizeChecks } from "@/lib/health-contract.mjs";

const run = promisify(execFile);

type Check = {
  name: string;
  ok: boolean;
  critical: boolean;
  detail: string;
};

function record(
  results: Check[],
  name: string,
  critical: boolean,
  ok: boolean,
  detail: string
) {
  results.push({ name, ok, critical, detail });
}

async function checkDatabase(results: Check[]) {
  try {
    const { db } = await import("@/lib/db");
    const started = Date.now();
    await db.$queryRaw`SELECT 1`;
    const companies = String(await db.company.count());
    const ms = Date.now() - started;
    record(results, "Database", true, true, `query and Company schema check ok in ${ms}ms; Company rows=${companies}`);
  } catch (error) {
    record(
      results,
      "Database",
      true,
      false,
      `${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
    );
  }
}

function checkEnv(results: Check[]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const developmentFallback = process.env.NODE_ENV !== "production";
    record(
      results,
      "DATABASE_URL",
      true,
      developmentFallback,
      developmentFallback
        ? "unset; local JSON persistence is a development-only fallback"
        : "missing in production; a configured MySQL connection is required"
    );
    return;
  }
  const scheme = url.split(":")[0] || "unknown";
  const isFile = scheme === "file";
  const target = isFile
    ? `file path (${path.basename(url.replace(/^file:/, ""))})`
    : `${scheme}://<host redacted>`;
  const mysqlRequired = process.env.NODE_ENV === "production";
  const mysqlConfigured = scheme === "mysql" || scheme === "mysqls";
  const ok = !mysqlRequired || mysqlConfigured;
  record(results, "DATABASE_URL", true, ok, `set; scheme=${scheme}; ${target}${!ok ? "; production requires MySQL" : ""}`);
}

async function checkCoreConfiguration(results: Check[]) {
  const env = { nodeEnv: process.env.NODE_ENV, databaseUrl: process.env.DATABASE_URL };
  record(
    results,
    "MySQL configuration",
    true,
    mysqlConfigurationOk(env),
    mysqlConfigurationDetail(env),
  );

  const { isAdminAuthenticationConfigured, adminPasswordHashStatus } = await import("@/lib/auth-config");
  const authOk = isAdminAuthenticationConfigured();
  const hashState = adminPasswordHashStatus().state;
  const authIsCritical = process.env.NODE_ENV === "production";
  const detail = authOk
    ? "configured"
    : hashState === "interpolated"
      ? "ADMIN_PASSWORD_HASH is present but was rewritten by dotenv interpolation; re-add it with escaped dollars (scrypt\\$…\\$…) or set it in the PM2 environment"
      : "not configured; production admin routes fail closed";
  record(results, "Administrator authentication", authIsCritical, authOk, detail);
}

async function checkStorage(results: Check[]) {
  const dirs = [
    getVideoStorageDir(),
    getAudioStorageDir(),
    getBackupStorageDir(),
  ];
  for (const dir of dirs) {
    const probe = path.join(dir, `.health-${randomUUID()}.tmp`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(probe, "ok", { flag: "wx" });
      await fs.unlink(probe);
      record(results, `Storage ${path.basename(dir)}`, true, true, `writable at ${dir}`);
    } catch (error) {
      await fs.rm(probe, { force: true }).catch(() => undefined);
      record(
        results,
        `Storage ${path.basename(dir)}`,
        true,
        false,
        `not writable at ${dir}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
      );
    }
  }
  record(results, "Working directory", false, true, `cwd=${process.cwd()}`);
}

async function checkBinary(results: Check[], binaryPath: string, args: string[], label: string) {
  try {
    await run(binaryPath, args, { timeout: 5000 });
    record(results, label, false, true, `${path.basename(binaryPath)} available`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    record(
      results,
      label,
      false,
      false,
      err?.code === "ENOENT"
        ? `${path.basename(binaryPath)} not installed`
        : `${path.basename(binaryPath)} present but failed: ${err?.message ?? "unknown"}`.slice(0, 200)
    );
  }
}

/**
 * The self-hosted services this box is supposed to run. A service that is down
 * is reported as a NAMED, non-critical check — the app keeps serving, and the
 * operator can see exactly which local capability degraded instead of guessing
 * from a bare 503. Nothing here is paid, so a down service never costs money;
 * it only costs accuracy.
 */
async function checkLocalServices(results: Check[]) {
  const services: Array<{ name: string; url: string | undefined; health: string; help: string }> = [
    { name: "Local search (SearXNG)", url: process.env.SEARXNG_BASE_URL || "http://127.0.0.1:8080", health: "/", help: "start searxng or set SEARXNG_BASE_URL" },
    { name: "Local extraction (Crawl4AI)", url: process.env.CRAWL4AI_BASE_URL || "http://127.0.0.1:11235", health: "/health", help: "the native extractor is the fallback" },
    { name: "Local ASR (faster-whisper)", url: process.env.FASTER_WHISPER_URL, health: "/health", help: "python3 scripts/services/faster_whisper_server.py" },
    { name: "Local TTS (Piper)", url: process.env.PIPER_BASE_URL, health: "/health", help: "python3 scripts/services/piper_server.py" },
    { name: "Local model (Ollama)", url: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434", health: "/api/tags", help: "ollama serve" },
  ];

  await Promise.all(
    services.map(async (service) => {
      if (!service.url) {
        record(results, service.name, false, false, `not configured — ${service.help}`);
        return;
      }
      let detail: string;
      let ok = false;
      try {
        const res = await fetch(`${service.url.replace(/\/+$/, "")}${service.health}`, {
          signal: AbortSignal.timeout(2_500),
          cache: "no-store",
          redirect: "error",
        });
        // Any answered HTTP status proves the daemon is listening; a 4xx from a
        // health path is still a running service.
        ok = res.status < 500;
        detail = `listening (HTTP ${res.status}) at ${new URL(service.url).host}`;
      } catch (error) {
        const cause = (error as { cause?: { code?: string }; message?: string })?.cause?.code ?? (error as Error)?.message ?? "unreachable";
        detail = `down (${String(cause).slice(0, 80)}) — ${service.help}`;
      }
      record(results, service.name, false, ok, detail);
    }),
  );
}

async function checkLocalSpeech(results: Check[]) {
  const binaries = localMediaBinaries();
  if (binaries.piper) {
    record(results, "Local speech", false, true, "Piper executable and model path configured");
    return;
  }
  if (binaries.espeak) {
    record(results, "Local speech", false, true, "Local speech synthesizer ready (eSpeak / built-in formant WAV)");
    return;
  }
  record(results, "Local speech", false, false, "No local speech engine available");
}

function checkEmail(results: Check[]) {
  // cPanel SMTP for info@learn.aloeducation.com — non-critical but visible in details
  const host = process.env.SMTP_HOST || "learn.aloeducation.com";
  const port = process.env.SMTP_PORT || "465";
  const user = process.env.SMTP_USER || "info@learn.aloeducation.com";
  const pass = process.env.SMTP_PASS || "";
  if (!pass) {
    record(results, "Email (SMTP)", false, false, `IMAP ${host}:993 + SMTP ${host}:${port} as ${user} — SMTP_PASS not set (cPanel → Email Accounts → info@learn.aloeducation.com). Outbound mail will fail.`);
    return;
  }
  record(results, "Email (SMTP)", false, true, `IMAP ${host}:993 + SMTP ${host}:${port} as ${user} — configured (FB: ALOLearningJourney · 01805-020103)`);
}

/**
 * Resolves the commit this process is serving.
 *
 * Env first (the deploy sets `RELEASE_SHA`), then the marker files the deploy
 * writes next to `server.js`. Without the file fallback a restart that lost the
 * PM2 environment reported `releaseSha: "unknown"` forever, and the deploy gate
 * in `.github/workflows/deploy.yml` — which requires `releaseSha` to equal the
 * released commit — could never pass.
 */
async function resolveServedRelease() {
  const files: Record<string, string> = {};
  // `git rev-parse` is the last resort for an in-place build on the server where
  // the deploy script's markers were never written. Cheap, read-only, and it
  // cannot invent a SHA: a non-git directory simply returns nothing.
  const candidates = [
    ...RELEASE_SHA_FILES.map((name) => path.join(process.cwd(), name)),
    // `current/RELEASE_SHA` is the atomic-release pointer used on the VPS.
    path.join(process.cwd(), "..", "..", "current", "RELEASE_SHA"),
  ];
  await Promise.all(
    candidates.map(async (file) => {
      const text = await fs.readFile(file, "utf8").catch(() => "");
      if (text.trim()) files[file] = text;
    }),
  );
  return resolveReleaseSha({ env: process.env, files });
}

/**
 * The default public response is a low-detail readiness probe: it checks the
 * database connection and core schema, but never returns host paths or errors.
 * Add `?details=1` for diagnostics; middleware requires an admin session in
 * production before this query is served.
 */
export async function GET(request: Request) {
  const results: Check[] = [];
  const detailsRequested = new URL(request.url).searchParams.get("details") === "1";
  await checkCoreConfiguration(results);

  if (detailsRequested) {
    record(results, "Runtime", true, true, `node ${process.version}`);
    checkEnv(results);
    checkEmail(results);
    await Promise.all([
      checkDatabase(results),
      checkStorage(results),
      checkBinary(results, resolveFfmpegBinary(), ["-version"], "FFmpeg"),
      checkBinary(results, resolveFfprobeBinary(), ["-version"], "FFprobe"),
      checkLocalSpeech(results),
      checkLocalServices(results),
    ]);
  } else {
    await checkDatabase(results);
  }

  const summary = summarizeChecks(results);
  const checkedAt = new Date().toISOString();
  const release = await resolveServedRelease();
  const baseResponse = {
    status: summary.status,
    legacyStatus: summary.legacyStatus,
    httpStatus: summary.httpStatus,
    checkedAt,
    releaseSha: release.sha,
    // Short form for logs; `releaseSha` stays the full SHA the deploy gate compares.
    release: release.shortSha,
  };

  return NextResponse.json(
    detailsRequested
      ? {
          ...baseResponse,
          checks: results,
          summary: {
            total: results.length,
            failedCritical: summary.failedCritical,
            failedOptional: summary.failedOptional,
            // Names only — never a path, host or credential.
            optionalDegradations: summary.failedOptional,
          },
          releaseSource: release.source,
        }
      : baseResponse,
    {
      status: summary.httpStatus,
      headers: {
        "Cache-Control": "no-store",
        // Readable in `curl -I` and in the smoke probe without exposing details:
        // e.g. `x-alo-health-reason: Administrator authentication`.
        "x-alo-health-reason": summary.failedCritical.join(",") || "none",
      },
    },
  );
}
