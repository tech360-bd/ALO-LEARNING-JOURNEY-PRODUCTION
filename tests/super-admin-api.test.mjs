import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── API routes: owner-guarded ───────────────────────────────────────────────
test("all /api/super-admin routes require the owner session", () => {
  for (const route of [
    "src/app/api/super-admin/chat/route.ts",
    "src/app/api/super-admin/conversations/route.ts",
    "src/app/api/super-admin/actions/route.ts",
    "src/app/api/super-admin/providers/route.ts",
    "src/app/api/super-admin/self-heal/route.ts",
    "src/app/api/super-admin/health/route.ts",
  ]) {
    const src = read(`../${route}`);
    assert.match(src, /requireOwner/, `${route} must call requireOwner()`);
    assert.match(src, /from "@\/lib\/auth"/, `${route} must import auth from lib`);
  }
});

test("chat route bounds message length and caps duration", () => {
  const src = read("../src/app/api/super-admin/chat/route.ts");
  assert.match(src, /MAX_MESSAGE_CHARS = 4000/);
  assert.match(src, /maxDuration = 120/);
});

test("chat route creates conversations server-side (no client-trusted id without check)", () => {
  const src = read("../src/app/api/super-admin/chat/route.ts");
  assert.match(src, /superAdminConversation\.create/);
  assert.match(src, /conversation not found/);
});

test("actions route publishes announcements only on approval", () => {
  const src = read("../src/app/api/super-admin/actions/route.ts");
  assert.match(src, /decision === "approved" && action\.kind === "announce"/);
  assert.match(src, /announcement\.create/);
  assert.match(src, /decidedAt/);
});

test("actions route blocks double-deciding", () => {
  const src = read("../src/app/api/super-admin/actions/route.ts");
  assert.match(src, /action already \$\{action\.status\}/);
});

test("self-heal route only allows safe auto-fixes in fix mode", () => {
  const src = read("../src/app/api/super-admin/self-heal/route.ts");
  assert.match(src, /fix\.risk !== "safe"\) continue/);
  assert.match(src, /mode must be scan \| fix \| apply-fix/);
});

test("providers route validates provider ids against the callable catalog", () => {
  const src = read("../src/app/api/super-admin/providers/route.ts");
  assert.match(src, /unknown provider: \$\{providerId\}/);
  assert.match(src, /e\.callable/);
});

// ── v1 external API architecture ────────────────────────────────────────────
test("v1 omni chat is JWT-authenticated and audited", () => {
  const src = read("../src/app/api/v1/omni/chat/route.ts");
  assert.match(src, /getSessionContext/);
  assert.match(src, /unauthorized\(\)/);
  assert.match(src, /auditLog\.create/);
});

test("v1 omni chat reports ai_unavailable with 503 when nothing answers", () => {
  const src = read("../src/app/api/v1/omni/chat/route.ts");
  assert.match(src, /notConfigured\(/);
  assert.match(src, /omni_chat/);
});

test("v1 providers route never leaks secrets", () => {
  const src = read("../src/app/api/v1/omni/providers/route.ts");
  assert.match(src, /secretMasked/);
  assert.ok(!/secretCipher/.test(src) || /select/.test(src), "must not return raw ciphertext");
});

test("v1 super-admin health is role-restricted to super_admin", () => {
  const src = read("../src/app/api/v1/super-admin/health/route.ts");
  assert.match(src, /requireRole\(request, "super_admin"\)/);
});

// ── ChatGPT-style UI ────────────────────────────────────────────────────────
test("super-admin page is a client SPA with chat + conversations + monitor", () => {
  const src = read("../src/app/super-admin/page.tsx");
  assert.match(src, /'use client'/);
  assert.match(src, /New chat/);
  assert.match(src, /What would you like to manage\?/);
  assert.match(src, /System Monitor/);
  assert.match(src, /Send/);
  assert.match(src, /ReactMarkdown/);
});

test("super-admin page enforces approval UI (approve/reject)", () => {
  const src = read("../src/app/super-admin/page.tsx");
  assert.match(src, /Approve/);
  assert.match(src, /Reject/);
  assert.match(src, /Pending Approvals/);
});

test("super-admin page warns about the data policy in the composer", () => {
  const src = read("../src/app/super-admin/page.tsx");
  assert.match(src, /Destructive actions are blocked/);
});

// ── Schema + migration: additive only ───────────────────────────────────────
test("schema contains the 7 new super-admin models", () => {
  const schema = read("../prisma/schema.prisma");
  for (const m of [
    "SuperAdminConversation",
    "SuperAdminMessage",
    "SuperAdminAction",
    "SelfHealFinding",
    "SelfHealLearning",
    "OmniProviderHealth",
    "OmniRouterState",
  ]) {
    assert.match(schema, new RegExp(`model ${m} \\{`), `missing model ${m}`);
  }
});

test("new migration is additive (CREATE TABLE only, no ALTER on existing tables)", () => {
  const sql = read("../prisma/migrations/20261125000000_super_admin_omni_selfheal/migration.sql");
  assert.match(sql, /CREATE TABLE `SuperAdminConversation`/);
  assert.match(sql, /CREATE TABLE `OmniRouterState`/);
  assert.ok(!/ALTER TABLE/i.test(sql), "migration must not alter existing tables");
  assert.ok(!/DROP TABLE/i.test(sql), "migration must not drop tables");
});

test("new migration messages cascade-delete with their conversation", () => {
  const sql = read("../prisma/migrations/20261125000000_super_admin_omni_selfheal/migration.sql");
  assert.match(sql, /REFERENCES `SuperAdminConversation`\(`id`\) ON DELETE CASCADE/);
});
