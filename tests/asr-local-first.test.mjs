import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * The ASR studio route used to call the Z.AI cloud SDK directly and return the
 * provider's exception text as the HTTP error body. With no daemon and no key
 * that surfaced as `500 {"error":"No number after minus sign in JSON at
 * position 1"}` — a parse error from the SDK, not a statement about this
 * server. The route now goes through the documented local-first engine chain
 * and reports "no engine configured" with the provider matrix.
 */

const ROUTE = "src/app/api/asr-transcribe/route.ts";

test("the ASR studio uses the local-first engine chain", async () => {
  const source = await read(ROUTE);
  assert.match(source, /from "@\/lib\/asr-engine"/);
  assert.match(source, /await transcribe\(/);
  // The local chain must be the only transcription path.
  assert.doesNotMatch(source, /z-ai-web-dev-sdk/);
  assert.doesNotMatch(source, /assertExternalAiAllowed/);
});

test("an unavailable engine is a 503 with the provider matrix, not a parse error", async () => {
  const source = await read(ROUTE);
  assert.match(source, /error: "asr_engine_unavailable"/);
  assert.match(source, /status: 503/);
  assert.match(source, /providers: getAsrProviderStatus\(\)/);
  // A missing engine must be recorded as failed, never as an empty success.
  assert.match(source, /status: "failed"/);
});

test("raw provider and JSON errors are never returned to the browser", async () => {
  const source = await read(ROUTE);
  assert.doesNotMatch(source, /error: \(e as Error\)\.message/);
  assert.doesNotMatch(source, /error: \(asrErr as Error\)\.message/);
  // Three distinct causes, three distinct answers: a bad body is the caller's
  // fault (400), an unreachable database and a dead engine are both "a
  // dependency is down, not this route" (503). The classifier is asserted here
  // because the ordering — database before parse — is what stops a DB outage
  // being reported as a malformed payload.
  assert.match(
    source,
    /error: parseFailure \? "invalid_request_body" : databaseFailure \? "database_unavailable" : "asr_failed"/,
  );
  assert.match(source, /const parseFailure = !databaseFailure &&/);
  assert.match(source, /Send JSON: \{ audioBase64, format, fileName\?, language\? \}\./);
  // 500 is never a correct answer from this route: the body is validated before
  // anything else, and everything after it is a dependency failure.
  assert.doesNotMatch(source, /status: 500/);
});

test("the engine chain still prefers local daemons before the cloud fallback", async () => {
  const engine = await read("src/lib/asr-engine.ts");
  const faster = engine.indexOf("if (process.env.FASTER_WHISPER_URL)");
  const whisperx = engine.indexOf("if (process.env.WHISPERX_URL &&");
  const whisperCpp = engine.indexOf("if (process.env.WHISPER_CPP_URL)");
  const cloud = engine.indexOf("createApprovedZai()");
  assert.ok(faster > 0 && whisperx > faster && whisperCpp > whisperx, "local daemons keep their order");
  assert.ok(cloud > whisperCpp, "the approved Z.AI fallback stays behind the local daemons");
});
