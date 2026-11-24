/**
 * Local JSON persistence is only a development convenience. Production must
 * fail against the configured Prisma/MySQL connection rather than silently
 * diverting writes to a second data store.
 *
 * @param {{ nodeEnv?: string, databaseUrl?: string | null, configuredFallback?: boolean }} env
 */
export function shouldStartInFallback(env) {
  if (env.nodeEnv === "production") return false;
  if (env.configuredFallback !== undefined) return env.configuredFallback;

  const url = env.databaseUrl?.trim() ?? "";
  return !url || url.includes("REPLACE_WITH_NEW") || url.includes("user:placeholder@");
}

/** @param {string | undefined} nodeEnv */
export function mayFallbackAfterPrismaError(nodeEnv) {
  return nodeEnv !== "production";
}

const CONNECTION_ERROR_CODES = new Set([
  "P1000", // authentication failed
  "P1001", // database server is unreachable
  "P1002", // connection timed out
  "P1003", // database does not exist
  "P1008", // operation timed out
  "P1010", // user was denied access
  "P1011", // TLS connection error
  "P1013", // invalid database connection string
  "P1017", // server closed the connection
]);

/**
 * Only engine initialization and explicit connectivity/configuration failures
 * may switch a non-production process to local JSON persistence. Prisma's
 * generic "Invalid `prisma.*`" messages also cover ordinary constraint and
 * validation errors (for example P2002 unique conflicts), which must reach
 * application handlers instead of silently changing data stores.
 *
 * @param {unknown} error
 */
export function isEngineOrConnectionError(error) {
  if (!error || typeof error !== "object") {
    return /(?:Can't reach database server|Connection refused|Query engine|engine=none|did not initialize yet|P100[0-3]|P1008|P1010|P1011|P1013|P1017)/i.test(String(error));
  }

  const candidate = /** @type {{ name?: unknown, code?: unknown, message?: unknown }} */ (error);
  if (candidate.name === "PrismaClientInitializationError") return true;
  if (typeof candidate.code === "string" && CONNECTION_ERROR_CODES.has(candidate.code)) return true;

  const message = `${String(candidate.name ?? "")}: ${String(candidate.message ?? error)}`;
  return /(?:Query engine|engine=none|did not initialize yet|Please run `prisma generate`|Can't reach database server|Connection refused|Authentication failed against database server|\bP100[0-3]\b|\bP1008\b|\bP1010\b|\bP1011\b|\bP1013\b|\bP1017\b)/i.test(message);
}
