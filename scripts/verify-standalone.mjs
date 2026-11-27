#!/usr/bin/env node
/**
 * Assert that a standalone build is complete enough to boot.
 *
 *   node scripts/verify-standalone.mjs            # after `npm run build`
 *   node scripts/verify-standalone.mjs --quiet    # only speak up on a problem
 *
 * Why this exists. `next build` deletes and recreates `.next/standalone`, so
 * anything a previous build copied in is gone — including `.next/standalone/.env`,
 * which `server.js` reads at boot. On the documented cutover
 * (`git pull && npm ci && npm run build && pm2 restart`) a rebuild therefore
 * silently strips the server's environment: the process starts, then answers 503
 * `authentication_not_configured` and reports "no database" because both the
 * secret and DATABASE_URL are missing. That failure looks like a broken release
 * and is actually a missing file.
 *
 * The build cannot recreate `.env` (it is deliberately not in Git), so it does
 * the next best thing: check everything that IS reproducible, and say loudly what
 * the operator must restore. This script is wired into both `npm run build`
 * scripts, so the warning cannot be skipped by rebuilding by hand.
 *
 * Exit codes: 0 = complete, 1 = a required asset is missing (do not deploy).
 * A missing `.env` is reported but NOT fatal — `scripts/deploy-production.sh`
 * restores it from the shared directory, and a fresh checkout has none.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next/standalone");
const quiet = process.argv.includes("--quiet");

const problems = [];
const notes = [];

function require(relative, reason) {
  const full = path.join(standalone, relative);
  if (!fs.existsSync(full)) problems.push(`${relative} — ${reason}`);
}

// The server itself.
require("server.js", "standalone entrypoint is missing; the build did not produce server output");
require(".next/static", "static chunks are missing; every page would render unstyled / fail to hydrate");
require("public", "public assets are missing (favicon, manifest)");
require("prisma", "Prisma schema is missing; `prisma migrate deploy` cannot run from the release");

// Runtime scripts the app spawns or documents. These are copied by the build
// scripts precisely because Next's tracer cannot see them.
require("scripts/long-video-worker.mjs", "the long-video worker is spawned by the media pipeline");
require("scripts/services/faster_whisper_server.py", "the local ASR daemon ships with the release");
require("scripts/services/piper_server.py", "the local TTS daemon ships with the release");
require("src/lib/local-audio.ts", "read at runtime for audio constraints, not bundled");
require("src/lib/long-video-plan.ts", "read at runtime for video planning, not bundled");
require("RELEASE_SHA", "release identity is missing; /api/health cannot prove which build is live");

// Prisma engines: the standalone server needs the generated client at runtime.
const engineDirs = ["node_modules/.prisma/client", "node_modules/@prisma/client"];
const engineFiles = engineDirs.flatMap((dir) => {
  const full = path.join(standalone, dir);
  return fs.existsSync(full) ? fs.readdirSync(full).filter((f) => f.endsWith(".node")) : [];
});
if (engineFiles.length === 0) {
  notes.push(
    "no Prisma query engine in the standalone tree — run `npx prisma generate` before building, or " +
      "`scripts/deploy-production.sh` copies it from the release",
  );
}

if (!fs.existsSync(path.join(standalone, ".env"))) {
  notes.push(
    ".next/standalone/.env is absent (it is never in Git and the build deletes it). Restore it before\n" +
      "     restarting, or the server boots with no DATABASE_URL / NEXTAUTH_SECRET and answers 503:\n" +
      "       cp -a <your env file> .next/standalone/.env && chmod 600 .next/standalone/.env\n" +
      "     scripts/deploy-production.sh does this from the shared directory automatically.",
  );
}

if (problems.length > 0) {
  console.error("\n[standalone] INCOMPLETE — do not deploy this build:");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  for (const note of notes) console.error(`  ! ${note}`);
  process.exit(1);
}

if (!quiet) {
  console.log(`[standalone] complete: server, static, public, prisma, runtime scripts, RELEASE_SHA${
    engineFiles.length > 0 ? `, ${engineFiles.length} Prisma engine file(s)` : ""
  }`);
  for (const note of notes) console.log(`[standalone] note: ${note}`);
}
