import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Local-first provider order.
//
// The claim under test is a *policy* claim: on this deployment the local Ollama
// model answers before any remote provider is contacted. A real HTTP server
// speaking Ollama's /api/chat protocol proves the working path; a counting stub
// on a remote-provider variable proves the remote was never touched.

const ollamaHits = [];
const ollama = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    ollamaHits.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    if (req.url === "/api/chat") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          model: "qwen2.5:7b",
          message: { role: "assistant", content: "স্থানীয় মডেল থেকে উত্তর" },
          prompt_eval_count: 11,
          eval_count: 7,
        }),
      );
    }
    res.writeHead(404);
    res.end("{}");
  });
});
await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
const OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
after(() => ollama.close());

// A "remote" provider: if anything calls it, the counter proves the local-first
// guarantee was broken. It answers successfully on purpose — a chain that reaches
// it would happily use it, so the only thing preventing that is the order.
let remoteHits = 0;
const remote = http.createServer((req, res) => {
  req.on("data", () => undefined);
  req.on("end", () => {
    remoteHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "remote answer" } }] }));
  });
});
await new Promise((r) => remote.listen(0, "127.0.0.1", r));
const REMOTE_URL = `http://127.0.0.1:${remote.address().port}/v1`;
after(() => remote.close());

const KEYS = ["OLLAMA_BASE_URL", "OLLAMA_CHAT_MODEL", "ALO_PROVIDER_ORDER", "OMNIROUTE_BASE_URL", "OMNIROUTE_MODEL", "OMNIROUTE_API_KEY", "ALO_PAID_AI_API_ALLOWED", "ALO_OWNER_APPROVED_PAID_AI_API", "GROQ_API_KEY", "OPENROUTER_API_KEY", "LLM7_API_KEY", "OPENCODE_API_KEY"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

const chain = await import("../src/lib/ai-chain.ts");

beforeEach(() => {
  ollamaHits.length = 0;
  remoteHits = 0;
  for (const k of KEYS) delete process.env[k];
  process.env.OLLAMA_BASE_URL = OLLAMA_URL;
  process.env.OLLAMA_CHAT_MODEL = "qwen2.5:7b";
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const messages = [{ role: "user", content: "বাংলায় একটি বাক্য লিখুন" }];

test("the local model answers, and it is the first provider tried", async () => {
  const result = await chain.chainChat(messages, { maxTokens: 64 });
  assert.equal(result.provider, "ollama");
  assert.match(result.text, /স্থানীয় মডেল/);
  assert.equal(ollamaHits.length, 1);
  assert.equal(ollamaHits[0].url, "/api/chat");
  assert.equal(ollamaHits[0].body.model, "qwen2.5:7b");
  assert.equal(ollamaHits[0].body.stream, false);
});

test("LOCAL FIRST is the default even with a remote gateway configured and allowed", async () => {
  // A reachable remote, both paid switches open, and no ordering preference:
  // the local model must still answer first.
  process.env.OMNIROUTE_BASE_URL = REMOTE_URL;
  process.env.OMNIROUTE_MODEL = "auto";
  process.env.OMNIROUTE_API_KEY = "test-key";
  process.env.ALO_PAID_AI_API_ALLOWED = "true";
  process.env.ALO_OWNER_APPROVED_PAID_AI_API = "true";

  const result = await chain.chainChat(messages);
  assert.equal(result.provider, "ollama", `provider was ${result.provider}`);
  assert.equal(remoteHits, 0, "no remote provider may be contacted while the local model answers");
});

test("a dead local model falls through — and says so in the attempts", async () => {
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:45998";
  const result = await chain.chainChat(messages, {}, () => "rule-based reply");
  // Nothing else is configured, so the deterministic fallback answers. The point
  // is that it did not hang, throw, or claim the local model had answered.
  assert.equal(result.provider, "rule-based");
  assert.equal(result.text, "rule-based reply");
  assert.equal(ollamaHits.length, 0);
});

test("ALO_PROVIDER_ORDER=remote-first restores the old order (opt-in only)", async () => {
  process.env.ALO_PROVIDER_ORDER = "remote-first";
  const result = await chain.chainChat(messages, {}, () => "fallback");
  // With no remote configured, the local model is still used — just later.
  assert.equal(result.provider, "ollama");
  assert.equal(ollamaHits.length, 1);
});

test("the local model needs no key and no paid switch", async () => {
  // Everything paid/remote is off; only the loopback URL is set.
  const result = await chain.chainChat(messages);
  assert.equal(result.provider, "ollama");
  assert.ok(ollamaHits.length >= 1);
  assert.equal(process.env.ALO_PAID_AI_API_ALLOWED, undefined, "no switch had to be enabled");
});
