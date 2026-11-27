import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_SOURCES,
  AGENT_GUIDANCE,
  findSource,
  knowledgeSummary,
} from "../src/lib/knowledge/sources.ts";
import { knowledgePromptBlock, sourceReport, sourceLines } from "../src/lib/knowledge/agent.ts";
import { parseIntent } from "../src/lib/super-admin/intents.ts";

test("every source carries a licence fact and an enforceable policy", () => {
  assert.ok(KNOWLEDGE_SOURCES.length >= 15, `expected the full list, got ${KNOWLEDGE_SOURCES.length}`);
  for (const source of KNOWLEDGE_SOURCES) {
    assert.ok(source.id && /^[a-z0-9-]+$/.test(source.id), `bad id: ${source.id}`);
    assert.ok(source.name.length > 1);
    assert.match(source.url, /^https:\/\//, `${source.id}: url must be https`);
    assert.ok(source.mayUse.length > 20, `${source.id}: mayUse must be an actual permission`);
    assert.ok(source.mustNot.length > 20, `${source.id}: mustNot must be an actual prohibition`);
    assert.ok(source.agentUse.length > 20, `${source.id}: agentUse must be actionable`);
    // A licence claim must be one of the GitHub API values, or explicitly null.
    if (source.facts.spdx !== null) {
      assert.match(source.facts.spdx, /^(MIT|Apache-2\.0|BSD-3-Clause|AGPL-3\.0|GPL-3\.0|NOASSERTION)$/);
    }
    // Anything with custom terms must explain itself.
    if (source.facts.spdx === "NOASSERTION") {
      assert.ok(source.licenceNote, `${source.id}: NOASSERTION requires a licenceNote`);
    }
  }
});

test("no source may be both integrated and rejected", () => {
  const summary = knowledgeSummary();
  const overlap = summary.integrated.filter((id) => summary.rejected.includes(id));
  assert.deepEqual(overlap, []);
  assert.equal(
    Object.values(summary.byAdoption).reduce((a, b) => a + b, 0),
    KNOWLEDGE_SOURCES.length,
    "every source has exactly one adoption state",
  );
});

test("the three sources the earlier licence audit flagged keep their real reason", () => {
  // These are the traps that were verified from the licence files themselves:
  // a vague "it is open source" answer here would be wrong and costly.
  const openWebui = findSource("open-webui");
  assert.equal(openWebui?.adoption, "rejected");
  assert.match(String(openWebui?.mustNot), /branding/i);

  const litellm = findSource("litellm");
  assert.equal(litellm?.adoption, "integrated");
  assert.match(String(litellm?.mustNot), /enterprise/i);

  const directus = findSource("directus");
  assert.equal(directus?.adoption, "rejected");
  assert.match(String(directus?.mustNot), /Prisma/i);
});

test("lookup by id, name and URL fragment resolves to one source", () => {
  assert.equal(findSource("litellm")?.id, "litellm");
  assert.equal(findSource("LibreChat")?.id, "librechat");
  assert.equal(findSource("https://github.com/open-webui/open-webui")?.id, "open-webui");
  assert.equal(findSource("free-for-dev")?.id, "free-for-dev");
  assert.equal(findSource("no-such-source"), undefined);
});

test("the prompt block states only what is true and respects its budget", () => {
  const block = knowledgePromptBlock(1200);
  assert.ok(block.length <= 1200, `prompt block overflowed: ${block.length}`);
  assert.match(block, /Never claim an integration/);
  // The chat prompt and the API's `?prompt=1` view must be the same block.
  const dflt = knowledgePromptBlock();
  assert.ok(dflt.length <= 2500, `default block exceeded the chat budget: ${dflt.length}`);
  assert.match(dflt, /Totals:/);
  assert.ok(dflt.startsWith(block.split("\n").slice(0, 2).join("\n")), "same header at any budget");
  // It must never describe a rejected source as usable.
  const rejected = knowledgeSummary().rejected;
  for (const id of rejected) {
    const line = sourceLines().find((entry) => entry.includes(`(${id},`));
    if (line) assert.match(line, /adoption: rejected/, `${id} described as ${line}`);
  }
});

test("the report names the licence and the prohibition for every source", () => {
  const report = sourceReport();
  for (const source of KNOWLEDGE_SOURCES) {
    assert.ok(report.includes(source.name), `${source.name} missing from the report`);
  }
  assert.match(report, /Rejected, with the reason/i);
  assert.match(report, /2026-11-27/, "the report must state when the facts were checked");
  // Every row is a table row with the licence column filled.
  assert.equal(
    report.split("\n").filter((line) => /^\| .* \| (integrated|integrated-tools|service|pattern|reference-only|rejected) \| /.test(line)).length,
    KNOWLEDGE_SOURCES.length,
  );
});

test("'add these repos as knowledge' routes to the index, not to a single link", () => {
  const prompts = [
    "add all repo agent with all slike knowwlagew those are need",
    "which repositories are added as knowledge?",
    "list sources",
    "কোন রেপো যোগ করা আছে",
  ];
  for (const prompt of prompts) {
    assert.equal(parseIntent(prompt).kind, "list_sources", prompt);
  }
  // A single shared link must still be reviewed instead of listed.
  assert.equal(parseIntent("https://github.com/open-webui/open-webui is it safe").kind, "review_link");
  // Ordinary chat is untouched.
  assert.equal(parseIntent("sorry, my login fails").kind, "chat");
});

test("a narrowed answer counts only what it shows", () => {
  const single = sourceReport("open-webui");
  assert.match(single, /^Knowledge index: 1 source /m);
  assert.match(single, /15 in the index/, "the total must still be stated");
  assert.equal(single.split("\n").filter((line) => /^\| Open WebUI \|/.test(line)).length, 1);
  assert.doesNotMatch(single, /\| LiteLLM \|/, "other sources must not appear in a narrowed answer");
  assert.doesNotMatch(single, /^Integrated: /m, "a rejected source must not inherit the integrated banner");
});

test("Monid is wired as a gated tool surface, not as a chat model", () => {
  const monid = findSource("monid");
  assert.equal(monid?.adoption, "integrated-tools");
  assert.match(String(monid?.mustNot), /never call run without an owner approval/i);
  const summary = knowledgeSummary();
  assert.deepEqual(summary.gated, ["monid"]);
  // It must not be offered as "usable today" — it is off until the owner opts in.
  assert.equal(summary.usableToday.includes("monid"), false);
  const single = sourceReport("monid");
  assert.match(single, /owner-gated tool surface/);
  assert.match(single, /off until the owner enables it/);
  assert.doesNotMatch(single, /^Integrated: litellm/m, "a gated source must not inherit the LLM banner");
});

test("agent guidance covers the three questions the owner actually asks", () => {
  const keywords = AGENT_GUIDANCE.flatMap((entry) => entry.keywords);
  for (const needed of ["knowledge", "free", "licence"]) assert.ok(keywords.includes(needed), needed);
  for (const entry of AGENT_GUIDANCE) assert.ok(entry.guidance.length > 30);
});

// ── End to end through the real run engine ────────────────────────────────
// The intent test above proves routing; this proves the owner actually gets a
// truthful answer, with a durable timeline, from the same code path the chat
// uses. Provider env is cleared so no external model can influence the result.
test("a knowledge question completes as a real run and answers truthfully", async () => {
  const saved = { ...process.env };
  for (const key of ["OLLAMA_BASE_URL", "GROQ_API_KEY", "OPENROUTER_API_KEY", "LITELLM_BASE_URL", "LIBRECHAT_BASE_URL"]) {
    delete process.env[key];
  }
  const { MemoryRunStore } = await import("../src/lib/super-admin/run-store.ts");
  const runs = await import("../src/lib/super-admin/runs.ts");
  try {
    const store = new MemoryRunStore();
    const run = await runs.createRun("owner-knowledge", "conv-knowledge", "which repositories are added as knowledge?", store);
    await runs.executeRunPipeline(run.id, { store, persistMessage: async () => undefined });

    const final = await store.getRun(run.id);
    assert.equal(final.status, "completed", `run failed: ${final.error ?? "no error"}`);

    const events = await store.listEvents(run.id);
    assert.equal(events[0].type, "status");
    assert.equal(events[events.length - 1].type, "done");
    for (let i = 1; i < events.length; i++) {
      assert.equal(events[i].seq, events[i - 1].seq + 1, "gapless seq");
    }

    const raw = String(final.result ?? "");
    const reply = JSON.parse(raw).reply ?? "";
    assert.match(reply, /Knowledge index: 15 sources/);
    assert.match(reply, /Rejected, with the reason/);
    assert.match(reply, /Open WebUI/, "the branded-licence trap must be named");
    assert.match(reply, /2026-11-27/, "the answer must state when the licences were checked");
    // Truthfulness: nothing may be presented as live that is not.
    assert.doesNotMatch(reply, /Temporal (cluster|server) (is|runs)/);
    assert.doesNotMatch(reply, /monid.*(enabled|active|connected)/i);

    // A named source narrows the answer to that source only, through the same
    // pipeline (intent entities → plan → composer).
    const narrowed = await runs.createRun("owner-knowledge", "conv-knowledge", "what about open-webui in the knowledge list", store);
    await runs.executeRunPipeline(narrowed.id, { store, persistMessage: async () => undefined });
    const narrowedRun = await store.getRun(narrowed.id);
    assert.equal(narrowedRun.status, "completed");
    const narrowedReply = JSON.parse(String(narrowedRun.result)).reply ?? "";
    assert.match(narrowedReply, /^Knowledge index: 1 source /m);
    assert.doesNotMatch(narrowedReply, /\| LiteLLM \|/, "a narrowed answer must not list the others");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    runs._resetRuns?.();
  }
});
