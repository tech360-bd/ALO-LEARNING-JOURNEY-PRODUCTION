import { runtimeEnvSync } from "../runtime-config";
/**
 * Fail-closed gate for legacy external AI SDK calls. Unknown provider billing
 * is treated as potentially paid. Both switches must be explicitly configured
 * by the server owner after approval; API users cannot change either value.
 */
export function assertExternalAiAllowed(provider: string): void {
  const globallyEnabled = process.env.ALO_PAID_AI_API_ALLOWED === "true";
  const ownerApproved = process.env.ALO_OWNER_APPROVED_PAID_AI_API === "true";
  if (!globallyEnabled || !ownerApproved) {
    throw new Error(`external_ai_blocked_by_payment_guard:${provider}`);
  }
}

export function isExternalAiAllowed(): boolean {
  // Read through the shared env lookup so the owner switches can also be set from
  // the Super Admin dashboard (they are allowlisted, non-secret values). The rule
  // itself is unchanged: BOTH must be true, and a real environment variable wins.
  const allowed = envFlag("ALO_PAID_AI_API_ALLOWED");
  const approved = envFlag("ALO_OWNER_APPROVED_PAID_AI_API");
  return allowed === "true" && approved === "true";
}

function envFlag(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  // Dashboard value, best-effort: undefined means "not set", which keeps the
  // guard closed. A stale cache can only ever fail closed, never open.
  try {
    return runtimeEnvSync(name);
  } catch {
    return undefined;
  }
}
