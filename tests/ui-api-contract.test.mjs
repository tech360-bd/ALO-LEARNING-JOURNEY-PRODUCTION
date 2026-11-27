import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * UI → API contract.
 *
 * Every `/api/...` URL a *mounted* view calls must resolve to a real route file
 * exporting the method that call will use. This is the check that was missing:
 * the audit found the contact-center "Whisper" button POSTing to
 * `/api/v1/supervisor/whisper/<id>`, a directory that did not exist — a
 * guaranteed 404 no type-check or lint could see, because the URL is a template
 * literal. TypeScript types the string, not the route table. The same pass found
 * the announcement editor POSTing an edit to a route that only exports PATCH
 * (a 405 where "Save" silently did nothing).
 *
 * Only views mounted by `src/app/dashboard/page.tsx` are audited. The root app
 * carries a large set of leftover CRM/education views that are never rendered
 * (students, assignments, departments…); demanding endpoints for screens no user
 * can open would be busywork.
 *
 * How a URL is attributed to a method — by the nearest *preceding* call opener:
 *   api.post<T>(url…)          → POST
 *   api.del<T>(url)            → DELETE
 *   fetch(url, {method})       → the method option in that same call, else GET
 *   xMutation.mutate(p, url)   → the method of that useApiMutation
 *   useApiQuery(url)           → GET
 *   path: url / API_BASE = url → a declaration, not a call: skipped (its uses
 *                                are audited individually)
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const DASHBOARD = path.join(ROOT, "src/app/dashboard/page.tsx");
const API_ROOT = path.join(ROOT, "src/app/api");
const URL_LITERAL = /[`'"](\/api\/[A-Za-z0-9\-_./${}[\]]*)/g;

function routeFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const ROUTES = routeFiles(API_ROOT).map((file) => ({
  url: "/api/" + path.relative(API_ROOT, path.dirname(file)).split(path.sep).join("/"),
  src: fs.readFileSync(file, "utf8"),
}));

const segments = (url) => url.replace(/\/+$/, "").split("/");

/** Route files whose shape the URL fits, with `[param]` standing for any one segment. */
function candidates(url) {
  const want = segments(url);
  return ROUTES.filter((route) => {
    const have = segments(route.url);
    if (have.length !== want.length) return false;
    return have.every((seg, i) => seg === want[i] || /^\[[^\]]+\]$/.test(seg));
  });
}

const exportsMethod = (src, method) =>
  new RegExp(`export (?:const|async function|function) ${method}\\b`).test(src);

const mountedViews = [...fs.readFileSync(DASHBOARD, "utf8").matchAll(/import\('@\/components\/views\/([a-z0-9-]+)'/g)].map(
  (m) => m[1],
);

/** `const fooMutation = useApiMutation({ method: "PATCH" … })` → fooMutation ⇒ PATCH. */
function mutationMethods(source) {
  const map = new Map();
  for (const m of source.matchAll(/const (\w+)\s*=\s*useApiMutation(?:<[\s\S]{0,300}?>)?\(\s*\{([\s\S]{0,600}?)\n\s{2}\}\);/g)) {
    map.set(m[1], /method:\s*["'](\w+)["']/.exec(m[2])?.[1] ?? "POST");
  }
  return map;
}

/** Declared literal unions, so `kind: 'listen' | 'whisper'` can be expanded. */
function literalUnions(source) {
  const unions = new Map();
  for (const m of source.matchAll(/\b(\w+)\s*:\s*((?:\s*'[a-z0-9-]+'\s*\|)+\s*'[a-z0-9-]+')/gi)) {
    const members = [...m[2].matchAll(/'([a-z0-9-]+)'/gi)].map((x) => x[1]);
    if (members.length > 1) unions.set(m[1], members);
  }
  return unions;
}

/** The nearest preceding call opener for a URL literal, or null for a declaration. */
function classify(head, mutations) {
  const probes = [
    { re: /\.(get|post|put|patch|delete|del)(?:<[^>]*>)?\(\s*$/i, kind: "direct" },
    { re: /(\w+)\.mutate(?:Async)?\(([\s\S]*)$/, kind: "mutate" },
    { re: /(?:apiFetch|fetch)\(\s*$/, kind: "fetch" },
    { re: /useApiQuery(?:<[^>]*>)?\(\s*$/, kind: "query" },
    { re: /useApiMutation(?:<[\s\S]{0,300}?>)?\(\s*\{[\s\S]*$/, kind: "declaration" },
    { re: /\bpath:\s*$/, kind: "declaration" },
    { re: /=\s*$/, kind: "declaration" },
  ];

  let best = null;
  for (const probe of probes) {
    const m = probe.re.exec(head);
    if (!m) continue;
    const at = head.length - m[0].length;
    if (!best || at > best.at) best = { at, kind: probe.kind, m };
  }
  if (!best) return null;

  if (best.kind === "declaration") return { method: null };
  if (best.kind === "direct") {
    const verb = best.m[1].toUpperCase();
    return { method: verb === "DEL" ? "DELETE" : verb };
  }
  if (best.kind === "query") return { method: "GET" };
  if (best.kind === "mutate") {
    const variable = best.m[1];
    // The URL is an argument (after a comma), never the mutation's own payload.
    if (!best.m[2].includes(",")) return null;
    return { method: (mutations.get(variable) ?? "POST").toUpperCase() };
  }
  return { method: "fetch" }; // resolved by the caller, which can see what follows
}

function callsIn(file) {
  const source = fs.readFileSync(file, "utf8");
  const mutations = mutationMethods(source);
  const unions = literalUnions(source);
  const calls = [];
  const literals = [...source.matchAll(URL_LITERAL)];

  literals.forEach((match, index) => {
    const raw = match[1].split("?")[0];
    if (raw.endsWith("/") || raw === "/api" || raw === "/api/") return;

    const head = source.slice(Math.max(0, match.index - 400), match.index);
    const verdict = classify(head, mutations);
    if (!verdict || !verdict.method) return; // declaration, or not a request

    let method = verdict.method;
    if (method === "fetch") {
      // `fetch(url, { method: "PATCH" })` — bound the look-ahead to this call so
      // a neighbouring call's method is never borrowed.
      const next = literals[index + 1]?.index ?? source.length;
      const window = source.slice(match.index, Math.min(match.index + 400, next));
      method = /method:\s*["']([A-Z]+)["']/.exec(window)?.[1] ?? "GET";
    }

    const line = source.slice(0, match.index).split("\n").length;
    const view = path.basename(file, ".tsx");
    const holes = [...raw.matchAll(/\$\{([^}]*)\}/g)].map((h) => h[1].trim());
    const urls = holes.some((h) => unions.has(h))
      ? expandUnions(raw, holes, unions)
      : [raw.replace(/\$\{[^}]*\}/g, "x")];

    for (const url of urls) calls.push({ view, line, method, url });
  });

  return calls;
}

/** Cartesian product of union members substituted into their `${hole}` positions. */
function expandUnions(raw, holes, unions) {
  let urls = [raw];
  for (const hole of holes) {
    const members = unions.get(hole);
    if (!members) continue;
    const token = `\${${hole}}`;
    urls = urls.flatMap((url) => members.map((member) => url.replace(token, member)));
  }
  return urls.map((url) => url.replace(/\$\{[^}]*\}/g, "x"));
}

const CALLS = mountedViews
  .map((view) => path.join(ROOT, `src/components/views/${view}.tsx`))
  .filter((file) => fs.existsSync(file))
  .flatMap(callsIn);

test("the dashboard still mounts the views we audited", () => {
  assert.ok(mountedViews.length >= 20, `expected >=20 mounted views, found ${mountedViews.length}`);
  // 84 real call sites at the time of writing (declarations excluded). The floor
  // is a tripwire for the scanner going silent, not a specification.
  assert.ok(CALLS.length >= 70, `expected >=70 API call sites, found ${CALLS.length}`);

  const covered = new Set(CALLS.map((call) => call.view));
  assert.ok(covered.size >= 18, `only ${covered.size} views produced calls: ${[...covered].join(", ")}`);
});

test("every API URL called by a mounted view resolves to a real route", () => {
  const broken = CALLS.filter((call) => candidates(call.url).length === 0);
  assert.deepEqual(
    broken.map((b) => `${b.view}:${b.line} ${b.method} ${b.url}`),
    [],
    "these calls would 404 — the route file does not exist",
  );
});

test("every call's HTTP method is exported by the route it targets", () => {
  const broken = CALLS.filter((call) => {
    const found = candidates(call.url);
    return found.length > 0 && !found.some((route) => exportsMethod(route.src, call.method));
  });
  assert.deepEqual(
    broken.map((b) => `${b.view}:${b.line} ${b.method} ${b.url}`),
    [],
    "the route exists but does not export this method — the call would 405",
  );
});

test("literal union holes are expanded, not silently skipped", () => {
  // The whisper bug lived behind `${kind}`; if expansion stopped working this
  // audit would go quiet while the button stayed broken.
  const supervisor = CALLS.filter((c) => c.view === "contact-center-view" && c.url.startsWith("/api/v1/supervisor/"));
  for (const kind of ["listen", "whisper", "barge-in"]) {
    assert.ok(
      supervisor.some((c) => c.url === `/api/v1/supervisor/${kind}/x`),
      `expected a call to supervisor/${kind} after union expansion`,
    );
  }
});

test("mutation verbs are attributed per mutation, not borrowed from a neighbour", () => {
  const edits = CALLS.filter((c) => c.view === "announcements-view" && c.url === "/api/announcements/x");
  assert.ok(
    edits.some((c) => c.method === "PATCH"),
    "the edit path must be sent as PATCH (the route exports PATCH, not POST)",
  );
});

test("the audit can actually fail (guards against a silently-empty scan)", () => {
  assert.ok(ROUTES.length >= 300, `expected >=300 route files, found ${ROUTES.length}`);
  assert.equal(candidates("/api/__definitely-not-a-route__").length, 0);
  assert.equal(exportsMethod("export async function GET() {}", "POST"), false);
});
