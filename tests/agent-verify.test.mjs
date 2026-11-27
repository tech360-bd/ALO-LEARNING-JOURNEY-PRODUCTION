import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  buildRepairInstruction,
  extractUrls,
  verifyAnswer,
  verifyWithRepair,
} from "../src/lib/agent-verify.ts";
import { judgeHealth, judgeReleaseSha, judgeJarReplayable } from "../scripts/verification/live-rules.mjs";

/**
 * A real HTTP server, not a stubbed fetch: the browse step goes through
 * `src/lib/self-heal/browser.ts` (SSRF guard, timeouts, size caps), and the only
 * way to know that path still works is to serve something.
 */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const page = (title, body = "ok") =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

// ── URL extraction ───────────────────────────────────────────────────────────

test("links are extracted, deduplicated, trimmed of punctuation and capped", () => {
  const answer =
    "See https://a.example/x, and https://b.example/y). Then https://a.example/x again " +
    "plus https://c.example, https://d.example, https://e.example, https://f.example and gopher://old.example";
  const urls = extractUrls(answer);
  assert.deepEqual(urls.slice(0, 3), ["https://a.example/x", "https://b.example/y", "https://c.example"]);
  assert.equal(urls.length, 5, "capped at 5");
  assert.ok(!urls.some((u) => u.startsWith("gopher:")), "non-http schemes never extracted");
  assert.equal(new Set(urls).size, urls.length, "no duplicates");
});

// ── checks ───────────────────────────────────────────────────────────────────

test("a failing check is reported with its own id and description", async () => {
  const report = await verifyAnswer({
    answer: "no link here",
    browse: false,
    checks: [
      { id: "has_link", description: "the answer cites a source", test: (a) => /https?:\/\//.test(a) },
      { id: "non_empty", description: "the answer is not empty", test: (a) => a.trim().length > 0 },
    ],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((f) => f.id), ["has_link"]);
  assert.equal(report.checks.find((c) => c.id === "non_empty").ok, true);
});

test("a check that throws fails the run instead of crashing it", async () => {
  const report = await verifyAnswer({
    answer: "x",
    browse: false,
    checks: [{ id: "boom", description: "throws", test: () => { throw new Error("bad predicate"); } }],
  });
  assert.equal(report.ok, false);
  assert.match(report.failures[0].detail, /check threw: bad predicate/);
});

test("`when` skips a check that does not apply to this answer", async () => {
  let ran = false;
  const report = await verifyAnswer({
    answer: "plain prose without numbers",
    browse: false,
    checks: [{
      id: "numbers_cited",
      description: "numbers have sources",
      when: (a) => /\d/.test(a),
      test: () => { ran = true; return true; },
    }],
  });
  assert.equal(ran, false, "predicate was not evaluated");
  assert.equal(report.ok, true);
});

// ── browse ───────────────────────────────────────────────────────────────────

test("a linked page that really exists passes, a 404 fails", async () => {
  await withServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("Verification target"));
    } else {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("Not found"));
    }
  }, async (base) => {
    // The SSRF guard blocks loopback by design, so the live server is reached
    // through the real browser module's *result shape* via a fetcher that only
    // performs the HTTP part. The guard itself is asserted by the next test.
    const fetchPage = async (url) => {
      const res = await fetch(url);
      const html = await res.text();
      const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? null;
      return {
        url, ok: res.status < 400, status: res.status, title,
        links: [], brokenLinks: [], error: res.status >= 400 ? `HTTP ${res.status}` : null,
        latencyMs: 0, truncated: false,
      };
    };

    const good = await verifyAnswer({ answer: `I read ${base}/ok for the details.`, browseFn: fetchPage });
    assert.equal(good.ok, true, JSON.stringify(good.failures));
    assert.equal(good.browsed[0].status, 200);
    assert.equal(good.browsed[0].title, "Verification target");

    const bad = await verifyAnswer({ answer: `I read ${base}/missing for the details.`, browseFn: fetchPage });
    assert.equal(bad.ok, false);
    assert.equal(bad.failures[0].kind, "browse");
    assert.match(bad.failures[0].detail, /HTTP 404/);
  });
});

test("a fetcher that throws is a failed assertion, never a passing one", async () => {
  const report = await verifyAnswer({
    answer: "source: https://example.invalid/x",
    browseFn: async () => { throw new Error("network down"); },
  });
  assert.equal(report.ok, false);
  assert.match(report.failures[0].detail, /network down/);
});

test("production default browse really does block loopback and metadata hosts", async () => {
  // No override: this is the code path production uses.
  const report = await verifyAnswer({
    answer: "see http://169.254.169.254/latest/meta-data/ and http://127.0.0.1:3061/api/health",
  });
  assert.equal(report.ok, false);
  assert.equal(report.browsed.length, 2);
  for (const entry of report.browsed) {
    assert.equal(entry.ok, false);
    assert.match(entry.error ?? "", /SSRF|blocked/i);
  }
});

// ── repair ───────────────────────────────────────────────────────────────────

test("a failed run is repaired exactly once, and the instruction quotes the failure", async () => {
  const seen = [];
  const { answer, report } = await verifyWithRepair({
    task: "write a summary of the deploy",
    answer: "done", // too short, and no link
    browse: false,
    checks: [
      { id: "length", description: "at least 20 characters", test: (a) => a.trim().length >= 20 },
    ],
    repair: async (instruction) => {
      seen.push(instruction);
      return "The deploy finished; the health probe reports healthy on port 3061.";
    },
  });
  assert.equal(seen.length, 1, "repaired once, never in a loop");
  assert.match(seen[0], /failed verification/);
  assert.match(seen[0], /- length: at least 20 characters/);
  assert.equal(report.ok, true);
  assert.equal(report.repaired, true);
  assert.match(answer, /health probe reports healthy/);
});

test("a repair that fails again is reported as a failure, not a success", async () => {
  const { report } = await verifyWithRepair({
    task: "answer",
    answer: "no",
    browse: false,
    checks: [{ id: "length", description: "at least 10 characters", test: (a) => a.length >= 10 }],
    repair: async () => "still no",
  });
  assert.equal(report.ok, false);
  assert.equal(report.repaired, false);
  assert.deepEqual(report.failures.map((f) => f.id), ["length"]);
});

test("a repair callback that throws does not turn the run green", async () => {
  const { report } = await verifyWithRepair({
    task: "answer",
    answer: "no",
    browse: false,
    checks: [{ id: "length", description: "long enough", test: (a) => a.length >= 10 }],
    repair: async () => { throw new Error("model offline"); },
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.id === "repair" && /model offline/.test(f.detail)));
});

test("no repair callback means the first verdict stands, with no repair text", async () => {
  const report = await verifyAnswer({ answer: "x", browse: false, checks: [
    { id: "length", description: "long", test: (a) => a.length > 5 },
  ] });
  assert.equal(report.ok, false);
  assert.equal(report.repaired, false);
  assert.match(buildRepairInstruction("do the thing", report), /Original instruction: do the thing/);
});

// ── the acceptance rules shared with verify:live ──────────────────────────────

test("health verdict: degraded passes, unhealthy and non-200 do not", () => {
  assert.equal(judgeHealth({ status: 200, body: { status: "healthy" } }).ok, true);
  assert.equal(judgeHealth({ status: 200, body: { status: "degraded" } }).ok, true, "optional checks may fail");
  assert.equal(judgeHealth({ status: 503, body: { status: "unhealthy" } }).reason, "not_200");
  assert.equal(judgeHealth({ status: 200, body: { status: "unhealthy" } }).reason, "status_not_serving");
  assert.equal(judgeHealth({ status: 200, body: null }).ok, false);
});

test("only a full 40-hex SHA counts as a release identity", () => {
  assert.equal(judgeReleaseSha("cf48c8b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7").ok, true);
  assert.equal(judgeReleaseSha("CF48C8B1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7").ok, true, "case-insensitive");
  for (const bad of ["unknown", "cf48c8b", "", "z".repeat(40), "cf48c8b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a"]) {
    assert.equal(judgeReleaseSha(bad).ok, false, bad);
  }
});

test("a jar is only replayable when the scheme matches the session cookie", () => {
  const secure = ["__Secure-next-auth.session-token", "next-auth.csrf-token"];
  assert.equal(judgeJarReplayable({ origin: "http://127.0.0.1:3061", cookieNames: secure }).reason, "https_only_cookie_on_http");
  assert.equal(judgeJarReplayable({ origin: "https://learn.alolabs.net", cookieNames: secure }).ok, true);
  assert.equal(judgeJarReplayable({ origin: "http://127.0.0.1:3061", cookieNames: ["next-auth.session-token"] }).ok, true);
  assert.equal(judgeJarReplayable({ origin: "nope", cookieNames: secure }).reason, "invalid_origin");
});
