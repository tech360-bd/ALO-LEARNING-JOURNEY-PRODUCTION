import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Runtime config is the feature that removes "SSH in and edit .env". Its two
 * promises are the ones tested here:
 *   1. a secret is never stored or returned in the clear;
 *   2. a real environment variable can never be shadowed by a dashboard value.
 */
const MODULE = "../src/lib/runtime-config.ts";

async function withSandbox(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "alo-config-"));
  const file = path.join(dir, "config.json");
  const saved = {
    file: process.env.ALO_RUNTIME_CONFIG_FILE,
    vault: process.env.VAULT_MASTER_KEY,
    groq: process.env.GROQ_API_KEY,
    switch1: process.env.ALO_PAID_AI_API_ALLOWED,
    switch2: process.env.ALO_OWNER_APPROVED_PAID_AI_API,
  };
  process.env.ALO_RUNTIME_CONFIG_FILE = file;
  // 32-byte base64 master key (test-only, never a real secret).
  process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  for (const name of ["GROQ_API_KEY", "ALO_PAID_AI_API_ALLOWED", "ALO_OWNER_APPROVED_PAID_AI_API"]) {
    delete process.env[name];
  }
  try {
    const mod = await import(MODULE);
    mod._resetConfigCache();
    return await run({ mod, file, dir });
  } finally {
    for (const [key, envName] of [
      ["file", "ALO_RUNTIME_CONFIG_FILE"],
      ["vault", "VAULT_MASTER_KEY"],
      ["groq", "GROQ_API_KEY"],
      ["switch1", "ALO_PAID_AI_API_ALLOWED"],
      ["switch2", "ALO_OWNER_APPROVED_PAID_AI_API"],
    ]) {
      if (saved[key] === undefined) delete process.env[envName];
      else process.env[envName] = saved[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("a secret is encrypted at rest, masked on read, and never echoed", async () => {
  await withSandbox(async ({ mod, file }) => {
    const secret = ["gsk", "test", "do", "not", "leak", "me", 123456].join("_");
    const result = await mod.setRuntimeValue("GROQ_API_KEY", secret, { updatedBy: "owner" });
    assert.equal(result.ok, true, result.error);
    assert.match(result.masked, /^\*{4}/);

    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes(secret), "plaintext secret must never reach the config file");
    assert.match(raw, /"cipher"/);

    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, "config file must not be world-readable");

    // It still resolves for the app, through the vault.
    mod._resetConfigCache();
    assert.equal(await mod.runtimeEnv("GROQ_API_KEY"), secret);

    // …but the dashboard view shows only the mask.
    const view = (await mod.listRuntimeConfig()).find((v) => v.name === "GROQ_API_KEY");
    assert.equal(view.source, "dashboard");
    assert.ok(!view.display.includes("do_not_leak"), view.display);
    assert.match(view.display, /^\*{4}/);
  });
});

test("a real environment variable always wins over a dashboard value", async () => {
  await withSandbox(async ({ mod }) => {
    await mod.setRuntimeValue("GROQ_MODEL", "dashboard-model");
    mod._resetConfigCache();
    assert.equal(await mod.runtimeEnv("GROQ_MODEL"), "dashboard-model");

    process.env.GROQ_MODEL = "env-model";
    mod._resetConfigCache();
    assert.equal(await mod.runtimeEnv("GROQ_MODEL"), "env-model");
    const view = (await mod.listRuntimeConfig()).find((v) => v.name === "GROQ_MODEL");
    assert.equal(view.source, "environment");
    delete process.env.GROQ_MODEL;
  });
});

test("only allowlisted names are writable, so the endpoint cannot inject NODE_OPTIONS", async () => {
  await withSandbox(async ({ mod }) => {
    for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "PATH", "ALO_CUSTOM_AI_PROVIDERS_JSON"]) {
      const result = await mod.setRuntimeValue(name, "--require /tmp/evil.js");
      assert.equal(result.ok, false, `${name} must not be writable`);
      assert.match(result.error, /not an allowlisted setting/);
    }
  });
});

test("bad values are rejected with a reason instead of saved", async () => {
  await withSandbox(async ({ mod }) => {
    const cases = [
      ["ALO_MEDIA_DIR", "x".repeat(4001), /too long/],
      ["SMTP_PORT", "not-a-port", /must be a number/],
      ["OMNIROUTE_BASE_URL", "ftp://example.com/v1", /http/],
      ["ADMIN_OTP_REQUIRED", "yes", /true or false/],
      ["GROQ_API_KEY", "REPLACE_WITH_YOUR_KEY", /placeholder/],
    ];
    for (const [name, value, pattern] of cases) {
      const result = await mod.setRuntimeValue(name, value);
      assert.equal(result.ok, false, `${name}=${value} should be rejected`);
      assert.match(result.error, pattern);
    }
  });
});

test("clearing a value removes it and falls back to the default", async () => {
  await withSandbox(async ({ mod }) => {
    await mod.setRuntimeValue("SMTP_PORT", "2525");
    mod._resetConfigCache();
    assert.equal(await mod.runtimeEnv("SMTP_PORT"), "2525");

    await mod.setRuntimeValue("SMTP_PORT", null);
    mod._resetConfigCache();
    assert.equal(await mod.runtimeEnv("SMTP_PORT"), undefined);
    const view = (await mod.listRuntimeConfig()).find((v) => v.name === "SMTP_PORT");
    assert.equal(view.source, "default");
    assert.equal(view.display, "465");
  });
});

test("a tampered or foreign secret is reported unset, never as a wrong value", async () => {
  await withSandbox(async ({ mod }) => {
    await mod.setRuntimeValue("GROQ_API_KEY", "secret-value-for-rotation-test");

    // A tampered envelope (GCM auth tag mismatch) must fail closed. Using a wrong
    // key is the same code path; the vault caches the master key per process, so
    // rotation takes a restart — which is why VAULT_MASTER_KEY is marked
    // restartRequired in the dashboard.
    const { resolveValue } = mod;
    assert.equal(resolveValue("GROQ_API_KEY", { cipher: "1:AAAA:BBBB:CCCC", updatedAt: "x" }), undefined);
    assert.equal(resolveValue("GROQ_API_KEY", { cipher: "not-an-envelope", updatedAt: "x" }), undefined);

    // And the real value still resolves for the app.
    mod._resetConfigCache();
    assert.equal(await mod.runtimeEnv("GROQ_API_KEY"), "secret-value-for-rotation-test");
  });
});

test("a cold cache still sees the file, so a route without the async prime works", async () => {
  await withSandbox(async ({ mod }) => {
    await mod.setRuntimeValue("SMTP_PORT", "2587");
    // Simulate the first read in a freshly started worker: no async prime has run.
    mod._resetConfigCache();
    assert.equal(mod.runtimeEnvSync("SMTP_PORT"), "2587");
  });
});

test("the owner switches can be set from the dashboard and still both be required", async () => {
  await withSandbox(async ({ mod }) => {
    const { isExternalAiAllowed } = await import("../src/lib/agentos/payment-guard.ts");
    mod._resetConfigCache();
    await mod.primeRuntimeConfig();
    assert.equal(isExternalAiAllowed(), false, "nothing set = closed");

    await mod.setRuntimeValue("ALO_PAID_AI_API_ALLOWED", "true");
    mod._resetConfigCache();
    await mod.primeRuntimeConfig();
    assert.equal(isExternalAiAllowed(), false, "one switch is never enough");

    await mod.setRuntimeValue("ALO_OWNER_APPROVED_PAID_AI_API", "true");
    mod._resetConfigCache();
    await mod.primeRuntimeConfig();
    assert.equal(isExternalAiAllowed(), true);
  });
});

test("restart-required fields say so, and boot-time ones are marked", async () => {
  await withSandbox(async ({ mod }) => {
    const result = await mod.setRuntimeValue("DATABASE_URL", "mysql://u:p@127.0.0.1:3306/db");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.restartRequired, true);
    const fast = await mod.setRuntimeValue("GROQ_MODEL", "llama-3.3-70b-versatile");
    assert.equal(fast.restartRequired, false);
  });
});
