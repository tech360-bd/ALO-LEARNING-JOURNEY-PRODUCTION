/**
 * The rules the live acceptance check applies, kept separate from the fetch loop
 * so they can be tested without a server (and reused by the super-admin browse
 * verifier, which asks the same question about a different target).
 *
 * No imports, no I/O: pure functions of the response.
 */

/** `degraded` is a PASS. A script that demanded `healthy` would fail a correct
 * deploy whose only missing piece is an optional feature (SMTP, ASR, AI key). */
export const SERVING_STATUSES = Object.freeze(["healthy", "degraded"]);

export const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Judges a `/api/health` response.
 *
 * @param {{status?: number, body?: Record<string, unknown>|null}} response
 * @returns {{ok: boolean, detail: string, reason: string|null}}
 */
export function judgeHealth(response) {
  const httpStatus = Number(response?.status ?? 0);
  const body = response?.body ?? {};
  const status = String(body.status ?? "");
  const sha = String(body.releaseSha ?? "");
  const detail = `HTTP ${httpStatus} status=${status || "?"} releaseSha=${sha.slice(0, 12) || "?"}`;
  if (httpStatus !== 200) return { ok: false, detail, reason: "not_200" };
  if (!SERVING_STATUSES.includes(status)) return { ok: false, detail, reason: "status_not_serving" };
  return { ok: true, detail, reason: null };
}

/**
 * A release identity is evidence only if it is a full 40-hex commit. `unknown`,
 * a short SHA or a placeholder is not.
 */
export function judgeReleaseSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  const ok = RELEASE_SHA_PATTERN.test(sha);
  return { ok, sha, detail: sha || "(empty)", reason: ok ? null : "release_sha_not_a_commit" };
}

/**
 * Whether a session can be replayed with `curl -b jar` against this origin.
 *
 * `src/lib/auth.ts` mints `__Secure-…` session cookies with `secure: true` in
 * production; curl will not send a Secure cookie over plain http. Writing a jar
 * that cannot authenticate anything is worse than refusing to write it.
 */
export function judgeJarReplayable({ origin, cookieNames = [] }) {
  let protocol = "";
  try {
    protocol = new URL(origin).protocol;
  } catch {
    return { ok: false, reason: "invalid_origin", detail: origin };
  }
  const secureNames = cookieNames.filter((n) => /^__(Secure|Host)-/i.test(n));
  if (secureNames.length > 0 && protocol !== "https:") {
    return {
      ok: false,
      reason: "https_only_cookie_on_http",
      detail: `${secureNames.join(", ")} can only be sent over https`,
      secureNames,
    };
  }
  return { ok: true, reason: null, detail: `${protocol} origin`, secureNames };
}
