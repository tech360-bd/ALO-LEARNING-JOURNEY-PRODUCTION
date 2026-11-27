#!/usr/bin/env node
/**
 * Post-deploy acceptance check — run this ON the server, after `pm2 restart`.
 *
 *   npm run verify:live                       # http://127.0.0.1:3061
 *   npm run verify:live -- --url=https://learn.alolabs.net
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run verify:live
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run verify:live -- --jar=/tmp/alo.jar
 *
 * `--jar=PATH` saves the signed-in session as a curl cookie jar (mode 0600), so
 * the authenticated endpoints in the runbook can be read with `curl -b PATH`
 * instead of pasting a token around. The jar grants full admin access: it is
 * written only when asked for, never printed, and should be deleted afterwards.
 *
 * Why this exists: every step of the health cutover could be checked except the
 * two that need the real box — a 200 from `/api/health` (needs MySQL) and an
 * admin sign-in that ends with a usable session cookie. Doing that by hand with
 * `curl` and a cookie jar is error-prone (the CSRF token must be POSTed with the
 * cookie it was issued for, and NextAuth's cookie name differs between http and
 * https), so it is scripted here instead, and it prints the exact next command
 * when something fails.
 *
 * Guarantees:
 *   - reads secrets only from the environment or an interactive prompt, never
 *     prints them, never sends them anywhere except the target's own login;
 *   - exits 0 only when the health gate is 200 AND (if credentials were given)
 *     the session is a real admin session;
 *   - no dependencies and no build step: plain node, runs from the repo root.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chmod, writeFile } from "node:fs/promises";
import { cookiePairs, isSecureSessionCookie, toNetscapeJar } from "./cookie-jar.mjs";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=") || "true"];
    })
);

const BASE = (args.get("url") ?? process.env.LIVE_URL ?? "http://127.0.0.1:3061").replace(/\/+$/, "");
const TIMEOUT_MS = Number(args.get("timeout") ?? 15_000);
const SKIP_AUTH = args.get("no-auth") === "true";
const JSON_MODE = args.get("json") === "true";

const results = [];
function record(name, ok, detail, fix) {
  results.push({ name, ok, detail, fix: ok ? undefined : fix });
}
function note(message) {
  if (!JSON_MODE) process.stdout.write(message + "\n");
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, body, text: text.slice(0, 400), setCookie };
}

async function ask(question, envValue) {
  if (envValue) return envValue;
  if (!stdin.isTTY) return "";
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Health gate: 200 + a real release SHA. `degraded` is a pass, by contract. */
async function checkHealth() {
  const res = await call("/api/health");
  const body = res.body ?? {};
  const status = String(body.status ?? "");
  const sha = String(body.releaseSha ?? "");
  const okStatus = res.status === 200 && ["healthy", "degraded"].includes(status);
  record(
    "GET /api/health",
    okStatus,
    `HTTP ${res.status} status=${status || "?"} releaseSha=${sha.slice(0, 12) || "?"}`,
    `Not 200/healthy. Run: curl -sS ${BASE}/api/health/diagnose | jq '.summary, .findings[]|select(.ok==false)'`
  );
  record(
    "releaseSha is a real 40-hex commit",
    /^[0-9a-f]{40}$/.test(sha),
    sha || "(empty)",
    "Set RELEASE_SHA in the PM2 environment, or rebuild so scripts/write-release-sha.mjs writes .next/standalone/RELEASE_SHA, then: pm2 restart <app> --update-env"
  );
  record(
    "/login renders",
    (await call("/login")).status === 200,
    "",
    "Check the Next.js process and the reverse proxy upstream for this port."
  );
  return { status, sha };
}

/** NextAuth credentials sign-in, exactly as the browser does it. */
async function checkAuth() {
  const csrfRes = await call("/api/auth/csrf");
  const csrf = csrfRes.body?.csrfToken;
  const jar = cookiePairs(csrfRes.setCookie);
  if (!csrf) {
    record("CSRF token issued", false, `HTTP ${csrfRes.status}`, "NEXTAUTH_SECRET may be missing; the login route cannot mint a CSRF token without it.");
    return;
  }
  record("CSRF token issued", true, cookiePairs(csrfRes.setCookie).length + " cookie(s)");

  const email = await ask("ADMIN_EMAIL (or press Enter to skip sign-in): ", process.env.ADMIN_EMAIL);
  const password = await ask("ADMIN_PASSWORD (not echoed to logs): ", process.env.ADMIN_PASSWORD);
  if (!email || !password) {
    note("\n!  Skipped admin sign-in: no credentials given.");
    note("   Re-run with: ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run verify:live");
    return;
  }

  const body = new URLSearchParams({ csrfToken: csrf, email, password, json: "true" });
  const login = await call("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.join("; ") },
    body,
  });
  jar.push(...cookiePairs(login.setCookie));

  // `__Secure-` cookies are only ever sent over TLS, so a session minted by a
  // plain-http probe cannot be replayed with a cookie jar. Say so instead of
  // writing a jar that looks fine and authenticates nothing.
  const secureSessionOnly = jar.some((pair) => isSecureSessionCookie(pair.split("=")[0]));
  if (secureSessionOnly && new URL(BASE).protocol !== "https:") {
    note(
      "\n!  This session is HTTPS-only (the app mints __Secure- cookies in production),\n" +
        "   so `curl -b <jar>` over this plain-http origin would be unsigned and rejected.\n" +
        "   Re-run against the https origin (e.g. --url=https://learn.alolabs.net) to save a usable jar."
    );
  }

  const session = await call("/api/auth/session", { headers: { Cookie: jar.join("; ") } });
  const user = session.body?.user ?? null;
  const role = session.body?.role ?? user?.role ?? null;
  const ok = Boolean(session.body?.userId || user?.email);
  record(
    "POST /api/auth/callback/credentials",
    ok,
    ok ? `session email=${user?.email ?? "?"} role=${role ?? "?"}` : `HTTP ${login.status}, no session`,
    "Sign-in failed. Check that ADMIN_EMAIL matches ADMIN_PASSWORD_HASH, that the hash kept its escaped \\$ separators in .env, and that ADMIN_OTP_REQUIRED=false hides the OTP step. Then: curl -sS ${BASE}/api/health/diagnose".replace("${BASE}", BASE)
  );
  if (ok) {
    const jarPath = args.get("jar");
    if (jarPath && jarPath !== "true" && secureSessionOnly && new URL(BASE).protocol !== "https:") {
      record(
        "session saved as a curl cookie jar",
        false,
        "not written: an HTTPS-only session cookie cannot be replayed over plain http",
        `Re-run with --url=https://<public-host> --jar=${jarPath} so the jar matches the scheme the browser uses.`
      );
    } else if (jarPath && jarPath !== "true") {
      try {
        await writeFile(jarPath, toNetscapeJar(BASE, jar), { mode: 0o600 });
        await chmod(jarPath, 0o600);
        record("session saved as a curl cookie jar", true, jarPath);
        note(`\n   curl -sS -b ${jarPath} ${BASE}/api/health/diagnose | jq .`);
        note(`   rm -f ${jarPath}   # delete when finished: it is a live admin session\n`);
      } catch (error) {
        record("session saved as a curl cookie jar", false, String(error?.message ?? error), "Pick a writable path, e.g. --jar=/tmp/alo.jar");
      }
    }
    // A session that cannot reach an owner-only route is not a usable session.
    const diagnose = await call("/api/health/diagnose", { headers: { Cookie: jar.join("; ") } });
    record(
      "owner-only route accepts the session",
      diagnose.status === 200,
      `GET /api/health/diagnose → HTTP ${diagnose.status}`,
      "The cookie exists but the owner gate rejects it: confirm the user's role is admin/owner and that NEXTAUTH_SECRET has not changed since the cookie was minted."
    );
  }
}

async function main() {
  note(`ALO live check → ${BASE}\n`);
  try {
    await checkHealth();
    if (!SKIP_AUTH) await checkAuth();
  } catch (error) {
    record("connection", false, String(error?.message ?? error), `Is the app listening on this URL? Try: pm2 status && pm2 logs --lines 50`);
  }

  const failed = results.filter((r) => !r.ok);
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ base: BASE, results, failed: failed.length }, null, 2) + "\n");
  } else {
    for (const r of results) {
      process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}\n`);
      if (!r.ok && r.fix) process.stdout.write(`      fix: ${r.fix}\n`);
    }
    process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
