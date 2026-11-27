import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Health must be diagnosable from one request.
//
// Live symptom this pins down: on the deployed box `GET /api/health` answered
// `503 {"status":"unhealthy",…}` with no clue WHICH check failed — the admin had
// to sign in and add `?details=1` to learn it was the database (and, before
// that, the admin hash). The route now returns `x-alo-health-reason`, and the
// self-hosted services are named checks so a degraded capability is visible.

const src = fs.readFileSync(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8");

test("the health response names the failing critical check", () => {
  assert.match(src, /"x-alo-health-reason": summary\.failedCritical\.join\(","\) \|\| "none"/);
  // It must be a header on every response, not only on failure.
  assert.match(src, /status: summary\.httpStatus/);
});

test("the reason header cannot leak a path, host or credential", () => {
  // Only check NAMES go into the header — the detail strings stay in ?details=1.
  assert.doesNotMatch(src, /x-alo-health-reason":\s*results/);
  assert.match(src, /x-alo-health-reason":\s*summary\.failedCritical/);
});

test("every self-hosted service the policy relies on is a named check", () => {
  for (const service of [
    "Local search (SearXNG)",
    "Local extraction (Crawl4AI)",
    "Local ASR (faster-whisper)",
    "Local TTS (Piper)",
    "Local model (Ollama)",
  ]) {
    assert.ok(src.includes(service), `health must report ${service}`);
  }
  // They are all optional: a down local service degrades the app, it must not
  // turn the probe red (the app still serves pages and chat).
  const block = src.slice(src.indexOf("async function checkLocalServices"), src.indexOf("async function checkLocalSpeech"));
  const criticalTrue = block.match(/record\(results, service\.name, true/g) ?? [];
  assert.equal(criticalTrue.length, 0, "local services must be non-critical checks");
  assert.ok((block.match(/record\(results, service\.name, false/g) ?? []).length >= 2, "they are recorded as non-critical");
});

test("each local check carries an actionable help line", () => {
  assert.match(src, /start searxng or set SEARXNG_BASE_URL/);
  assert.match(src, /python3 scripts\/services\/faster_whisper_server\.py/);
  assert.match(src, /python3 scripts\/services\/piper_server\.py/);
  assert.match(src, /ollama serve/);
  assert.match(src, /the native extractor is the fallback/);
});

test("the local service probe is bounded and cannot hang the health route", () => {
  assert.match(src, /AbortSignal\.timeout\(2_500\)/, "each probe must time out quickly");
  assert.match(src, /Promise\.all\(/, "probes run concurrently so total latency stays low");
  // A 4xx from a health path still proves the daemon is listening.
  assert.match(src, /ok = res\.status < 500/);
});

test("local services appear only in the detailed view (no extra cost on the public probe)", () => {
  const publicBranch = src.slice(src.indexOf("} else {\n    await checkDatabase(results);"));
  assert.doesNotMatch(publicBranch.slice(0, 120), /checkLocalServices/);
  assert.match(src, /checkBinary\(results, resolveFfprobeBinary\(\), \["-version"\], "FFprobe"\),\s*\n\s*checkLocalSpeech\(results\),\s*\n\s*checkLocalServices\(results\),/);
});
