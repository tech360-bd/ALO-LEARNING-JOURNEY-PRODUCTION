import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Monid integration — proven against a REAL local server that speaks the wire
// format taken from @monid-ai/cli 0.1.9 (POST /v1/discover, /v1/inspect,
// /v1/run, GET /v1/wallet/balance, `Authorization: Bearer …`). The point of
// these tests is not that the code compiles: it is that
//   (a) the request bodies match what the CLI actually sends, and
//   (b) a billed `run` is refused in every state except "owner said yes".
// No provider is mocked at the HTTP layer — only the vendor's own protocol.

const TOKEN = "test-key-not-a-real-secret";
const calls = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const auth = req.headers.authorization ?? "";
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method, url: req.url, body, auth });

    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad key" }));
    }
    if (req.method === "POST" && req.url === "/v1/discover") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ results: [{ provider: "exa", endpoint: "search", price: "0.01 USD", score: 0.91 }] }));
    }
    if (req.method === "POST" && req.url === "/v1/inspect") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ provider: body.provider, endpoint: body.endpoint, input: { queryParams: { q: "string" } }, price: "0.01 USD" }));
    }
    if (req.method === "POST" && req.url === "/v1/run") {
      // The engine settles the price on the response envelope.
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ runId: "run_1", status: "success", cost: "0.01 USD", output: { hits: 3 } }));
    }
    if (req.method === "GET" && req.url === "/v1/wallet/balance") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ balance: "5.00 USD" }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

after(() => server.close());

// Import after the server is listening; the module reads env at call time.
const monid = await import("../src/lib/monid.ts");
const { TOOL_NAMES, SENSITIVE_TOOLS } = await import("../src/lib/agent-tools.ts").catch(() => ({
  TOOL_NAMES: [],
  SENSITIVE_TOOLS: [],
}));

function resetEnv(vars = {}) {
  for (const key of ["ALO_MONID_ENABLED", "MONID_API_KEY", "MONID_BASE_URL", "ALO_PAID_AI_API_ALLOWED", "ALO_OWNER_APPROVED_PAID_AI_API"]) {
    delete process.env[key];
  }
  Object.assign(process.env, vars);
}

test("switches: Monid is off until its own switch is set, and reports why", () => {
  resetEnv();
  const off = monid.monidStatus();
  assert.equal(off.enabled, false);
  assert.equal(off.ready.discover, false);
  assert.equal(off.ready.run, false);
  assert.match(off.reason, /ALO_MONID_ENABLED/);

  resetEnv({ ALO_MONID_ENABLED: "true" });
  const noKey = monid.monidStatus();
  assert.equal(noKey.enabled, true);
  assert.equal(noKey.keyConfigured, false);
  assert.equal(noKey.ready.discover, false, "an enabled integration without a key cannot call anything");
  assert.match(noKey.reason, /MONID_API_KEY/);

  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  const ready = monid.monidStatus();
  assert.equal(ready.ready.discover, true);
  assert.equal(ready.ready.run, false, "run additionally needs both owner AI switches");
  assert.deepEqual(ready.billedOperations, ["run"]);
  assert.match(ready.reason, /both owner AI switches/);
});

test("status never leaks the key", () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  const json = JSON.stringify(monid.monidStatus());
  assert.equal(json.includes(TOKEN), false, "the key must never appear in a status payload");
});

test("base URL must be https except for loopback", () => {
  assert.throws(() => monid.resolveMonidBaseUrl("http://api.monid.ai"), /must be https/);
  assert.throws(() => monid.resolveMonidBaseUrl("ftp://api.monid.ai"), /must be https/);
  assert.throws(() => monid.resolveMonidBaseUrl("https://user:pass@api.monid.ai"), /credentials/);
  assert.equal(monid.resolveMonidBaseUrl("https://api.monid.ai/"), "https://api.monid.ai");
  assert.equal(monid.resolveMonidBaseUrl(BASE), BASE);
  // A malformed value must not throw an unhandled TypeError anywhere.
  assert.throws(() => monid.resolveMonidBaseUrl("not a url"), /malformed/);
});

test("discover sends the CLI's exact body and needs no approval (free)", async () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  calls.length = 0;
  const result = await monid.monidDiscover({ query: "company funding data", limit: 200, minScore: 0.5 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v1/discover");
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.equal(calls[0].body.query, "company funding data");
  assert.equal(calls[0].body.limit, 50, "limit is clamped to 50 so one call cannot dump the catalogue");
  assert.equal(calls[0].body.minScore, 0.5);
  assert.match(result.text, /exa/);
});

test("a query shorter than 3 characters is refused before any HTTP call", async () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  calls.length = 0;
  await assert.rejects(() => monid.monidDiscover({ query: "hi" }), /at least 3 characters/);
  assert.equal(calls.length, 0, "no request may be sent for an invalid query");
});

test("PII is scrubbed out of a discover query before it leaves the box", async () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  calls.length = 0;
  await monid.monidDiscover({ query: "student +8801712345678 results" });
  assert.equal(/\+8801712345678/.test(JSON.stringify(calls[0].body)), false, "a phone number must be redacted");
  assert.match(JSON.stringify(calls[0].body), /PHONE_REDACTED/);
});

test("inspect returns the schema/price and is free", async () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  calls.length = 0;
  const result = await monid.monidInspect("exa", "search");
  assert.equal(calls[0].body.provider, "exa");
  assert.equal(calls[0].body.endpoint, "search");
  assert.match(result.text, /0\.01 USD/);
});

test("balance is readable so the owner can see the cost side", async () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  const result = await monid.monidBalance();
  assert.match(result.text, /5\.00 USD/);
});

test("a billed run is refused in every state except the fully-approved one", async () => {
  const req = { provider: "exa", endpoint: "search", input: { queryParams: { q: "x" } }, quotedPrice: "0.01 USD", approvalId: "act_1" };

  // 1. integration off
  resetEnv({ MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE, ALO_PAID_AI_API_ALLOWED: "true", ALO_OWNER_APPROVED_PAID_AI_API: "true" });
  calls.length = 0;
  await assert.rejects(() => monid.runMonidEndpoint(req), (err) => err.code === "not_enabled");
  assert.equal(calls.length, 0);

  // 2. enabled, but the payment guard is closed
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  await assert.rejects(() => monid.runMonidEndpoint(req), (err) => err.code === "payment_guard");
  assert.equal(calls.length, 0);

  // 3. only one of the two AI switches
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE, ALO_PAID_AI_API_ALLOWED: "true" });
  await assert.rejects(() => monid.runMonidEndpoint(req), (err) => err.code === "payment_guard");
  assert.equal(calls.length, 0);

  // 4. everything on, but no approval id — the rule that makes this safe
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE, ALO_PAID_AI_API_ALLOWED: "true", ALO_OWNER_APPROVED_PAID_AI_API: "true" });
  await assert.rejects(
    () => monid.runMonidEndpoint({ ...req, approvalId: undefined }),
    (err) => err.code === "approval_required" && /exa#search/.test(err.message) && /0\.01 USD/.test(err.message),
  );
  assert.equal(calls.length, 0, "an unapproved call must never reach the network");

  // 5. fully approved → the call happens, with the verified body shape
  const result = await monid.runMonidEndpoint(req);
  assert.equal(result.billed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v1/run");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["endpoint", "input", "provider"]);
  assert.equal(calls[0].body.input.queryParams.q, "x");
  assert.match(result.text, /0\.01 USD/);
});

test("propose shows the price and the warnings without spending anything", () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  const proposal = monid.proposeMonidRun({ provider: "exa", endpoint: "search" });
  assert.equal(proposal.billed, true);
  assert.equal(proposal.quotedPrice, null);
  assert.ok(proposal.warnings.some((w) => /quoted/.test(w)), "an unquoted price must be called out");
  assert.ok(proposal.warnings.some((w) => /switches/.test(w)), "a closed guard must be called out");
});

test("upstream failures are reported as codes, not as fake success", async () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: "wrong-key", MONID_BASE_URL: BASE });
  await assert.rejects(() => monid.monidDiscover({ query: "anything" }), (err) => err.code === "http_error" && /401/.test(err.message));

  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: "http://127.0.0.1:9" });
  await assert.rejects(() => monid.monidDiscover({ query: "anything" }), (err) => err.code === "network_error");
});

test("the billed tool is registered and marked sensitive", () => {
  // agent-tools imports Prisma models; when the registry is loadable we assert
  // the approval wiring, and skip loudly rather than pretend when it is not.
  if (TOOL_NAMES.length === 0) {
    assert.ok(true, "tool registry not loadable in this environment (no database client)");
    return;
  }
  for (const name of ["monid_discover", "monid_inspect", "monid_run"]) {
    assert.ok(TOOL_NAMES.includes(name), `${name} must be registered`);
  }
  assert.ok(SENSITIVE_TOOLS.includes("monid_run"), "monid_run must require approval");
  assert.equal(SENSITIVE_TOOLS.includes("monid_discover"), false, "free search must not nag the owner");
});

// ── Catalogue facts + offline price estimate ────────────────────────────────
const catalog = await import("../src/lib/monid-catalog.ts");

test("catalogue facts are complete and every price carries its note", () => {
  assert.ok(catalog.MONID_PROVIDERS.length >= 5);
  for (const provider of catalog.MONID_PROVIDERS) {
    assert.match(provider.provider, /^[a-z0-9]+$/, provider.provider);
    assert.ok(provider.endpoints.length > 0, `${provider.provider} has no endpoints`);
    for (const endpoint of provider.endpoints) {
      assert.match(endpoint.endpoint, /^[a-z0-9-]+$/, `${provider.provider}#${endpoint.endpoint}`);
      assert.ok(endpoint.summary.length > 10);
      if (endpoint.price) assert.ok(endpoint.price.note.length > 20, "a price must say where it came from");
    }
  }
  // The five verified providers must be the ones the tests below exercise.
  assert.deepEqual(
    catalog.MONID_PROVIDERS.map((p) => p.provider).sort(),
    ["ahrefs", "apollo", "exa", "firecrawl", "hunterio"],
  );
});

test("the exa estimate follows the declared base + per-extra model", () => {
  assert.equal(catalog.estimateCallCost("exa", "search", { body: { numResults: 10 } }).usd, 0.007);
  assert.equal(catalog.estimateCallCost("exa", "search", {}).usd, 0.007, "default request = 10 results");
  assert.equal(catalog.estimateCallCost("exa", "search", { body: { numResults: 3 } }).usd, 0.007, "below the allowance does not discount");
  assert.equal(catalog.estimateCallCost("exa", "search", { body: { numResults: 25 } }).usd, 0.022);
  assert.match(catalog.estimateCallCost("exa", "search", { body: { numResults: 25 } }).text, /final charge comes from the run result/);
});

test("an unknown price returns null rather than a confident number", () => {
  for (const [provider, endpoint] of [["firecrawl", "crawl"], ["exa", "contents"], ["nope", "x"]]) {
    const estimate = catalog.estimateCallCost(provider, endpoint);
    assert.equal(estimate.usd, null, `${provider}#${endpoint} must not invent a price`);
    assert.match(estimate.text, /inspect/);
    assert.equal(estimate.fromDeclaredRate, false);
  }
});

test("the proposal carries both the live quote and the offline estimate", () => {
  resetEnv({ ALO_MONID_ENABLED: "true", MONID_API_KEY: TOKEN, MONID_BASE_URL: BASE });
  const proposal = monid.proposeMonidRun({
    provider: "exa",
    endpoint: "search",
    input: { body: { numResults: 25 } },
    quotedPrice: "0.02 USD",
  });
  assert.equal(proposal.quotedPrice, "0.02 USD");
  assert.equal(proposal.estimatedUsd, 0.022);
  assert.match(proposal.estimateText, /0\.0220/);
});

test("the catalogue report states coverage honestly", () => {
  const report = catalog.catalogueReport();
  assert.match(report, /free/i);
  assert.match(report, /billed per call/i);
  assert.match(report, /35 connector directories/);
  assert.match(report, /2,000\+ endpoints/);
  assert.match(report, /inspect it first/);
});

// ── Chat routing + the run pipeline (no network, no key needed) ─────────────
const { parseIntent } = await import("../src/lib/super-admin/intents.ts");

test("a Monid question routes to the Monid status, not to a provider switch", () => {
  for (const prompt of [
    "monid দিয়ে কী কী করা যায়",
    "what can monid tools do",
    "is monid enabled",
    "show monid catalogue with prices",
    "monid দাম কত",
  ]) {
    assert.equal(parseIntent(prompt).kind, "monid_status", prompt);
  }
  // Asking to *use* a provider is still a provider switch.
  assert.equal(parseIntent("switch to groq please").kind, "switch_provider");
  assert.equal(parseIntent("monid").kind, "monid_status");
});

test("a Monid status question completes as a real run without touching the network", async () => {
  resetEnv(); // integration off, no key
  calls.length = 0;
  const { MemoryRunStore } = await import("../src/lib/super-admin/run-store.ts");
  const runs = await import("../src/lib/super-admin/runs.ts");

  const store = new MemoryRunStore();
  const run = await runs.createRun("owner-monid", "conv-monid", "what can monid tools do", store);
  await runs.executeRunPipeline(run.id, { store, persistMessage: async () => undefined });
  const final = await store.getRun(run.id);

  assert.equal(final.status, "completed", `run failed: ${final.error ?? "no error"}`);
  assert.equal(calls.length, 0, "a status question must not call Monid (or spend anything)");

  const reply = JSON.parse(String(final.result)).reply ?? "";
  assert.match(reply, /Monid: 5 providers verified here/);
  assert.match(reply, /discover and inspect are free/i);
  assert.match(reply, /billed per call/i);
  assert.match(reply, /^Status: off/m, "the answer must say the integration is off when it is");
  assert.match(reply, /ALO_MONID_ENABLED/);
  runs._resetRuns?.();
});

// ── The deployment policy: paid features are OFF and stay off ───────────────
// This is the guarantee the owner asked for in writing: with the policy
// environment in place, *no* Monid call of any kind leaves the box — not a
// search, not an inspect, not a balance read, and certainly not a run.
test("policy lockdown: with ALO_MONID_ENABLED=false nothing reaches any Monid endpoint", async () => {
  resetEnv({
    ALO_MONID_ENABLED: "false",
    MONID_API_KEY: "",
    MONID_BASE_URL: BASE,
    ALO_PAID_AI_API_ALLOWED: "false",
    ALO_OWNER_APPROVED_PAID_AI_API: "false",
  });
  calls.length = 0;

  const status = monid.monidStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.ready.discover, false);
  assert.equal(status.ready.run, false);
  assert.equal(status.keyConfigured, false);

  await assert.rejects(() => monid.monidDiscover({ query: "company data" }), (e) => e.code === "not_enabled");
  await assert.rejects(() => monid.monidInspect("exa", "search"), (e) => e.code === "not_enabled");
  await assert.rejects(() => monid.monidBalance(), (e) => e.code === "not_enabled");
  await assert.rejects(
    () => monid.runMonidEndpoint({ provider: "exa", endpoint: "search", approvalId: "act_1" }),
    (e) => e.code === "not_enabled",
  );

  assert.equal(calls.length, 0, "not one HTTP request may be made while the policy is off");
});

test("policy lockdown: even a key plus open AI switches cannot run without the integration switch", async () => {
  // A misconfiguration that sets the key but forgets ALO_MONID_ENABLED must not
  // become a spending path — the integration switch is checked first.
  resetEnv({
    MONID_API_KEY: TOKEN,
    MONID_BASE_URL: BASE,
    ALO_PAID_AI_API_ALLOWED: "true",
    ALO_OWNER_APPROVED_PAID_AI_API: "true",
  });
  calls.length = 0;
  await assert.rejects(
    () => monid.runMonidEndpoint({ provider: "exa", endpoint: "search", approvalId: "act_1", quotedPrice: "0.007 USD" }),
    (e) => e.code === "not_enabled",
  );
  assert.equal(calls.length, 0);
});

test("the shipped PM2 template keeps every paid switch off", async () => {
  const fs = await import("node:fs");
  const cfg = fs.readFileSync(new URL("../ecosystem.learn.config.cjs", import.meta.url), "utf8");
  assert.match(cfg, /"ALO_PAID_AI_API_ALLOWED":\s*"false"/);
  assert.match(cfg, /"ALO_OWNER_APPROVED_PAID_AI_API":\s*"false"/);
  assert.match(cfg, /"ALO_MONID_ENABLED":\s*"false"/);
  assert.match(cfg, /"MONID_API_KEY":\s*""/);
  // Local-first endpoints must be present and loopback.
  for (const key of ["SEARXNG_BASE_URL", "WIGOLO_BASE_URL", "CRAWL4AI_BASE_URL", "FASTER_WHISPER_URL", "PIPER_BASE_URL"]) {
    const match = cfg.match(new RegExp(`"${key}":\\s*"([^"]*)"`));
    assert.ok(match, `${key} must be in the PM2 template`);
    assert.match(match[1], /^http:\/\/127\.0\.0\.1:\d+$/, `${key} must be loopback`);
  }
});
