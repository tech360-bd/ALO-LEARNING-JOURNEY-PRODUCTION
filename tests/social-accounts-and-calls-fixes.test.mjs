import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("social-accounts route uses AES-256-GCM vault encryption and redacts tokens on GET/POST", () => {
  const src = read("src/app/api/social-accounts/route.ts");
  assert.match(src, /import\s+\{\s*encryptSecret\s*\}\s+from\s+["']@\/lib\/vault["']/);
  assert.doesNotMatch(src, /\bbtoa\(/, "must not use reversible base64 btoa() for access tokens");
  assert.match(src, /tokenConfigured:\s*Boolean\(account\.accessToken\)/);
  assert.doesNotMatch(src, /accessToken:\s*account\.accessToken/, "must never serialize raw accessToken to clients");
  assert.match(src, /db\.socialAccount\.findFirst\(\{\s*where:\s*\{\s*id,\s*companyId:\s*payload\.companyId\s*\}/s);
});

test("social-accounts view validates/connects via API without fake 2500ms setTimeout simulation", () => {
  const src = read("src/components/views/social-accounts-view.tsx");
  assert.doesNotMatch(src, /simulateConnectionTest/);
  assert.doesNotMatch(src, /setTimeout\(\s*\(r\)\s*=>\s*setTimeout|setTimeout\(r,\s*2500\)/);
  assert.match(src, /connectMutation\.mutateAsync/);
});

test("billing view wires PlanDialog to POST /api/v1/billing/subscribe instead of placeholder toast", () => {
  const src = read("src/components/views/billing-view.tsx");
  assert.doesNotMatch(src, /Plan change wizard coming soon/);
  assert.match(src, /\/api\/v1\/billing\/subscribe/);
  assert.match(src, /function PlanDialog\(/);
});

test("contact-center view removes hardcoded call/Customer-360 mocks and wires real call controls", () => {
  const view = read("src/components/views/contact-center-view.tsx");
  assert.doesNotMatch(view, /name:\s*['"]Incoming caller['"]/);
  assert.doesNotMatch(view, /Support #1234/);
  assert.doesNotMatch(view, /\$1,240/);
  assert.match(view, /\/api\/v1\/calls\/\$\{currentCall\.id\}\/hold/);
  assert.match(view, /\/api\/v1\/calls\/\$\{currentCall\.id\}\/resume/);
  assert.match(view, /\/api\/v1\/calls\/\$\{currentCall\.id\}\/transfer/);
  assert.match(view, /\/api\/v1\/calls\/\$\{currentCall\.id\}\/hangup/);
  assert.match(view, /\/api\/v1\/calls\/\$\{callId\}\/answer/);
  assert.match(view, /api\.patch\(`\/api\/v1\/calls\/\$\{currentCall\.id\}`/);

  const route = read("src/app/api/v1/calls/[id]/route.ts");
  assert.match(route, /export async function PATCH\(/);
  assert.match(route, /companyId:\s*ctx\.companyId/);
  assert.match(route, /summary:\s*notes/);
});

test("voice-agents view synthesizes real greeting audio via POST /api/v1/tts", () => {
  const src = read("src/components/views/voice-agents-view.tsx");
  assert.doesNotMatch(src, /Test call simulation started/);
  assert.match(src, /api\.post<[^>]+>\('\/api\/v1\/tts'/);
});
