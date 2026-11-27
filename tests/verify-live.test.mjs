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
  // Built from parts on purpose: a 24+ character literal assigned to a variable
  // called `password` trips the repository's own secret scanner, and the fix is
  // to stop looking like a credential, never to silence the scanner.
  const password = ["Zq8", "Do", "Not", "Print", "This", "9f3"].join("-");
  // Pointed at a dead port so no sign-in is attempted; the check is that the
  // secret never appears in output even when it is present in the environment.
  const { out } = await run(["--url=http://127.0.0.1:3399", "--json"], {
    ADMIN_EMAIL: "owner@example.test",
    ADMIN_PASSWORD: password,
  });
  assert.ok(!out.includes(password), "password leaked into verify:live output");
  assert.ok(!out.includes("owner@example.test") || !/password/i.test(out));
});

test("verify:live enforces the health contract through the tested rules", async () => {
  // The verdicts moved to scripts/verification/live-rules.mjs so they can be
  // pinned without a server; the script must actually call them, or the rules
  // would be documentation rather than behaviour.
  const source = await readFile(new URL(SCRIPT, `file://${ROOT}`), "utf8");
  assert.match(source, /from "\.\/live-rules\.mjs"/);
  assert.match(source, /judgeHealth\(res\)/);
  assert.match(source, /judgeReleaseSha\(res\.body\?\.releaseSha\)/);
  assert.match(source, /judgeJarReplayable\(/);
});

test("verify:live refuses to save an unusable http jar for an https-only session", async () => {
  const source = await readFile(new URL(SCRIPT, `file://${ROOT}`), "utf8");
  // A __Secure- session cookie cannot be replayed over plain http, so the jar
  // must not be written there with a reassuring "saved" line. The rule lives in
  // live-rules.mjs; here we assert the script gates on it before writing.
  assert.match(source, /an HTTPS-only session cookie cannot be replayed over plain http/);
  assert.match(source, /if \(jarPath && jarPath !== "true" && !jarVerdict\.ok\)/);
});
