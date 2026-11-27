import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ASR failure classification.
//
// Live symptom: POST /api/asr-transcribe answered `500 {"error":"asr_failed",
// "message":"… Check the server log (database reachable ?)"}` on a box with no
// database AND no ASR daemon. Two very different operator actions (start MySQL
// vs start the whisper daemon) collapsed into one opaque 500 — and a database
// outage was reported as a speech-engine failure.
//
// The route now distinguishes them, and a missing engine is a 503 (degraded
// capability), never a 500 (the request was valid).

const src = fs.readFileSync(new URL("../src/app/api/asr-transcribe/route.ts", import.meta.url), "utf8");

test("a database failure is never reported as an ASR failure", () => {
  assert.match(src, /function isDatabaseFailure\(message: string\): boolean/);
  assert.match(src, /error: ['"]database_unavailable['"]/);
  assert.match(src, /Check DATABASE_URL and that MySQL is running/);
  // The classifier must recognise the real Prisma shapes, not just the word "db".
  for (const signal of ["prisma", "did not initialize", "P1001", "P1002", "P1017", "ECONNREFUSED"]) {
    assert.ok(src.includes(signal), `isDatabaseFailure must recognise ${signal}`);
  }
});

test("no error response is a bare 500 anymore", () => {
  // Every failure return must carry a specific code and a 400/503 status.
  const statuses = [...src.matchAll(/status:\s*(\d{3})/g)].map((m) => Number(m[1]));
  assert.ok(statuses.length >= 4, "expected explicit statuses");
  assert.equal(statuses.includes(500), false, `a 500 leaked back in: ${statuses.join(",")}`);
  for (const code of ["invalid_request_body", "database_unavailable", "asr_failed", "asr_engine_unavailable"]) {
    assert.ok(src.includes(code), `missing error code ${code}`);
  }
});

test("an absent engine returns 503 with the provider status attached", () => {
  // Search from the message forward: `} catch (e) {` also appears earlier in the
  // file (inside the provider loop), so slicing to it would yield an empty block.
  const engineBlock = src.slice(src.indexOf("The ASR engine failed to transcribe"), src.indexOf("Never forward a provider/JSON parse message"));
  assert.match(engineBlock, /status: 503/);
  assert.match(engineBlock, /providers: getAsrProviderStatus\(\)/);
});

test("the history read reports its own dependency, not a generic failure", () => {
  const getBlock = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
  assert.match(getBlock, /status: 503/);
  assert.match(getBlock, /transcription history could not be read/);
  assert.equal(/status: 500/.test(getBlock), false, "GET must not answer 500 for an unreachable database");
});

test("the smoke probe rejects a 500 for this route (it used to accept one)", () => {
  const smoke = fs.readFileSync(new URL("../scripts/verification/smoke-standalone.mjs", import.meta.url), "utf8");
  const block = smoke.slice(smoke.indexOf('"POST /api/asr-transcribe"'), smoke.indexOf('"GET /favicon.ico"'));
  assert.match(block, /asr\.status === 200 \|\| \(asr\.status === 503/);
  // The accepted-status expression must not list 500 among the successes.
  const accepted = /asr\.status === 200 \|\| \(asr\.status === 503 && \[([^\]]+)\]/.exec(block)?.[1] ?? "";
  assert.ok(accepted.length > 0, "could not read the accepted-status list");
  assert.equal(/\b500\b/.test(accepted), false, `500 is still accepted: ${accepted}`);
  assert.match(block, /500 is never correct here/);
});
