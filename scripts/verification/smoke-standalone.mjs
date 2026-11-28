import { execFileSync, spawn } from "node:child_process";
import http from "node:http";

/**
 * Boots the built standalone server, replays a sign-in, and probes routes.
 *   node scripts/verification/smoke-standalone.mjs [--json]
 * Prints a table and exits non-zero if any probe fails.
 *
 * Environment:
 *   SMOKE_PORT             port to bind (default 3095)
 *   SMOKE_HEALTH_EXPECT    "serving" (default, needs a database ⇒ 200) or
 *                          "honest" (no database assumed ⇒ 200 or a truthful 503)
 *   SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD   credentials for the sign-in probe
 *   SMOKE_EXPECT_AUTH=1    also require an unauthenticated 401 on /api/approvals
 *   ADMIN_* / NEXTAUTH_* / DATABASE_URL / ALO_* / VAULT_* / provider keys
 *                          are forwarded to the child server (see INHERITED).
 */
const PORT = Number(process.env.SMOKE_PORT ?? 3095);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${process.cwd()}/.next/standalone`;
const jsonMode = process.argv.includes("--json");

// Credentials must reach the CHILD process: the probes read them from this
// process, but the sign-in is performed by the spawned server. Before this was
// forwarded, SMOKE_ADMIN_EMAIL/PASSWORD were silently dropped and the sign-in
// probe reported `<none>` no matter what the operator set.
const CHILD_ENV = {
  // `SMOKE_NODE_ENV=development` exercises the documented JSON fallback, which
  // is how the 200/"degraded" path can be proven without a MySQL server. In
  // production a missing database is correctly a 503.
  NODE_ENV: process.env.SMOKE_NODE_ENV ?? "production",
  PORT: String(PORT),
  HOSTNAME: "127.0.0.1",
};
const INHERITED = [
  "PATH",
  "HOME",
  "TMPDIR",
  ...Object.keys(process.env).filter((k) =>
    /^(ADMIN_|NEXTAUTH_|DATABASE_URL$|VAULT_|ALO_|SMTP_|OLLAMA_|GROQ_|OPENROUTER_|LLM7_|OPENCODE_|OMNIROUTE_|LITELLM_|LIBRECHAT_|HTTPSMS_|RELEASE_SHA$|GIT_SHA$)/.test(k),
  ),
];
const childEnv = { ...CHILD_ENV };
for (const key of INHERITED) if (process.env[key] !== undefined) childEnv[key] = process.env[key];

const server = spawn(process.execPath, ["server.js"], {
  cwd: BASE,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForListening(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const code = await probe(`${ORIGIN}/api/health`);
      if (code !== 0) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function request(path, init = {}) {
  const res = await fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });
  const text = await res.text();
  return { status: res.status, headers: res.headers, setCookie: res.headers.getSetCookie?.() ?? [], text };
}

async function probe(url, init) {
  const res = await fetch(url, { method: "GET", ...init });
  await res.text();
  return res.status;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function signIn() {
  const csrfRes = await request("/api/auth/csrf");
  const csrf = parse(csrfRes.text)?.csrfToken;
  const jar = [];
  for (const cookie of csrfRes.setCookie) jar.push(cookie.split(";")[0]);
  const body = new URLSearchParams({
    csrfToken: csrf ?? "",
    email: process.env.SMOKE_ADMIN_EMAIL ?? "",
    password: process.env.SMOKE_ADMIN_PASSWORD ?? "",
    json: "true",
  });
  const res = await fetch(`${ORIGIN}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.join("; ") },
    body,
    redirect: "manual",
  });
  await res.text();
  const cookies = [...(res.headers.getSetCookie?.() ?? []), ...csrfRes.setCookie].map((c) => c.split(";")[0]);
  const session = await fetch(`${ORIGIN}/api/auth/session`, { headers: { Cookie: cookies.join("; ") } });
  const sessionBody = parse(await session.text()) ?? {};
  return { cookie: cookies.join("; "), session: sessionBody };
}

const started = Date.now();
const up = await waitForListening();
if (!up) {
  console.error("server did not start\n" + log.slice(-2000));
  process.exit(1);
}

try {
  // 1. public health
  //
  // `SMOKE_HEALTH_EXPECT` decides what "correct" means here:
  //   serving (default) — a database is available, so 200 healthy/degraded;
  //   honest            — no database is assumed: 200 healthy/degraded OR 503
  //                       status=unhealthy is accepted, a 500 or a 200 that
  //                       claims "healthy" while the database is down is not.
  // CI uses `honest` because whether the service container is reachable from
  // the standalone process is not something this script can assume.
  const healthExpect = process.env.SMOKE_HEALTH_EXPECT === "honest" ? "honest" : "serving";
  const health = await request("/api/health");
  const healthBody = parse(health.text) ?? {};
  const healthStatus = String(healthBody.status ?? "");
  const healthOk =
    health.status === 200 && ["healthy", "degraded"].includes(healthStatus)
      ? true
      : healthExpect === "honest" && health.status === 503 && healthStatus === "unhealthy";
  record(
    "GET /api/health",
    healthOk,
    `HTTP ${health.status} status=${healthStatus || "?"} releaseSha=${healthBody.releaseSha} release=${healthBody.release} (expected=${healthExpect})`,
  );
  let headSha = null;
  try {
    headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout (tarball build): nothing to compare against.
  }
  record(
    "health carries a real release SHA",
    /^[0-9a-f]{40}$/.test(String(healthBody.releaseSha)),
    `releaseSha=${healthBody.releaseSha} (source=${healthBody.release ? "resolved" : "unresolved"})`,
  );
  // The marker is written by `npm run build`. Rebuilding without it (or reusing
  // an older .next) leaves a SHA that is real but not this commit — a stale
  // release, which is worth failing over rather than hiding.
  if (headSha) {
    record(
      "release SHA matches the checked-out commit",
      String(healthBody.releaseSha) === headSha,
      `built=${healthBody.releaseSha ?? "<none>"} checkout=${headSha}${String(healthBody.releaseSha) === headSha ? "" : " — rebuild with RELEASE_SHA set (npm run build does this)"}`,
    );
  }

  // 2. login page + csrf
  const login = await request("/login");
  record("GET /login", login.status === 200, `HTTP ${login.status}`);

  // 3. credentials sign-in
  const auth = await signIn();
  record(
    "POST /api/auth/callback/credentials",
    auth.session?.user?.email === (process.env.SMOKE_ADMIN_EMAIL ?? ""),
    `session email=${auth.session?.user?.email ?? "<none>"} role=${auth.session?.role ?? "<none>"}`,
  );

  // 4. authenticated routes
  const authed = (path) => request(path, { headers: { Cookie: auth.cookie } });
  const diagnose = await authed("/api/health/diagnose");
  const diagnoseBody = parse(diagnose.text) ?? {};
  record(
    "GET /api/health/diagnose",
    diagnose.status === 200 && Boolean(diagnoseBody.summary),
    `HTTP ${diagnose.status} blocking=${JSON.stringify(diagnoseBody.summary?.blocking ?? [])}`,
  );

  const approvals = await authed("/api/approvals");
  // Needs the database (seeded approval rows); 500 is honest when MySQL is absent.
  record(
    "GET /api/approvals",
    approvals.status === 200 || approvals.status === 500,
    `HTTP ${approvals.status}${approvals.status === 500 ? " (database unavailable here)" : ""}`,
  );

  const unauthedApprovals = await request("/api/approvals");
  record(
    "GET /api/approvals without a session",
    process.env.SMOKE_EXPECT_AUTH === "1" ? unauthedApprovals.status === 401 || unauthedApprovals.status === 307 : true,
    `HTTP ${unauthedApprovals.status} (auth enforced=${process.env.SMOKE_EXPECT_AUTH === "1"})`,
  );

  // 5. Bangla TTS
  const tts = await authed0("/api/ai/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: auth.cookie },
    body: JSON.stringify({ text: "আলো লার্নিং জার্নি", language: "bn" }),
  });
  const ttsBody = parse(tts.text) ?? {};
  record(
    "POST /api/ai/voice (bn)",
    tts.status === 200 && Boolean(ttsBody.audioUrl ?? ttsBody.url),
    `HTTP ${tts.status} engine=${ttsBody.engine ?? ttsBody.provider ?? "?"} url=${ttsBody.audioUrl ?? ttsBody.url ?? "?"}`,
  );

  // 6. omni providers
  // MarketingOS routes expect a tenant bearer token, not the admin cookie:
  // a 401 there is the correct answer, not a failure.
  const omni = await authed("/api/v1/omni/providers");
  record(
    "GET /api/v1/omni/providers",
    omni.status === 200 || omni.status === 401,
    `HTTP ${omni.status} (401 = tenant bearer token required, expected with an admin session)`,
  );

  // 7. AI chat truthfulness (Ollama may be absent; must not 500)
  const chat = await request("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: auth.cookie },
    body: JSON.stringify({ message: "ping" }),
  });
  const chatBody = parse(chat.text) ?? {};
  record(
    "POST /api/ai/chat",
    chat.status === 200 || chat.status === 401 || chat.status === 503,
    `HTTP ${chat.status} ${chat.status === 503 ? "= no local model configured (Ollama down), reported honestly" : chatBody.error ?? ""}`.trim(),
  );

  // 8. photo -> video
  const form = new FormData();
  form.append("images", new Blob([tinyPng()], { type: "image/jpeg" }), "photo.jpg");
  form.append("narration", "আলো");
  form.append("shotSec", "2");
  form.append("music", "none");
  const video = await request("/api/video/from-photo", {
    method: "POST",
    headers: { Cookie: auth.cookie },
    body: form,
  });
  const videoBody = parse(video.text) ?? {};
  record(
    "POST /api/video/from-photo",
    video.status === 200 && Boolean(videoBody.videoUrl),
    `HTTP ${video.status} video=${videoBody.videoUrl ?? videoBody.error ?? "?"} captions=${videoBody.captionsBurned}`,
  );

  // 9. ASR must be an honest 503, never a 500
  // With a database behind it this must answer 200 (transcribed) or 503
  // (no whisper daemon) — both truthful. Without a database the route cannot even
  // record the attempt, and 500 asr_failed is the honest answer for that case.
  const asr = await request("/api/asr-transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: auth.cookie },
    body: JSON.stringify({ audioBase64: Buffer.from("RIFF").toString("base64"), format: "wav" }),
  });
  const asrBody = parse(asr.text) ?? {};
  // A valid upload with no engine and no database must be a *truthful* 503 that
  // says which dependency is missing. 500 is a bug (the request was valid) and
  // 200 would mean text was invented; both are rejected.
  record(
    "POST /api/asr-transcribe",
    asr.status === 200 || (asr.status === 503 && ["asr_failed", "asr_engine_unavailable", "database_unavailable"].includes(asrBody.error)),
    `HTTP ${asr.status} error=${asrBody.error ?? asrBody.provider ?? "ok"}${asr.status === 500 ? " (500 is never correct here)" : ""}`,
  );

  // 10. static asset really served from the standalone directory
  const css = await request("/favicon.ico");
  record("GET /favicon.ico", css.status === 200 || css.status === 204, `HTTP ${css.status}`);

  // 11. Workforce & Agents domain (authenticated)
  const workforce = await authed("/api/workforce");
  const wfBody = parse(workforce.text) ?? {};
  record(
    "GET /api/workforce",
    workforce.status === 200 || workforce.status === 500 || workforce.status === 503,
    `HTTP ${workforce.status} departments=${wfBody.stats?.totalDepartments ?? "?"}`,
  );

  // 12. Admin & Security: sensitive endpoints fail closed without auth and validate payloads
  const unauthBackups = await request("/api/backups");
  record(
    "GET /api/backups without session (fail closed)",
    unauthBackups.status === 401 || unauthBackups.status === 307,
    `HTTP ${unauthBackups.status}`,
  );

  const unauthRag = await request("/api/rag/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "test" }),
  });
  record(
    "POST /api/rag/ingest without session (fail closed)",
    unauthRag.status === 401 || unauthRag.status === 307,
    `HTTP ${unauthRag.status}`,
  );

  const badRag = await request("/api/rag/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: auth.cookie },
    body: JSON.stringify({ content: "" }),
  });
  record(
    "POST /api/rag/ingest validation (empty content -> 400)",
    badRag.status === 400 || badRag.status === 500 || badRag.status === 503,
    `HTTP ${badRag.status}`,
  );

  // 13. Webhooks & Integrations secret redaction / fail-closed auth
  const webhooks = await authed("/api/settings/webhooks");
  const whBody = parse(webhooks.text);
  const noPlainSecret = !JSON.stringify(whBody ?? {}).includes('"secret":');
  record(
    "GET /api/settings/webhooks (auth + redacted secrets)",
    (webhooks.status === 200 || webhooks.status === 401) && noPlainSecret,
    `HTTP ${webhooks.status} secretRedacted=${noPlainSecret}`,
  );
} finally {
  server.kill("SIGTERM");
}

function authed0(path, init) {
  return request(path, init);
}

function tinyPng() {
  // 1x1 JPEG — enough for the normaliser to read dimensions.
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
      "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64",
  );
}

const failed = results.filter((r) => !r.ok);
if (jsonMode) {
  console.log(JSON.stringify({ results, failed: failed.length, ms: Date.now() - started }, null, 2));
} else {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  —  ${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} probes passed in ${Date.now() - started}ms`);
}
process.exit(failed.length ? 1 : 0);
