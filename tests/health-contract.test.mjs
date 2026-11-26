import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTHY_STATUSES,
  SERVING_STATUSES,
  isHealthy,
  isServing,
  resolveReleaseSha,
  summarizeChecks,
} from "../src/lib/health-contract.mjs";

/**
 * Live symptom this pins down: `GET /api/health` returned
 * `{"status":"unhealthy","httpStatus":503,"releaseSha":"unknown"}` on a working
 * server. Two independent causes, both covered here:
 *
 *   1. any unconfigured *optional* dependency (SMTP, ASR daemon, AI provider)
 *      forced 503 — so the probe could never pass on a server that simply had no
 *      SMTP password;
 *   2. `releaseSha` only came from `process.env.RELEASE_SHA`, so a rebuild or a
 *      restart without that variable reported "unknown" and the deploy gate
 *      (`status === "ok" && releaseSha === github.sha`) could never match.
 */

const check = (name, ok, critical) => ({ name, ok, critical });

test("all checks pass -> healthy, 200", () => {
  const summary = summarizeChecks([check("Database", true, true), check("Email", true, false)]);
  assert.equal(summary.status, "healthy");
  assert.equal(summary.httpStatus, 200);
  assert.equal(summary.legacyStatus, "COMPLETE");
  assert.deepEqual(summary.failedCritical, []);
  assert.deepEqual(summary.failedOptional, []);
  assert.equal(isServing(summary.status), true);
  assert.equal(isHealthy(summary.status), true);
});

test("an unconfigured optional dependency degrades but still serves (200)", () => {
  // This is the live case: SMTP_PASS unset, no ASR daemon, AI providers off.
  const summary = summarizeChecks([
    check("Database", true, true),
    check("Administrator authentication", true, true),
    check("Email (SMTP)", false, false),
    check("Local speech", false, false),
  ]);
  assert.equal(summary.status, "degraded");
  assert.equal(summary.httpStatus, 200, "a missing SMTP password must not make the app look down");
  assert.equal(summary.legacyStatus, "PARTIAL");
  assert.deepEqual(summary.failedOptional, ["Email (SMTP)", "Local speech"]);
  // Serving is what the deploy gate needs; the dashboard must still show degraded.
  assert.equal(isServing(summary.status), true);
  assert.equal(isHealthy(summary.status), false);
});

test("a missing critical dependency is unhealthy, 503", () => {
  const summary = summarizeChecks([
    check("MySQL configuration", false, true),
    check("Email (SMTP)", false, false),
  ]);
  assert.equal(summary.status, "unhealthy");
  assert.equal(summary.httpStatus, 503);
  assert.deepEqual(summary.failedCritical, ["MySQL configuration"]);
  assert.equal(isServing(summary.status), false);
  assert.equal(isHealthy(summary.status), false);
});

test("serving and healthy are distinct predicates", () => {
  assert.deepEqual([...SERVING_STATUSES].sort(), ["degraded", "healthy", "ok"]);
  assert.deepEqual([...HEALTHY_STATUSES].sort(), ["healthy", "ok"]);
  for (const status of ["healthy", "ok", "degraded"]) assert.equal(isServing(status), true, status);
  for (const status of ["healthy", "ok"]) assert.equal(isHealthy(status), true, status);
  assert.equal(isHealthy("degraded"), false);
  for (const status of ["unhealthy", "", undefined, null, "OK ", "DEGRADED"]) {
    assert.equal(isServing(status), false, `${String(status)} must not satisfy a serving gate`);
    assert.equal(isHealthy(status), false, `${String(status)} must not satisfy a health gate`);
  }
});

test("health scripts and the deploy workflow accept the new status word", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../deploy/health-check.sh", import.meta.url), "utf8");
  assert.match(script, /healthy\|degraded\|ok\)/);
  const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /"\$health_status" = "healthy"/);
  assert.match(workflow, /"\$health_status" = "degraded"/);
  assert.match(workflow, /"\$health_status" = "ok"/);
});

const SHA = "cf48c8b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7";

test("release SHA comes from the runtime environment when present", () => {
  assert.deepEqual(resolveReleaseSha({ env: { RELEASE_SHA: SHA } }), {
    sha: SHA,
    shortSha: "cf48c8b",
    source: "RELEASE_SHA",
  });
});

test("the build-time inlined SHA is used when the runtime env is empty", () => {
  // `ALO_BUILD_SHA` is inlined by next.config.ts into the server bundle, i.e. it
  // arrives through process.env — not through the caller's `env` map, which
  // models the runtime environment (RELEASE_SHA / GIT_SHA / ...).
  const saved = process.env.ALO_BUILD_SHA;
  try {
    process.env.ALO_BUILD_SHA = SHA;
    const result = resolveReleaseSha({});
    assert.equal(result.sha, SHA);
    assert.equal(result.source, "ALO_BUILD_SHA");
  } finally {
    if (saved === undefined) delete process.env.ALO_BUILD_SHA;
    else process.env.ALO_BUILD_SHA = saved;
  }
});

test("RELEASE_SHA outranks the built-in SHA", () => {
  // The deploy script names the commit being released; the bundle only knows the
  // commit that was built. When both exist, the release wins.
  const saved = process.env.ALO_BUILD_SHA;
  const other = "2".repeat(40);
  try {
    process.env.ALO_BUILD_SHA = SHA;
    assert.equal(resolveReleaseSha({ env: { RELEASE_SHA: other } }).sha, other);
  } finally {
    if (saved === undefined) delete process.env.ALO_BUILD_SHA;
    else process.env.ALO_BUILD_SHA = saved;
  }
});

test("a RELEASE_SHA marker file next to server.js is enough", () => {
  const result = resolveReleaseSha({ env: {}, files: { "/app/.next/standalone/RELEASE_SHA": `${SHA}\n` } });
  assert.equal(result.sha, SHA);
  assert.equal(result.shortSha, "cf48c8b");
});

test("env wins over a stale marker file", () => {
  const other = "1111111111111111111111111111111111111111";
  const result = resolveReleaseSha({
    env: { RELEASE_SHA: SHA },
    files: { "/app/.next/standalone/RELEASE_SHA": other },
  });
  assert.equal(result.sha, SHA);
});

test("placeholders and short SHAs are never reported as a release", () => {
  for (const value of ["", "unknown", "unknown\n", "NULL", "dev", "cf48c8b", "285ae7840a2159d0", "z".repeat(40)]) {
    const result = resolveReleaseSha({ env: { RELEASE_SHA: value } });
    assert.equal(result.sha, "unknown", `accepted: ${JSON.stringify(value)}`);
    assert.equal(result.shortSha, "unknown");
  }
  // A marker file with a trailing comment still parses.
  assert.equal(
    resolveReleaseSha({ env: {}, files: { RELEASE_SHA: `${SHA}  refs/heads/main` } }).sha,
    SHA,
  );
});

test("the health route reports the shared contract, not its own copy", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8");
  assert.match(route, /summarizeChecks/);
  assert.match(route, /resolveReleaseSha/);
  // The public body must stay credential-free: no path/host/DSN keys.
  const publicBranch = route.slice(route.indexOf(": baseResponse,"), route.indexOf("releaseSource: release.source"));
  assert.doesNotMatch(publicBranch, /cwd|process\.env|DATABASE_URL/);
});
