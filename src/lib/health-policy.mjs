/**
 * Health-probe policy for the database configuration check.
 *
 * Kept in a plain `.mjs` module so the probe and the test runner share the exact
 * same rule (the route handler itself cannot be imported by node:test because it
 * pulls in Prisma).
 *
 * Production must be MySQL — SQLite/JSON persistence is not supported. Outside
 * production an unset or non-MySQL `DATABASE_URL` is a documented development
 * fallback (`src/lib/db.ts`), so it must not turn `/api/health` into a 503: that
 * made every local and preview environment report an unhealthy app even though
 * the database check itself passed.
 */
export function mysqlConfigurationOk({ nodeEnv, databaseUrl }) {
  const scheme = String(databaseUrl ?? "").split(":")[0] || "";
  const isMySql = scheme === "mysql" || scheme === "mysqls";
  if (nodeEnv === "production") return Boolean(databaseUrl) && isMySql;
  // Outside production: usable as configured, and the fallback is also usable.
  return true;
}

/** Human-readable detail for the health payload (never includes credentials). */
export function mysqlConfigurationDetail({ nodeEnv, databaseUrl }) {
  const scheme = String(databaseUrl ?? "").split(":")[0] || "";
  if (!databaseUrl) {
    return nodeEnv === "production"
      ? "production requires a MySQL DATABASE_URL"
      : "unset; unverified local JSON persistence is a development-only fallback";
  }
  if (scheme === "mysql" || scheme === "mysqls") return "MySQL configured";
  return nodeEnv === "production"
    ? `scheme=${scheme}; production requires MySQL`
    : `scheme=${scheme}; non-MySQL scheme allowed outside production only`;
}
