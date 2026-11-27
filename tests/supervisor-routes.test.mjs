import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The supervisor UI and the supervisor API must be the same set.
//
// Live symptom: `contact-center-view.tsx` called
// `/api/v1/supervisor/${kind}/${callId}` for kind ∈ {listen, whisper, barge-in},
// but only `listen` and `barge-in` routes existed — so the "Whisper" button was a
// guaranteed 404 in the operator's contact center.

const ROOT = path.resolve(import.meta.dirname, "..");
const SUPERVISOR_DIR = path.join(ROOT, "src/app/api/v1/supervisor");
const VIEW = path.join(ROOT, "src/components/views/contact-center-view.tsx");

function actionRoutes() {
  return fs
    .readdirSync(SUPERVISOR_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

test("every supervisor action the UI offers has a route on disk", () => {
  const view = fs.readFileSync(VIEW, "utf8");
  const kinds = /kind:\s*([^)]+)\)/.exec(view)?.[1] ?? "";
  const offered = [...kinds.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(offered.length >= 3, `could not read the offered actions: ${kinds}`);

  const routes = actionRoutes();
  for (const kind of offered) {
    assert.ok(
      routes.includes(kind),
      `the UI offers "${kind}" but src/app/api/v1/supervisor/${kind}/ does not exist (routes: ${routes.join(", ")})`,
    );
  }
});

test("whisper is agent-only and records who whispered what", () => {
  const src = fs.readFileSync(path.join(SUPERVISOR_DIR, "whisper/[callId]/route.ts"), "utf8");
  assert.match(src, /actionType: 'whisper'/);
  // The defining behaviour: the caller must not hear it.
  assert.match(src, /mode: 'agent_only'/);
  assert.match(src, /the caller hears nothing|private channel to the agent only/);
  // Audit must capture the coaching line when supplied.
  assert.match(src, /body\.message/);
  assert.match(src, /supervisor\.whisper/);
});

test("whisper enforces the same authorization and tenancy as its siblings", () => {
  const src = fs.readFileSync(path.join(SUPERVISOR_DIR, "whisper/[callId]/route.ts"), "utf8");
  const listen = fs.readFileSync(path.join(SUPERVISOR_DIR, "listen/[callId]/route.ts"), "utf8");
  for (const guard of [
    "getSessionContext(request)",
    "unauthorized()",
    "forbidden('manager role required (supervisor access)')",
    "companyId: ctx.companyId",
    "notFound('call not found')",
  ]) {
    assert.ok(src.includes(guard), `whisper must keep the shared guard: ${guard}`);
    assert.ok(listen.includes(guard), `(sibling changed: ${guard})`);
  }
});

test("whisper never claims a real audio path for a simulated call", () => {
  const src = fs.readFileSync(path.join(SUPERVISOR_DIR, "whisper/[callId]/route.ts"), "utf8");
  assert.match(src, /const simulated = !call\.providerCallId \|\| call\.providerCallId\.startsWith\('sim_'\)/);
  assert.match(src, /Simulation mode/);
});
