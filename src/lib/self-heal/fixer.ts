// ALO Learning Journey — Self-healing fix registry (server-only).
//
// Every fix is an allowlisted, auditable operation. Risk tiers:
//   safe       — read-only or easily reversible; may auto-run after scan.
//   approval   — changes system state; requires owner approval in the
//                Super Admin dashboard (creates a pending SuperAdminAction).
//   destructive— never auto-applied; blocked with an explanation.
//
// The AI never executes arbitrary code, SQL, or file writes. Only the
// functions below exist. Unknown fix kinds are rejected.

import { db } from "@/lib/db";
import { getRouterStatus, setPreferredProvider } from "@/lib/omni/router";
import { recordOutcome, suggestFix } from "@/lib/self-heal/learner";

export type FixRisk = "safe" | "approval" | "destructive";

export interface FixDefinition {
  id: string;
  title: string;
  risk: FixRisk;
  description: string;
}

export const FIX_REGISTRY: FixDefinition[] = [
  {
    id: "rotate_provider",
    title: "Rotate to next healthy provider",
    risk: "safe",
    description: "Moves the preferred omni-router provider to the next healthy one in chain order. Reversible at any time.",
  },
  {
    id: "clear_cooldowns",
    title: "Clear provider cooldowns",
    risk: "safe",
    description: "Resets in-memory circuit-breaker cooldowns so providers can be probed again immediately.",
  },
  {
    id: "enable_external_ai",
    title: "Show external-AI setup steps",
    risk: "safe",
    description: "Returns the exact env vars the owner must set on the server. Never changes server config itself.",
  },
  {
    id: "check_db_config",
    title: "Show database config checklist",
    risk: "safe",
    description: "Returns a read-only checklist (DATABASE_URL scheme, migration status). Never touches the database.",
  },
  {
    id: "investigate_page",
    title: "Investigate failing page",
    risk: "safe",
    description: "Re-browses the page and returns diagnostics (status, title, latency). Read-only.",
  },
  {
    id: "rescan_site",
    title: "Re-scan public pages",
    risk: "safe",
    description: "Runs a fresh safe-browser scan of public pages and updates findings.",
  },
  {
    id: "publish_announcement",
    title: "Publish site announcement",
    risk: "approval",
    description: "Creates a site announcement. Requires owner approval before publishing.",
  },
  {
    id: "update_site_text",
    title: "Update site text",
    risk: "approval",
    description: "Edits site copy. Requires owner approval; the exact text is shown before applying.",
  },
  {
    id: "delete_data",
    title: "Delete data",
    risk: "destructive",
    description: "Blocked. Data deletion is never performed by the self-healing system.",
  },
];

export function getFix(id: string): FixDefinition | undefined {
  return FIX_REGISTRY.find((f) => f.id === id);
}

export interface FixResult {
  ok: boolean;
  fixId: string;
  risk: FixRisk;
  message: string;
  data?: Record<string, unknown>;
  /**
   * Recovery verification (Phase 4): after applying a fix that claims to
   * restore a service, we RE-CHECK the actual service state and only report
   * `verified: true` when the signal cleared. `evidence` is the observed
   * state. Advisory fixes (checklists) report `verified: null` (n/a).
   */
  recovery?: { verified: boolean | null; evidence: string };
}

/** Execute a safe fix immediately. Approval/destructive fixes are refused. */
export async function applySafeFix(fixId: string, context?: { url?: string }): Promise<FixResult> {
  const fix = getFix(fixId);
  if (!fix) return { ok: false, fixId, risk: "destructive", message: `Unknown fix kind: ${fixId}` };
  if (fix.risk === "destructive") {
    return { ok: false, fixId, risk: fix.risk, message: "Blocked: destructive fixes are never applied by self-healing." };
  }
  if (fix.risk === "approval") {
    return { ok: false, fixId, risk: fix.risk, message: "Requires owner approval. Create a pending action in the Super Admin dashboard." };
  }

  try {
    switch (fix.id) {
      case "rotate_provider": {
        const status = await getRouterStatus();
        const healthy = status.chainOrder.filter((id) => {
          const h = status.health.find((x) => x.providerId === id);
          return !h || h.status === "healthy" || h.status === "unknown";
        });
        const current = status.preferredProvider;
        const next = healthy.find((id) => id !== current) ?? healthy[0] ?? null;
        await setPreferredProvider(next);
        // Verify: re-read state and confirm the pinned provider is actually
        // usable (configured), not just "no failure recorded yet".
        const after = await getRouterStatus();
        let verified = false;
        let evidence = "no provider pinned";
        if (next) {
          if (next === "local-ollama") {
            verified = after.local !== null;
            evidence = `local Ollama ${after.local ? `reachable at ${after.local.baseUrl}` : "not reachable"}`;
          } else {
            const cfg = after.external.providers.find((p: any) => p.provider === next);
            verified = Boolean(cfg?.configured);
            evidence = `provider ${next} ${cfg?.configured ? "configured and ready" : `not ready (${cfg?.reason ?? "unknown"})`}`;
          }
        }
        await recordOutcome("provider_down:*", "rotate_provider", verified);
        return {
          ok: next !== null,
          fixId,
          risk: fix.risk,
          message: next
            ? verified
              ? `Preferred provider set to ${next} (verified usable).`
              : `Preferred provider set to ${next}, but it is not usable yet: ${evidence}. Traffic will skip it to the next in chain.`
            : "No healthy provider found; chain order unchanged.",
          data: { preferredProvider: next },
          recovery: { verified, evidence },
        };
      }
      case "clear_cooldowns": {
        const { _resetRouterState } = await import("@/lib/omni/router");
        // Only clear cooldowns, keep preferred provider: re-apply it after reset.
        const status = await getRouterStatus();
        const preferred = status.preferredProvider;
        _resetRouterState();
        if (preferred) await setPreferredProvider(preferred);
        // Verify: re-read and confirm the cooldown list is actually empty.
        const after = await getRouterStatus();
        const verified = after.cooldowns.length === 0;
        const evidence = verified
          ? "no providers in cooldown"
          : `${after.cooldowns.length} provider(s) still in cooldown: ${after.cooldowns.map((c) => c.providerId).join(", ")}`;
        await recordOutcome("provider_down:*", "clear_cooldowns", verified);
        return {
          ok: verified,
          fixId,
          risk: fix.risk,
          message: verified
            ? "Provider cooldowns cleared (verified empty). Providers will be probed on next request."
            : `Cooldowns could not be fully cleared: ${evidence}.`,
          recovery: { verified, evidence },
        };
      }
      case "enable_external_ai": {
        return {
          ok: true,
          fixId,
          risk: fix.risk,
          message: "Set these on the server (.env), then restart the app:",
          data: {
            steps: [
              "ALO_PAID_AI_API_ALLOWED=true",
              "ALO_OWNER_APPROVED_PAID_AI_API=true",
              "GROQ_API_KEY=<free key from https://console.groq.com> (or OPENROUTER_API_KEY / LLM7_API_KEY / OPENCODE_API_KEY)",
              "Optional: ALO_EXTERNAL_AI_PROVIDERS=groq,openrouter,llm7,opencode,omniroute",
            ],
          },
          recovery: { verified: null, evidence: "advisory checklist — no service state changed; run a provider probe after applying" },
        };
      }
      case "check_db_config": {
        const url = process.env.DATABASE_URL ?? "";
        const scheme = url.split(":")[0] || "(unset)";
        return {
          ok: true,
          fixId,
          risk: fix.risk,
          message: "Database config checklist (read-only):",
          data: {
            scheme,
            productionRequiresMysql: process.env.NODE_ENV === "production",
            note: "If the scheme is not mysql in production, set a MySQL DATABASE_URL. Apply migrations only via the rehearsal in MIGRATION-RECOVERY-PLAN.md — never run prisma migrate deploy blindly.",
          },
          recovery: { verified: null, evidence: "advisory checklist — no service state changed" },
        };
      }
      case "investigate_page": {
        const { browseUrl } = await import("@/lib/self-heal/browser");
        const target = context?.url;
        if (!target) return { ok: false, fixId, risk: fix.risk, message: "No URL provided for investigation." };
        const result = await browseUrl(target);
        const evidence = result.ok
          ? `HTTP ${result.status}, ${result.latencyMs}ms, title "${result.title ?? "(none)"}"`
          : `${result.error ?? `HTTP ${result.status}`} after re-browse`;
        return {
          ok: result.ok,
          fixId,
          risk: fix.risk,
          message: result.ok ? `Page OK: HTTP ${result.status}, title "${result.title ?? "(none)"}", ${result.latencyMs}ms.` : `Page failing: ${result.error ?? `HTTP ${result.status}`}.`,
          data: { status: result.status, title: result.title, latencyMs: result.latencyMs, error: result.error },
          recovery: { verified: result.ok, evidence },
        };
      }
      case "rescan_site": {
        const { detectErrors, persistFindings } = await import("@/lib/self-heal/detector");
        const report = await detectErrors();
        await persistFindings(report.findings);
        const verified = report.findings.length === 0;
        return {
          ok: true,
          fixId,
          risk: fix.risk,
          message: `Re-scan complete: ${report.findings.length} finding(s) ${verified ? "— all clear" : "remain"}.`,
          data: { count: report.findings.length },
          recovery: { verified, evidence: verified ? "re-scan found no findings" : `${report.findings.length} finding(s) still present after re-scan` },
        };
      }
      default:
        return { ok: false, fixId, risk: fix.risk, message: `Fix ${fixId} has no safe executor.` };
    }
  } catch (err) {
    await recordOutcome("fix_error:*", fixId, false).catch(() => undefined);
    return { ok: false, fixId, risk: fix.risk, message: err instanceof Error ? err.message.slice(0, 300) : "Fix failed." };
  }
}

/** Mark a finding fixed (after a successful fix) and audit it. */
export async function markFindingFixed(findingId: string, fixKind: string): Promise<void> {
  try {
    await db.selfHealFinding.update({
      where: { id: findingId },
      data: { status: "fixed", resolvedAt: new Date() },
    });
  } catch {
    // ignore
  }
  try {
    await db.auditLog.create({
      data: {
        actor: "SelfHeal",
        action: "selfheal.fix_applied",
        detail: `Finding ${findingId} fixed via ${fixKind}`,
        severity: "info",
      },
    });
  } catch {
    // ignore
  }
}

export { suggestFix };
