import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const SCRIPT = "scripts/verification/verify-live.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, `file://${ROOT}`), "utf8"));
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("verify:live and smoke:standalone are wired as npm scripts", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.scripts["verify:live"], "node scripts/verification/verify-live.mjs");
  assert.equal(pkg.scripts["smoke:standalone"], "node scripts/verification/smoke-standalone.mjs");
});

test("verify:live exits non-zero for a fully local check that fails", async () => {
  // A closed port on loopback: the acceptance check must report a failure and
  // set a non-zero exit code, because deploy gates read the exit code, not the
  // prose. A green script over a dead app would be worse than no script.
  const { code, out } = await run(["--url=http://127.0.0.1:3399", "--no-auth", "--json"], {
    ADMIN_EMAIL: "",
    ADMIN_PASSWORD: "",
  });
  assert.equal(code, 1, out);
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  assert.equal(parsed.base, "http://127.0.0.1:3399");
  assert.ok(parsed.failed > 0);
  assert.equal(parsed.results[0].ok, false);
  assert.match(parsed.results[0].name, /connection|GET \/api\/health/);
});

test("verify:live never echoes the password it was given", async () => {
  const password = "Zq8-Do-Not-Print-This-9f3";
  // Pointed at a dead port so no sign-in is attempted; the check is that the
  // secret never appears in output even when it is present in the environment.
  const { out } = await run(["--url=http://127.0.0.1:3399", "--json"], {
    ADMIN_EMAIL: "owner@example.test",
    ADMIN_PASSWORD: password,
  });
  assert.ok(!out.includes(password), "password leaked into verify:live output");
  assert.ok(!out.includes("owner@example.test") || !/password/i.test(out));
});

test("verify:live documents the health contract it enforces", async () => {
  const source = await readFile(new URL(SCRIPT, `file://${ROOT}`), "utf8");
  // `degraded` must pass: the deploy contract says optional checks failing is a
  // 200, and a script that demanded "healthy" would fail a correct deploy.
  assert.match(source, /\["healthy", "degraded"\]\.includes\(status\)/);
  assert.match(source, /res\.status === 200/);
  // A real release identity is part of the gate, not decoration.
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
});
