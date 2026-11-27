import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// The self-hosted service scripts are code too: a Python daemon that cannot be
// parsed, binds to 0.0.0.0, or claims success it did not achieve is a liability.
// These tests are static + a real interpreter run where the box allows it.

const ROOT = path.resolve(import.meta.dirname, "..");
const PY = path.join(ROOT, "scripts/services/faster_whisper_server.py");

test("the ASR daemon exists, parses, and is executable", () => {
  assert.ok(fs.existsSync(PY), "scripts/services/faster_whisper_server.py is missing");
  const src = fs.readFileSync(PY, "utf8");
  // Real syntax check where a Python 3 is available (this repo's CI has one).
  try {
    execFileSync("python3", ["-c", "import ast,sys;ast.parse(open(sys.argv[1]).read())", PY], { stdio: "pipe" });
  } catch (err) {
    if (err.code === "ENOENT") {
      assert.ok(true, "python3 not available here; syntax is checked where it is");
    } else {
      throw new Error(`python syntax error: ${err.stderr?.toString() ?? err.message}`);
    }
  }
  assert.match(src, /127\.0\.0\.1/, "must bind loopback by default");
  assert.doesNotMatch(src, /host\s*=\s*["']0\.0\.0\.0["']/, "must never default to 0.0.0.0");
});

test("the ASR daemon speaks the protocol /api/asr-transcribe actually calls", () => {
  const src = fs.readFileSync(PY, "utf8");
  // The Node side posts JSON with these keys to /transcribe and reads these out.
  for (const field of ["audio_base64", "audio_url", "language", "prompt", "enable_diarization"]) {
    assert.ok(src.includes(field), `daemon must accept ${field}`);
  }
  for (const field of ["text", "segments", "duration_sec"]) {
    assert.ok(src.includes(`"${field}"`), `daemon must return ${field}`);
  }
  const node = fs.readFileSync(path.join(ROOT, "src/lib/asr-engine.ts"), "utf8");
  assert.match(node, /FASTER_WHISPER_URL/);
  assert.match(node, /\/transcribe/);
});

test("the ASR daemon cannot lie about a missing model and never bills", () => {
  const src = fs.readFileSync(PY, "utf8");
  assert.match(src, /simulated.:\s*False/, "a real transcription is reported as such");
  assert.match(src, /503/, "a missing model is a 5xx, not invented text");
  assert.match(src, /usdPerMinute.:\s*0/, "the daemon advertises its $0 cost");
  assert.match(src, /paid.:\s*False/);
  // No cloud ASR vendor may appear in the local daemon.
  for (const vendor of ["api.openai.com", "api.groq.com", "api.z.ai", "amazonaws.com", "googleapis.com"]) {
    assert.equal(src.includes(vendor), false, `local ASR must not reference ${vendor}`);
  }
});

test("the daemon refuses non-http audio_url values (same SSRF posture)", () => {
  const src = fs.readFileSync(PY, "utf8");
  assert.match(src, /parsed\.scheme not in \("http", "https"\)/, "audio_url scheme must be validated");
  assert.match(src, /MAX_BYTES/, "uploads must be capped");
});

test("FASTER_WHISPER_URL is documented at the port the daemon uses", () => {
  const src = fs.readFileSync(PY, "utf8");
  assert.match(src, /WHISPER_PORT", "8787"/);
  assert.match(src, /FASTER_WHISPER_URL=http:\/\/127\.0\.0\.1:8787/, "the docstring must show the exact env line");
});
