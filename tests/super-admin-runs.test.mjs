import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Phase C2 — persistent streaming run engine.
//
// A real (local) Ollama-compatible NDJSON server is started on 127.0.0.1 so
// the streaming path is exercised for real: incremental tokens are parsed off
// a genuine HTTP stream, delivered live, and persisted as a durable timeline.
// No provider is mocked at the AI layer — only the wire protocol of the local
// model server, which is exactly what production Ollama speaks.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Local mock Ollama (NDJSON /api/chat + /api/tags) ────────────────────────
const CHUNKS = [
  '{"reply":"',
  'Streaming ',
  'works ',
  'end ',
  'to ',
  'end."}',
];
const mock = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/api/tags")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/api/chat")) {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    (async () => {
      for (const c of CHUNKS) {
        res.write(JSON.stringify({ model: "qwen2.5:7b", message: { role: "assistant", content: c }, done: false }) + "\n");
        await sleep(120); // spread the run over ~700ms so cancellation is testable
      }
      res.write(JSON.stringify({ model: "qwen2.5:7b", message: { role: "assistant", content: "" }, done: true }) + "\n");
      res.end();
    })();
    return;
  }
  res.writeHead(404);
  res.end("{}");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = mock.address().port;
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OLLAMA_MODEL = "qwen2.5:7b";

after(() => {
  mock.close();
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
});

// Import the engine after env is set (its modules read env at call time anyway).
const { MemoryRunStore } = await import("../src/lib/super-admin/run-store.ts");
const runs = await import("../src/lib/super-admin/runs.ts");

function makePersister() {
  const messages = [];
  return { messages, persistMessage: async (m) => messages.push(m) };
}

function parsePlan(plan) {
  if (Array.isArray(plan)) return plan;
  if (typeof plan === "string") return JSON.parse(plan);
  return [];
}
// Store rows keep payload as a JSON string (the SSE route parses it for the
// client). Tests parse it too, mirroring the wire format.
function pl(ev) {
  if (ev.payload == null) return {};
  if (typeof ev.payload === "string") {
    try {
      return JSON.parse(ev.payload);
    } catch {
      return { raw: ev.payload };
    }
  }
  return ev.payload;
}

test("run: health_check completes with a monotonic, gapless event timeline", async () => {
  const store = new MemoryRunStore();
  const { persistMessage } = makePersister();
  const run = await runs.createRun("owner-1", "conv-1", "system health", store);
  await runs.executeRunPipeline(run.id, { store, persistMessage });

  const final = await store.getRun(run.id);
  assert.equal(final.status, "completed");
  assert.ok(parsePlan(final.plan).length >= 3, "plan recorded");

  const events = await store.listEvents(run.id);
  assert.ok(events.length >= 8, `expected >=8 events, got ${events.length}`);
  assert.equal(events[0].type, "status");
  assert.equal(events[0].seq, 1);
  assert.equal(events[events.length - 1].type, "done");
  // Monotonic, gapless seq (the core C2 guarantee).
  for (let i = 1; i < events.length; i++) {
    assert.equal(events[i].seq, events[i - 1].seq + 1, `gap at seq ${events[i].seq}`);
  }
  // Every step that starts also completes; plan steps carry measured ms.
  const stepEvents = events.filter((e) => e.type === "step");
  assert.ok(stepEvents.length >= 3);
  const statusesByLabel = new Map();
  for (const s of stepEvents) {
    const p = pl(s);
    if (!statusesByLabel.has(p.step)) statusesByLabel.set(p.step, new Set());
    statusesByLabel.get(p.step).add(p.status);
  }
  for (const [label, statuses] of statusesByLabel) {
    assert.ok(statuses.has("completed"), `${label} never completed`);
  }
  for (const s of stepEvents) {
    const p = pl(s);
    if (p.status === "completed" && p.step.startsWith("check:")) {
      assert.equal(typeof p.ms, "number", `ms missing on ${p.step}`);
    }
  }
  assert.equal(pl(events[events.length - 1]).status, "completed");
  assert.ok(final.result && String(final.result).length > 0);
});

test("run: chat streams real tokens from the local model server and persists the turn", async () => {
  const store = new MemoryRunStore();
  const { persistMessage, messages } = makePersister();
  const run = await runs.createRun("owner-1", "conv-2", "Write a welcome message for new students", store);
  await runs.executeRunPipeline(run.id, { store, persistMessage });

  const final = await store.getRun(run.id);
  assert.equal(final.status, "completed", `run ended ${final.status}: ${final.error ?? ""}`);
  assert.equal(final.provider, "local-ollama", "provider recorded from the local stream");
  assert.equal(final.model, "qwen2.5:7b", "model recorded");

  const events = await store.listEvents(run.id);
  const tokens = events.filter((e) => e.type === "token");
  assert.ok(tokens.length >= 3, `expected streamed tokens, got ${tokens.length}`);
  const streamed = tokens.map((t) => pl(t).text ?? "").join("");
  assert.ok(streamed.length > 0, "token text persisted");
  // Token seqs are strictly increasing (durable ordering).
  for (let i = 1; i < tokens.length; i++) {
    assert.ok(tokens[i].seq > tokens[i - 1].seq, "token seq must increase");
  }
  const done = events.find((e) => e.type === "done");
  assert.equal(pl(done).status, "completed");

  // Durable assistant message (the record of the turn) with run linkage.
  const assistant = messages.find((m) => m.role === "assistant");
  assert.ok(assistant, "assistant message persisted");
  assert.equal(assistant.runId, run.id);
  assert.equal(assistant.provider, "local-ollama");
  assert.match(assistant.content, /Streaming works end to end/);
  // No partialContent left dangling after completion.
  assert.equal(final.partialContent, null);
});

test("run: cancellation aborts the live provider stream and finalizes as cancelled", async () => {
  const store = new MemoryRunStore();
  const { persistMessage } = makePersister();
  const run = await runs.createRun("owner-1", "conv-3", "chat that will be cancelled", store);

  // The mock stream runs ~700ms, so the run is live long enough to cancel.
  const pipeline = runs.executeRunPipeline(run.id, { store, persistMessage });
  let live = false;
  for (let i = 0; i < 200; i++) {
    if (runs.isRunActive(run.id)) {
      live = true;
      break;
    }
    await sleep(5);
  }
  assert.ok(live, "run should be live before cancel");
  runs.requestCancellation(run.id);
  await pipeline;

  const final = await store.getRun(run.id);
  assert.equal(final.status, "cancelled", `expected cancelled, got ${final.status}`);
  const done = (await store.listEvents(run.id)).find((e) => e.type === "done");
  assert.equal(JSON.parse(done.payload).status, "cancelled");
  assert.equal(runs.isRunActive(run.id), false, "abort registry cleaned up");
});

test("run: stale recovery marks a crashed process's run interrupted", async () => {
  const store = new MemoryRunStore();
  const run = await runs.createRun("owner-1", "conv-4", "crashed run", store);
  // Simulate a run left "running" by a previous process incarnation.
  const old = new Date(Date.now() - 15 * 60 * 1000);
  await store.appendEvent(run.id, "status", { status: "running" }, { status: "running", updatedAt: old });

  const recovered = await runs.recoverStaleRuns(store);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0], run.id);
  const final = await store.getRun(run.id);
  assert.equal(final.status, "interrupted");
  const done = (await store.listEvents(run.id)).filter((e) => e.type === "done").pop();
  assert.equal(JSON.parse(done.payload).status, "interrupted");
  assert.equal(JSON.parse(done.payload).recovered, true);
});

test("run: approval continuation finalizes a paused run on decision", async () => {
  const store = new MemoryRunStore();
  const run = await runs.createRun("owner-1", "conv-5", "announce something", store);
  // The pipeline pauses here waiting for the owner.
  await store.appendEvent(run.id, "approval", { actionId: "act-9", kind: "announce", title: "Announcement" });
  await store.appendEvent(run.id, "status", { status: "awaiting_approval", actionId: "act-9" }, {
    status: "awaiting_approval",
    pendingActionId: "act-9",
  });
  const mid = await store.getRun(run.id);
  assert.equal(mid.status, "awaiting_approval");
  assert.equal(mid.pendingActionId, "act-9");

  const resumed = await runs.finalizeRunsForAction("act-9", "approved", store);
  assert.equal(resumed, 1);
  const final = await store.getRun(run.id);
  assert.equal(final.status, "completed");
  const done = (await store.listEvents(run.id)).find((e) => e.type === "done");
  assert.equal(JSON.parse(done.payload).status, "completed");
  assert.equal(JSON.parse(done.payload).decision, "approved");

  // Rejected decisions finalize the run as failed with a durable done event.
  const run2 = await runs.createRun("owner-1", "conv-6", "announce again", store);
  await store.appendEvent(run2.id, "status", { status: "awaiting_approval", actionId: "act-10" }, {
    status: "awaiting_approval",
    pendingActionId: "act-10",
  });
  const resumed2 = await runs.finalizeRunsForAction("act-10", "rejected", store);
  assert.equal(resumed2, 1);
  const final2 = await store.getRun(run2.id);
  assert.equal(final2.status, "failed");
  assert.equal(final2.error, "rejected by owner");
  const done2 = (await store.listEvents(run2.id)).find((e) => e.type === "done");
  assert.equal(JSON.parse(done2.payload).decision, "rejected");
});

test("run: ownerId scoping isolates runs per owner", async () => {
  const store = new MemoryRunStore();
  const a = await runs.createRun("owner-A", "conv-a", "cmd A", store);
  const b = await runs.createRun("owner-B", "conv-b", "cmd B", store);
  const listA = await store.listRuns("owner-A");
  const listB = await store.listRuns("owner-B");
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);
  assert.equal(listA[0].id, a.id);
  assert.equal(listB[0].id, b.id);
  assert.ok(!listA.some((r) => r.id === b.id), "owner A must not see owner B's runs");
});
