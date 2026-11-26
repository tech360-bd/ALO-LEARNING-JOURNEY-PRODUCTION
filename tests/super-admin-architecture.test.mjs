import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const router = read("../src/lib/omni/router.ts");
const catalog = read("../src/lib/omni/catalog.ts");
const browser = read("../src/lib/self-heal/browser.ts");
const detector = read("../src/lib/self-heal/detector.ts");
const fixer = read("../src/lib/self-heal/fixer.ts");
const learner = read("../src/lib/self-heal/learner.ts");
const chat = read("../src/lib/super-admin/chat.ts");
const intents = read("../src/lib/super-admin/intents.ts");
const runs = read("../src/lib/super-admin/runs.ts");
const runsRoute = read("../src/app/api/super-admin/runs/route.ts");

// ── Omni-router protocol ────────────────────────────────────────────────────
test("router enforces the single-active rule with an in-flight lock", () => {
  assert.match(router, /externalInFlight/);
  assert.match(router, /omni_router_busy: another provider call is in flight/);
});

test("router is local-first (privacy): Ollama before any external call", () => {
  const localIdx = router.indexOf("generateLocalChatJson");
  const chainIdx = router.indexOf("chainChat(");
  assert.ok(localIdx > -1 && chainIdx > -1);
  assert.ok(localIdx < chainIdx, "local Ollama must be tried before the external chain");
});

test("router reuses the registry-driven chain (no duplicated provider HTTP)", () => {
  assert.match(router, /from "@\/lib\/ai-chain"/);
  // Must not hand-roll provider HTTP calls of its own.
  assert.ok(!router.includes("api.groq.com"), "router must not hardcode provider endpoints");
});

test("router honors the free-tier payment guard", () => {
  assert.match(router, /external_ai_blocked_by_payment_guard/);
});

test("router records circuit-breaker health and cooldowns", () => {
  assert.match(router, /consecutiveFailures/);
  assert.match(router, /cooldown/i);
  assert.match(router, /omniProviderHealth/);
  assert.match(router, /omniRouterState/);
});

test("router treats rule-based fallback as 'no real model answered'", () => {
  assert.match(router, /chain\.fallback/);
  assert.match(router, /omni_router_no_provider_answered/);
});

test("catalog-only providers can never be called automatically", () => {
  assert.match(catalog, /callable: false/);
});

// ── Self-healing browser safety ─────────────────────────────────────────────
test("browser uses the SSRF guard on every request", () => {
  assert.match(browser, /isUrlSafe/);
  assert.match(browser, /SSRF/);
});

test("browser is read-only: GET/HEAD only, no form submission", () => {
  assert.match(browser, /method: "GET"/);
  assert.match(browser, /method: "HEAD"/);
  assert.ok(!/method:\s*"(POST|PUT|DELETE|PATCH)"/i.test(browser), "browser must never write");
});

test("browser is bounded (size, timeout, redirects, links)", () => {
  assert.match(browser, /MAX_BYTES/);
  assert.match(browser, /AbortSignal\.timeout/);
  assert.match(browser, /MAX_REDIRECTS/);
  assert.match(browser, /MAX_LINKS/);
});

// ── Detector: proactive, read-only ──────────────────────────────────────────
test("detector checks four layers: providers, db, web, logs", () => {
  for (const layer of ["providers", "database", "browser", "logs"]) {
    assert.match(detector, new RegExp(layer), `missing layer ${layer}`);
  }
});

test("detector persists findings with dedupe", () => {
  assert.match(detector, /selfHealFinding/);
  assert.match(detector, /status: "open"/);
});

// ── Fixer: allowlisted, risk-tiered, never destructive ──────────────────────
test("fixer rejects destructive fixes", () => {
  assert.match(fixer, /Blocked: destructive fixes are never applied/);
});

test("fixer refuses approval-risk fixes without owner approval", () => {
  assert.match(fixer, /Requires owner approval/);
});

test("fixer never writes files or runs arbitrary code", () => {
  assert.ok(!/child_process|execSync|spawn\(|fs\.writeFile|rm -rf/i.test(fixer), "fixer must stay declarative");
});

test("fix registry includes the core safe fixes", () => {
  for (const id of ["rotate_provider", "clear_cooldowns", "enable_external_ai", "check_db_config", "investigate_page", "rescan_site"]) {
    assert.match(fixer, new RegExp(`id: "${id}"`), `missing fix ${id}`);
  }
});

// ── Learner: self-learning loop ─────────────────────────────────────────────
test("learner records outcomes and suggests by success rate", () => {
  assert.match(learner, /recordOutcome/);
  assert.match(learner, /suggestFix/);
  assert.match(learner, /topPatterns/);
  assert.match(learner, /successRate/);
});

test("learner persists to SelfHealLearning and falls back to memory", () => {
  assert.match(learner, /selfHealLearning/);
  assert.match(learner, /selfHealLearning\.create/);
});

// ── Executor: deterministic intent execution + audit ────────────────────────
test("run creation is audited by the runs route", () => {
  assert.match(runsRoute, /auditLog\.create/);
  assert.match(runsRoute, /actor: "SuperAdmin"/);
});

test("approval-risk intents create pending approval actions instead of executing directly", () => {
  assert.match(runs, /superAdminAction\.create/);
  assert.match(runs, /risk: "approval"/);
  assert.match(runs, /status: "pending"/);
});

test("run engine runs only allowlisted operations (no dynamic code)", () => {
  assert.ok(!/eval\(|new Function\(|import\(\s*req|vm\.run/i.test(runs), "run engine must not run dynamic code");
});

// ── Chat orchestration ──────────────────────────────────────────────────────
test("every chat turn is a persistent run (single execution path)", () => {
  // chat.ts must delegate to the run engine — one owner message = one run —
  // so the streaming UI and the synchronous API share the same execution
  // path, timeline, and records.
  assert.match(chat, /createRun/);
  assert.match(chat, /executeRunPipeline/);
  // Turns are persisted with the run linkage.
  assert.match(chat, /superAdminMessage/);
  assert.match(chat, /runId/);
});

test("system intents execute via the run engine's deterministic allowlisted plans", () => {
  // The run pipeline maps each intent to a fixed set of plan steps — the
  // model never chooses what is executed.
  assert.match(runs, /planFor/);
});

test("chat reports honestly when no provider answers", () => {
  // The honest no-provider message lives in the run engine (shared by the
  // streaming UI and the synchronous chat facade).
  assert.match(runs, /No AI provider answered/);
});

// ── Intent parser: deterministic (no AI in the routing decision) ────────────
test("intent parser is pure and bilingual", () => {
  assert.match(intents, /toLowerCase/);
  assert.match(intents, /স্বাস্থ্য|ভুল|ঠিক কর/); // Bengali keywords present
});
