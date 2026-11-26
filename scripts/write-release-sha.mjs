#!/usr/bin/env node
/**
 * Writes the release markers that `/api/health` reports as `releaseSha`.
 *
 * Run as part of `npm run build`. The deploy gate in `.github/workflows/deploy.yml`
 * requires `releaseSha` to equal the released commit, and `deploy/health-check.sh`
 * refuses to pass without it — but the value used to come only from the runtime
 * environment, so an in-place rebuild or a `pm2 restart` that lost the
 * environment reported `"unknown"` indefinitely.
 *
 * Sources, in order:
 *   1. `RELEASE_SHA` (CI / deploy script — authoritative)
 *   2. `git rev-parse HEAD` (in-place build on the server)
 *
 * With neither (a plain tarball build) nothing is written and the marker stays
 * absent — an invented SHA would be worse than an honest "unknown".
 *
 * Writes:
 *   .next/standalone/RELEASE_SHA   — read by the running server
 *   .next/standalone/.release-sha  — same value, alternate name
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/;

function resolveSha() {
  const fromEnv = (process.env.RELEASE_SHA ?? process.env.GIT_SHA ?? "").trim().toLowerCase();
  if (FULL_SHA.test(fromEnv)) return { sha: fromEnv, source: "RELEASE_SHA" };
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
    if (FULL_SHA.test(sha)) return { sha, source: "git rev-parse HEAD" };
  } catch {
    // Not a git checkout.
  }
  return { sha: null, source: "unresolved" };
}

const { sha, source } = resolveSha();
if (!sha) {
  console.warn("[release] no release SHA available (not a git checkout and RELEASE_SHA unset); /api/health will report releaseSha=unknown");
  process.exit(0);
}

const standalone = path.join(process.cwd(), ".next", "standalone");
mkdirSync(standalone, { recursive: true });
for (const name of ["RELEASE_SHA", ".release-sha"]) {
  writeFileSync(path.join(standalone, name), `${sha}\n`, { mode: 0o644 });
}
console.log(`[release] ${sha} (${source}) written to .next/standalone/RELEASE_SHA`);
