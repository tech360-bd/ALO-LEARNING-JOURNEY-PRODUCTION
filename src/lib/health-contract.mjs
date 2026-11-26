/**
 * The /api/health contract, in one testable place.
 *
 * The probe exists for three different readers, and they were disagreeing:
 *
 *   1. a platform/CDN health check  -> only needs "did this respond at all"
 *   2. `deploy/health-check.sh` and `.github/workflows/deploy.yml`
 *      -> require `status === "ok"` AND the served SHA to equal the released SHA
 *   3. an operator reading a bare 503 body
 *      -> cannot tell a missing database from an unconfigured SMTP password
 *
 * Rules encoded here:
 *
 * - A missing *critical* dependency (database, admin auth in production, the
 *   MySQL URL) is `unhealthy` / 503. Nothing runs without them.
 * - A missing *optional* dependency (SMTP, local ASR daemon, an AI provider)
 *   degrades a feature, not the application. It is reported, but the process is
 *   still serving requests: `degraded` / 200. Reporting 503 for "no SMTP
 *   password" made every environment look down and is what kept the public
 *   probe red while the app was fine.
 * - The status word is `healthy` so that it reads correctly next to
 *   `degraded` and `unhealthy`; `legacyStatus` keeps the older
 *   COMPLETE/PARTIAL vocabulary for anything still reading it.
 * - The public body never contains paths, hostnames, provider names or
 *   credentials — only check names. Details stay behind `?details=1`.
 */

export const HEALTH_STATUS = {
  healthy: { httpStatus: 200, legacy: "COMPLETE" },
  degraded: { httpStatus: 200, legacy: "PARTIAL" },
  unhealthy: { httpStatus: 503, legacy: "PARTIAL" },
};

/**
 * @param {Array<{name: string, ok: boolean, critical: boolean}>} checks
 * @returns {{status: string, httpStatus: number, legacyStatus: string,
 *            failedCritical: string[], failedOptional: string[]}}
 */
export function summarizeChecks(checks) {
  const failedCritical = checks.filter((check) => check.critical && !check.ok).map((check) => check.name);
  const failedOptional = checks.filter((check) => !check.critical && !check.ok).map((check) => check.name);
  const status = failedCritical.length ? "unhealthy" : failedOptional.length ? "degraded" : "healthy";
  const { httpStatus, legacy } = HEALTH_STATUS[status];
  return { status, httpStatus, legacyStatus: legacy, failedCritical, failedOptional };
}

/**
 * Two different questions, deliberately two different predicates:
 *
 *   `isServing`  "is this process answering requests?" — a deploy gate asks this
 *                before it refuses a rollout. `degraded` qualifies: one optional
 *                feature is unconfigured, the app still serves every route.
 *   `isHealthy`  "is every check green?" — an operator dashboard asks this, and
 *                `degraded` must not be reported as fully healthy.
 *
 * `ok` is accepted in both as the pre-rename spelling.
 */
export const SERVING_STATUSES = ["healthy", "degraded", "ok"];
export const HEALTHY_STATUSES = ["healthy", "ok"];

export function isServing(status) {
  return SERVING_STATUSES.includes(String(status ?? ""));
}

export function isHealthy(status) {
  return HEALTHY_STATUSES.includes(String(status ?? ""));
}

// Declared before their first use: an earlier revision read `FULL_SHA` above its
// `const` declaration, which is a temporal-dead-zone ReferenceError at runtime —
// masked once in tests because the module had already been imported elsewhere.
const FULL_SHA = /^[0-9a-f]{40}$/;
const PLACEHOLDERS = new Set(["", "unknown", "undefined", "null", "none", "dev", "local"]);

/**
 * Resolves which commit this process is actually serving.
 *
 * `RELEASE_SHA` alone was not enough: the PM2 environment in
 * `ecosystem.learn.config.cjs` still carries the old hard-coded
 * `285ae784…` (and is only a reference template), so a fresh deploy that forgot
 * the variable reported `releaseSha: "unknown"` and the deploy gate could never
 * match the released SHA. Every source below is either written by the deploy
 * script (the `RELEASE_SHA` file next to `server.js`) or set by the platform.
 *
 * Only a full 40-character hex SHA is accepted; a short SHA or a placeholder is
 * not evidence of a release.
 *
 * @param {{ env?: Record<string, string|undefined>, files?: Record<string, string> }} input
 * @returns {{ sha: string, shortSha: string, source: string }}
 */
export function resolveReleaseSha({ env = {}, files = {} } = {}) {
  const envSources = ["RELEASE_SHA", "GIT_SHA", "GITHUB_SHA", "COMMIT_SHA", "SOURCE_VERSION"];
  for (const name of envSources) {
    const value = String(env[name] ?? "").trim().toLowerCase();
    if (FULL_SHA.test(value)) return format(value, name);
  }
  for (const [name, raw] of Object.entries(files)) {
    const value = String(raw ?? "").trim().split(/\s+/)[0].toLowerCase();
    if (FULL_SHA.test(value)) return format(value, name);
  }
  // Last: the SHA inlined at build time by next.config.ts. It is read directly
  // (not via `env[name]`) because a dynamic lookup is not inlined by the
  // bundler, and it ranks last so the deploy script's RELEASE_SHA always wins.
  const buildSha = String(process.env.ALO_BUILD_SHA ?? "").trim().toLowerCase();
  if (FULL_SHA.test(buildSha)) return format(buildSha, "ALO_BUILD_SHA");
  return { sha: "unknown", shortSha: "unknown", source: "unresolved" };
}

function format(sha, source) {
  if (PLACEHOLDERS.has(sha)) return { sha: "unknown", shortSha: "unknown", source: "unresolved" };
  return { sha, shortSha: sha.slice(0, 7), source };
}

/** File names the deploy writes next to `server.js`. Read in order. */
export const RELEASE_SHA_FILES = ["RELEASE_SHA", ".release-sha", "BUILD_SHA"];
