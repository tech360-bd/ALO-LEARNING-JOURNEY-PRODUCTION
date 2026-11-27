import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The standalone build must be self-describing about what it is missing.
 *
 * `next build` deletes `.next/standalone`, so `.env` (never in Git) is gone after
 * every build. On the documented cutover a rebuild therefore used to strip the
 * server's environment and the app answered 503 `authentication_not_configured`
 * with no DATABASE_URL — a failure that looks like a broken release but is a
 * missing file. `scripts/verify-standalone.mjs` now runs at the end of both build
 * scripts and names the missing pieces.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/verify-standalone.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** Build a throwaway `.next/standalone` tree and run the verifier against it. */
function verify(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alo-standalone-"));
  const base = path.join(dir, ".next/standalone");
  fs.mkdirSync(base, { recursive: true });
  for (const entry of tree) {
    const full = path.join(base, entry);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.endsWith(".node") ? "" : "x");
  }
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Everything the build is responsible for copying, minus `.env` and engines. */
const COMPLETE = [
  "server.js",
  ".next/static/chunk.js",
  "public/favicon.ico",
  "prisma/schema.prisma",
  "scripts/long-video-worker.mjs",
  "scripts/services/faster_whisper_server.py",
  "scripts/services/piper_server.py",
  "src/lib/local-audio.ts",
  "src/lib/long-video-plan.ts",
  "RELEASE_SHA",
];

test("both build scripts run the standalone verifier", () => {
  for (const name of ["build", "build:prod"]) {
    assert.match(pkg.scripts[name], /node scripts\/verify-standalone\.mjs/, `${name} must verify the artifact`);
    // It has to come after the release marker, which the verifier checks for.
    assert.ok(
      pkg.scripts[name].indexOf("write-release-sha") < pkg.scripts[name].indexOf("verify-standalone"),
      `${name} must verify after write-release-sha`,
    );
  }
});

test("a complete artifact passes", () => {
  const result = verify(COMPLETE);
  assert.equal(result.code, 0, result.out);
});

test("a missing runtime daemon fails the build instead of shipping silently", () => {
  // [asset, the text the operator will see]
  for (const [asset, named] of [
    ["scripts/services/faster_whisper_server.py", "faster_whisper_server.py"],
    ["scripts/services/piper_server.py", "piper_server.py"],
    ["scripts/long-video-worker.mjs", "long-video-worker.mjs"],
    [".next/static/chunk.js", ".next/static"],
  ]) {
    const result = verify(COMPLETE.filter((entry) => entry !== asset));
    assert.equal(result.code, 1, `${asset} removed should fail verification`);
    assert.ok(result.out.includes(named), `the failure must name ${named}: ${result.out}`);
  }
});

test("a missing .env is reported but does not fail a clean build", () => {
  // A fresh checkout has no .env, and deploy-production.sh restores one. Failing
  // the build here would make CI red for a condition the operator must resolve.
  const result = verify(COMPLETE);
  assert.equal(result.code, 0);
  const withEnv = verify([...COMPLETE, ".env"]);
  assert.equal(withEnv.code, 0);
  assert.match(withEnv.out, /complete/);

  const { out: missingEnvOut } = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alo-standalone-"));
    const base = path.join(dir, ".next/standalone");
    for (const entry of COMPLETE) {
      fs.mkdirSync(path.dirname(path.join(base, entry)), { recursive: true });
      fs.writeFileSync(path.join(base, entry), "x");
    }
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { out };
  })();
  assert.match(missingEnvOut, /\.next\/standalone\/\.env is absent/);
  assert.match(missingEnvOut, /cp -a/);
});
