/**
 * Cookie handling for the post-deploy checks (no dependencies).
 *
 * The operator workflow is: sign in once with `verify:live`, then reuse that
 * session to read the authenticated endpoints (`/api/health/diagnose`,
 * `/api/health?details=1`) with plain `curl -b <jar>`. That only works if the
 * jar is written in the format curl reads, which is Netscape's and is fussy
 * about the tab layout and the two flags — so it is generated and tested here
 * rather than hand-assembled in the runbook.
 */

/**
 * Reduces `Set-Cookie` response headers to `name=value` pairs.
 *
 * Attributes are dropped, and a clearing cookie (empty value or the epoch
 * expiry NextAuth sends on sign-out) is skipped — otherwise a later, empty
 * cookie would overwrite the real session token in the jar.
 */
export function cookiePairs(setCookieHeaders = []) {
  const pairs = [];
  for (const raw of setCookieHeaders) {
    if (typeof raw !== "string" || !raw) continue;
    const [pair] = raw.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || value === "" || value === '""') continue;
    if (/expires=thu, 01 jan 1970/i.test(raw)) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs;
}

/**
 * True when this session cookie can only be sent over TLS.
 *
 * `src/lib/auth.ts` mints `__Secure-…` session cookies with `secure: true` in
 * production, and curl (correctly) refuses to send a Secure cookie over plain
 * http. So a jar captured from `http://127.0.0.1:3061` cannot authenticate a
 * later `curl -b` — the local probe has to use the https origin it will actually
 * be served on, or the check silently reports a dead session.
 */
export function isSecureSessionCookie(cookieName) {
  return String(cookieName).startsWith("__Secure-") || String(cookieName).startsWith("__Host-");
}

/**
 * Serialises `name=value` pairs into a Netscape cookie file.
 *
 * One tab-separated line per cookie:
 *   domain  includeSubdomains  path  secure  expiry  name  value
 * `secure` follows the target scheme so the same jar works for
 * `http://127.0.0.1:3061` and `https://learn.alolabs.net`.
 */
export function toNetscapeJar(origin, pairs, { now = Date.now() } = {}) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return "";
  }
  const domain = url.hostname;
  const secure = url.protocol === "https:" ? "TRUE" : "FALSE";
  const expiry = Math.floor(now / 1000) + 60 * 60 * 12; // 12 hours
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Written by scripts/verification/verify-live.mjs — contains a live session.",
    "# Delete it when finished: rm -f <this file>",
  ];
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    // A __Secure- cookie is Secure by definition, whatever the origin says; the
    // flag must match the browser's rule or curl will refuse to send it.
    const cookieSecure = isSecureSessionCookie(name) ? "TRUE" : secure;
    // A cookie value is tab/newline free by definition; anything else is a
    // malformed header and would corrupt the file.
    if (/[\t\r\n]/.test(name) || /[\t\r\n]/.test(value)) continue;
    lines.push([domain, "FALSE", "/", cookieSecure, String(expiry), name, value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/** Netscape format wants a leading dot for a domain cookie; IPs must stay bare. */
export function cookieDomain(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}
