const PHONE_E164 = /^\+[1-9]\d{6,14}$/;

/**
 * `scrypt$<salt>$<hash>` from `scripts/hash-admin-password.mjs`.
 *
 * The `$` separators make this value hazardous in a `.env` file: every loader
 * this app uses (`next start`, `--env-file`, `@next/env`, Docker `--env-file`)
 * performs `${VAR}` interpolation, so a bare hash is silently rewritten before
 * the process ever sees it:
 *
 *   scrypt$YwZ-v2IOaiUq…$T5_KTWnDgo4V…
 *          └── `$YwZ` is treated as a variable reference and deleted ──┘
 *
 * The result is an ~80-character string with no `$` at all. That is
 * unrecoverable — the deleted characters are part of the random salt and hash —
 * so it must never be treated as a valid hash, and the operator must be told
 * exactly what happened instead of the misleading "sign-in is not configured".
 *
 * Two forms are therefore accepted, and only these:
 *   - the literal hash (PM2 `env`, `docker -e`, CI secrets), and
 *   - the escaped hash (`scrypt\$…\$…`), which is what `.env` needs.
 */
const SCRYPT_LITERAL = /^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;
const SCRYPT_ESCAPED = /^scrypt\\\$[A-Za-z0-9_-]{22}\\\$[A-Za-z0-9_-]{86}$/;

/** Normalises a configured scrypt hash, or returns null when it is not one. */
export function parseAdminPasswordHash(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  if (SCRYPT_LITERAL.test(value)) return value;
  if (SCRYPT_ESCAPED.test(value)) return value.replace(/\\\$/g, "$");
  return null;
}

export type AdminPasswordHashStatus =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "interpolated" };

/**
 * Explains the configured hash, so operators see the real cause. `interpolated`
 * means the value is present but was rewritten by dotenv interpolation.
 */
export function adminPasswordHashStatus(raw: string | undefined = process.env.ADMIN_PASSWORD_HASH): AdminPasswordHashStatus {
  const value = (raw ?? "").trim();
  if (!value) return { state: "missing" };
  if (parseAdminPasswordHash(value)) return { state: "ok" };
  // Anything that still looks like a scrypt hash but no longer parses was
  // damaged on the way in. `$YwZ…` is only eaten when the character after `$` is
  // a letter, so a `.env`-loaded hash can arrive in several shapes (both
  // separators gone, one gone, or one kept as a literal `$`). All of them are
  // "interpolated" for the operator — and all of them still fail authentication.
  if (/^scrypt/i.test(value)) return { state: "interpolated" };
  return { state: "missing" };
}

/** True when the environment carries a usable administrator password hash. */
export function adminPasswordHashConfigured(): boolean {
  return adminPasswordHashStatus().state === "ok";
}

export function isAdminOtpRequired(): boolean {
  if (process.env.ADMIN_OTP_REQUIRED === "false") return false;
  return process.env.NODE_ENV === "production" || process.env.ADMIN_OTP_REQUIRED === "true";
}

export function isAdminOtpDeliveryConfigured(): boolean {
  const recipient = process.env.ADMIN_OTP_PHONE?.trim() ?? "";
  const sender = process.env.HTTPSMS_FROM?.trim() ?? "";
  const apiKey = process.env.HTTPSMS_API_KEY?.trim() ?? "";
  const base = process.env.HTTPSMS_BASE_URL?.trim() || "https://api.httpsms.com";
  if (!PHONE_E164.test(recipient) || !PHONE_E164.test(sender) || !apiKey) return false;

  try {
    const url = new URL(base);
    return (url.protocol === "https:" || (process.env.NODE_ENV !== "production" && url.protocol === "http:")) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isAdminAuthenticationConfigured(): boolean {
  const passwordAuthenticationReady = Boolean(
    process.env.NEXTAUTH_SECRET &&
      process.env.ADMIN_EMAIL?.trim() &&
      adminPasswordHashConfigured()
  );
  return passwordAuthenticationReady && (!isAdminOtpRequired() || isAdminOtpDeliveryConfigured());
}
