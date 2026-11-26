/**
 * Administrator password verification (scrypt).
 *
 * Kept separate from `auth.ts` on purpose: `auth.ts` also builds the
 * next-auth provider chain, which pulls in next-auth internals that the
 * node:test runner cannot load with `--experimental-strip-types`. The login
 * route, the health probe and the tests all need *only* this check, so it lives
 * in a dependency-free module.
 */
import { scryptSync, timingSafeEqual } from "node:crypto";
import { parseAdminPasswordHash } from "./auth-config";

function safeEqualText(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Verifies email + password against `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`.
 *
 * The hash is read through `parseAdminPasswordHash()`, so a hash that survived
 * `.env` interpolation (bare, escaped or expanded) verifies identically —
 * otherwise the login page reports "configured" and the sign-in still fails.
 */
export function verifyAdminCredentials(email: string, password: string): boolean {
  const configuredEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const encodedHash = parseAdminPasswordHash(process.env.ADMIN_PASSWORD_HASH);
  if (!configuredEmail || !encodedHash || !email || !password) return false;
  if (!safeEqualText(email.trim().toLowerCase(), configuredEmail)) return false;

  const [algorithm, encodedSalt, encodedExpected] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !encodedSalt || !encodedExpected) return false;
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const expected = Buffer.from(encodedExpected, "base64url");
    if (salt.length < 16 || expected.length < 32 || expected.length > 128) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
