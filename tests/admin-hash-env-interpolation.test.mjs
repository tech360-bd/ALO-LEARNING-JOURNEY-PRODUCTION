import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes, scryptSync } from "node:crypto";
import { adminPasswordHashConfigured, adminPasswordHashStatus, parseAdminPasswordHash } from "../src/lib/auth-config.ts";
import { verifyAdminCredentials } from "../src/lib/admin-password.ts";

const require = createRequire(import.meta.url);

const PASSWORD = "A-long-test-password-42";
// Format-only hash with a letter-initial salt: `.env` interpolation only eats a
// `$` that is followed by a letter, so a random salt makes the loader's
// behaviour nondeterministic. The verification test below uses a real hash.
const FORMAT_HASH = `scrypt$${"A".repeat(22)}$${"B".repeat(86)}`;
const salt = randomBytes(16);
const digest = scryptSync(PASSWORD, salt, 64);
const HASH = `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;

/** What `.env` interpolation leaves behind for an unescaped hash. */
function expandLikeDotenv(value) {
  const [algorithm, first, second] = value.split("$");
  return `${algorithm}${first}${second}`;
}

test("a literal scrypt hash is accepted", () => {
  assert.equal(parseAdminPasswordHash(HASH), HASH);
  assert.equal(parseAdminPasswordHash(`  ${HASH}\n`), HASH);
  assert.equal(parseAdminPasswordHash(`"${HASH}"`), HASH);
});

test("a .env-escaped hash is accepted", () => {
  const escaped = HASH.replace(/\$/g, "\\$");
  assert.equal(parseAdminPasswordHash(escaped), HASH);
});

test("a dotenv-expanded hash is rejected and reported as interpolated", () => {
  // The separators and part of the random material are gone, so the original
  // hash cannot be reconstructed — guessing a split would be a security bug.
  const expanded = expandLikeDotenv(HASH);
  assert.notEqual(expanded, HASH);
  assert.equal(parseAdminPasswordHash(expanded), null);
  assert.deepEqual(adminPasswordHashStatus(expanded), { state: "interpolated" });
});

test("the real Next.js env loader reproduces the failure and the parser survives it", async () => {
  // This is the exact production symptom: the hash is present in .env, Next
  // loads it, and the value no longer matches — so the login page reports
  // "Administrator sign-in is not configured" while the operator sees the hash
  // in the file. @next/env caches its result per process, so each variant is
  // loaded in a child process.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

  // The directory travels in an env var so the probe does not depend on how
  // `node -e` maps extra argv entries.
  const probe = `
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(process.env.ALO_ENV_PROBE_DIR, false, { info() {}, error() {} });
    process.stdout.write(JSON.stringify({ value: process.env.ADMIN_PASSWORD_HASH ?? "" }));
  `;

  for (const [label, line, expectValid] of [
    ["bare", FORMAT_HASH, false],
    ["escaped", FORMAT_HASH.replace(/\$/g, "\\$"), true],
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), `alo-env-${label}-`));
    await writeFile(path.join(dir, ".env"), `ADMIN_PASSWORD_HASH=${line}\n`);
    const { stdout, stderr } = await run(
      process.execPath,
      ["-e", probe],
      // ADMIN_PASSWORD_HASH must be ABSENT here: @next/env never overrides a
      // variable that already exists, even an empty one.
      { cwd: projectDir, env: { PATH: process.env.PATH, ALO_ENV_PROBE_DIR: dir } },
    );
    const loaded = JSON.parse(stdout).value;
    assert.equal(
      parseAdminPasswordHash(loaded) !== null,
      expectValid,
      `a ${label} hash must ${expectValid ? "" : "not "}validate after loadEnvConfig (loaded ${loaded.length} chars)`,
    );
    if (expectValid) assert.equal(parseAdminPasswordHash(loaded), FORMAT_HASH);
    else {
      assert.notEqual(loaded, FORMAT_HASH, "the loader is expected to rewrite a bare hash");
      assert.deepEqual(adminPasswordHashStatus(loaded), { state: "interpolated" });
    }
  }
});

test("malformed values are rejected, not guessed at", () => {
  for (const value of [
    "",
    undefined,
    "scrypt",
    "scrypt$short$short",
    `scrypt$${"a".repeat(22)}$${"b".repeat(85)}`, // one character short
    `scrypt$${"a".repeat(22)}$${"b".repeat(87)}`, // one character long
    `bcrypt$${"a".repeat(22)}$${"b".repeat(86)}`,
    `scrypt$${"a".repeat(21)}$x$${"b".repeat(86)}`,
    `scrypt!${"a".repeat(22)}!${"b".repeat(86)}`,
  ]) {
    assert.equal(parseAdminPasswordHash(value), null, `accepted: ${String(value).slice(0, 40)}`);
  }
});

test("ADMIN_OTP_REQUIRED=false does not require an SMS provider", () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_OTP_REQUIRED = "false";
    process.env.NEXTAUTH_SECRET = "test-only-secret";
    process.env.ADMIN_EMAIL = "Admin@Example.Test";
    process.env.ADMIN_PASSWORD_HASH = HASH.replace(/\$/g, "\\$");
    delete process.env.ADMIN_OTP_PHONE;
    delete process.env.HTTPSMS_API_KEY;
    delete process.env.HTTPSMS_FROM;
    assert.equal(adminPasswordHashConfigured(), true);
  } finally {
    process.env = saved;
  }
});
