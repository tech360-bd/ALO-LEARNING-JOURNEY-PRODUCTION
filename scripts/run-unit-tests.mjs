#!/usr/bin/env node
/**
 * Run the unit-test suite and make a failure READABLE where the logs are not.
 *
 * Why this exists: when `npm test` fails in CI, the only thing the check-run API
 * exposes is "Process completed with exit code 1" — the TAP output lives in a log
 * blob an operator may not be able to reach (and an agent certainly cannot). That
 * turns a one-line fix into an investigation.
 *
 * This wrapper runs the exact same command, parses TAP, and emits one GitHub
 * `::error` annotation per failing test (name + first line of the diagnostic), so
 * the failing test is visible on the PR and through
 * `GET /repos/{owner}/{repo}/check-runs/{id}/annotations`.
 *
 * It never changes the outcome: the child's exit code is the exit code. It also
 * refuses to look clean if the child printed `not ok` but exited 0 — that would
 * be a green report over a real failure.
 *
 * Usage: node scripts/run-unit-tests.mjs            (same as npm test)
 *        UNIT_TEST_DEBUG=1 node … --verbose         (per-file breakdown)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERBOSE = process.env.UNIT_TEST_DEBUG === "1";
const inActions = process.env.GITHUB_ACTIONS === "true";

const args = ["--experimental-strip-types", "--import", "./tests/ts-alias-loader.mjs", "--test", "tests/*.test.mjs"];

/** Files the glob expands to, so a crash before any test still names the file. */
function testFiles() {
  const dir = path.join(ROOT, "tests");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
}

function annotate(level, title, message) {
  // Escape per GitHub's workflow-command rules.
  const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const line = `::${level} title=${esc(title)}::${esc(message)}`;
  if (inActions) process.stdout.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const started = Date.now();
const child = spawn("node", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

let output = "";
let buffered = "";
const passThrough = (chunk) => {
  const text = chunk.toString();
  output += text;
  // Echo the child's TAP line-by-line so the CI log keeps its usual shape.
  buffered += text;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) process.stdout.write(`${line}\n`);
};

child.stdout.on("data", passThrough);
child.stderr.on("data", passThrough);

child.on("close", (code, signal) => {
  if (buffered) process.stdout.write(`${buffered}\n`);
  const ms = Date.now() - started;

  // ── Parse TAP ────────────────────────────────────────────────────────────
  const lines = output.split("\n");
  const failures = [];
  const diagnostics = new Map();
  let current = null;
  for (const line of lines) {
    const notOk = /^not ok \d+ - (.*)$/.exec(line);
    if (notOk) {
      current = notOk[1].trim();
      failures.push(current);
      diagnostics.set(current, []);
      continue;
    }
    const ok = /^ok \d+ - /.test(line);
    if (ok) {
      current = null;
      continue;
    }
    if (current) {
      const detail = /^\s{2,}(error|stack|message):\s*(.*)$/.exec(line);
      if (detail) diagnostics.get(current).push(detail[2].trim());
    }
  }
  const passMatch = /^# pass (\d+)/m.exec(output);
  const failMatch = /^# fail (\d+)/m.exec(output);
  const pass = passMatch ? Number(passMatch[1]) : 0;
  const fail = failMatch ? Number(failMatch[1]) : failures.length;

  // ── Report ───────────────────────────────────────────────────────────────
  if (failures.length === 0 && fail === 0) {
    process.stdout.write(`\n✔ unit tests: ${pass} passed in ${ms}ms\n`);
  } else {
    // One annotation per failing test, so the name is readable on the PR.
    for (const name of failures) {
      const first = (diagnostics.get(name) ?? []).filter(Boolean)[0] ?? "no diagnostic captured";
      annotate("error", `Unit test failed: ${name.slice(0, 120)}`, first.slice(0, 900));
    }
    if (failures.length === 0) {
      // The child failed without a TAP failure line: it crashed, or the runner
      // itself errored. Say that plainly instead of blaming a test.
      annotate(
        "error",
        "Unit tests exited non-zero with no failing test",
        `exit=${code} signal=${signal ?? "none"} — the runner or the import step failed. Last output: ${output.trim().split("\n").slice(-3).join(" | ").slice(0, 600)}`,
      );
    }
    process.stdout.write(`\n✖ unit tests: ${fail} failed, ${pass} passed in ${ms}ms\n`);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  if (code === 0 && fail > 0) {
    // A green exit code over a printed failure is exactly the kind of dishonest
    // green this repo forbids. Never report it as success.
    annotate("error", "Unit tests reported failures with exit code 0", `${fail} failing test(s): ${failures.join(", ").slice(0, 900)}`);
    process.exit(1);
  }
  if (code === 0 && signal) process.exit(1);
  process.exit(code ?? 1);
});
