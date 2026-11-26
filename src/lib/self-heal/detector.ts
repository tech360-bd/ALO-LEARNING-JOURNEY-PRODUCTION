// ALO Learning Journey — Self-healing error detector (server-only).
//
// Proactively detects errors across four layers:
//   1. Provider health (omni-router status)
//   2. Database connectivity
//   3. Public web pages (safe browser: HTTP errors, broken links)
//   4. Recent audit-log error patterns
//
// Each layer is an independently exported async function so the Super Admin
// run engine (src/lib/super-admin/runs.ts) can execute each as a real,
// individually-timed timeline step. `detectErrors` composes them for the
// dashboard/scan endpoints.
//
// Findings are persisted to SelfHealFinding (when DB available) and
// returned for the Super Admin dashboard. Detection is read-only —
// fixes are proposed separately by fixer.ts and applied only through
// the approval workflow.

import { db } from "@/lib/db";
import { getRouterStatus } from "@/lib/omni/router";
import { scanSite } from "@/lib/self-heal/browser";

export interface FindingDraft {
  kind: string;
  severity: "info" | "warn" | "error" | "critical";
  title: string;
  detail?: string;
  url?: string;
  fixKind?: string;
}

export interface DetectionReport {
  findings: FindingDraft[];
  checkedAt: string;
  layers: { providers: boolean; database: boolean; browser: boolean; logs: boolean };
}

function siteBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://learn.alolabs.net";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://learn.alolabs.net";
  }
}

// ── Layer 1: provider health ───────────────────────────────────────────────
export async function detectLayerProvider(): Promise<FindingDraft[]> {
  const findings: FindingDraft[] = [];
  try {
    const status = await getRouterStatus();
    if (!status.external.enabled) {
      findings.push({
        kind: "provider_down",
        severity: "warn",
        title: "External free providers disabled",
        detail: "Both owner switches are not true, so only local Ollama can answer. Enable ALO_PAID_AI_API_ALLOWED + ALO_OWNER_APPROVED_PAID_AI_API with a free provider key to use omni-routing.",
        fixKind: "enable_external_ai",
      });
    } else if (!status.external.configured) {
      findings.push({
        kind: "provider_down",
        severity: "error",
        title: "No external provider configured",
        detail: "Owner switches are on but no provider has a valid API key. Add a free-tier key (e.g. GROQ_API_KEY) on the server.",
        fixKind: "enable_external_ai",
      });
    }
    for (const h of status.health) {
      if (h.status === "cooldown" || h.status === "down") {
        findings.push({
          kind: "provider_down",
          severity: h.status === "cooldown" ? "warn" : "error",
          title: `Provider ${h.providerId} is ${h.status}`,
          detail: `Consecutive failures: ${h.consecutiveFailures}. ${h.lastError ?? ""}`.trim(),
          fixKind: "rotate_provider",
        });
      } else if (h.status === "degraded") {
        findings.push({
          kind: "provider_down",
          severity: "warn",
          title: `Provider ${h.providerId} is degraded`,
          detail: `Consecutive failures: ${h.consecutiveFailures}.`,
          fixKind: "rotate_provider",
        });
      }
    }
    if (status.cooldowns.length > 0) {
      findings.push({
        kind: "provider_down",
        severity: "info",
        title: `${status.cooldowns.length} provider(s) in cooldown`,
        detail: status.cooldowns.map((c) => `${c.providerId} (retry in ${Math.ceil(c.retryAfterMs / 1000)}s)`).join(", "),
      });
    }
  } catch (err) {
    findings.push({
      kind: "provider_down",
      severity: "error",
      title: "Provider status check failed",
      detail: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
    });
  }
  return findings;
}

// ── Layer 2: database ──────────────────────────────────────────────────────
export async function detectLayerDatabase(): Promise<FindingDraft[]> {
  const findings: FindingDraft[] = [];
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    findings.push({
      kind: "db_error",
      severity: "critical",
      title: "Database unreachable",
      detail: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
      fixKind: "check_db_config",
    });
  }
  return findings;
}

// ── Layer 3: public web pages (safe browser) ───────────────────────────────
export async function detectLayerWeb(): Promise<FindingDraft[]> {
  const findings: FindingDraft[] = [];
  try {
    const scan = await scanSite(siteBaseUrl());
    for (const page of scan.pages) {
      if (!page.ok) {
        findings.push({
          kind: "http_error",
          severity: page.status && page.status >= 500 ? "error" : "warn",
          title: `Page error: ${page.url}`,
          detail: page.error ?? `HTTP ${page.status ?? "unknown"}`,
          url: page.url,
          fixKind: "investigate_page",
        });
      } else if (!page.title) {
        findings.push({
          kind: "seo",
          severity: "info",
          title: `Missing page title: ${page.url}`,
          url: page.url,
        });
      }
      if (page.latencyMs > 5000) {
        findings.push({
          kind: "perf",
          severity: "warn",
          title: `Slow page: ${page.url}`,
          detail: `Responded in ${page.latencyMs}ms (threshold 5000ms).`,
          url: page.url,
        });
      }
    }
    for (const broken of scan.brokenLinks.slice(0, 10)) {
      findings.push({
        kind: "broken_link",
        severity: "warn",
        title: "Broken link detected",
        detail: broken,
        fixKind: "investigate_page",
      });
    }
  } catch (err) {
    findings.push({
      kind: "http_error",
      severity: "warn",
      title: "Web scan failed",
      detail: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
    });
  }
  return findings;
}

// ── Layer 4: recent audit-log error patterns ───────────────────────────────
export async function detectLayerLogs(): Promise<FindingDraft[]> {
  const findings: FindingDraft[] = [];
  try {
    const errors = await db.auditLog.findMany({
      where: { severity: { in: ["error", "critical"] } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const byAction = new Map<string, number>();
    for (const e of errors) byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
    for (const [action, count] of byAction) {
      if (count >= 3) {
        findings.push({
          kind: "log_error",
          severity: "warn",
          title: `Repeated errors: ${action} (×${count})`,
          detail: "Same action failed repeatedly in recent audit logs. Review the audit trail for the root cause.",
        });
      }
    }
  } catch {
    // Audit log unavailable (pre-migration) — skip silently.
  }
  return findings;
}

// ── Composition (dashboard / scan endpoints) ───────────────────────────────
export async function detectErrors(opts?: { scanWeb?: boolean }): Promise<DetectionReport> {
  const findings: FindingDraft[] = [];
  const layers = { providers: false, database: false, browser: false, logs: false };

  const [providerFindings, dbFindings, webFindings, logFindings] = await Promise.all([
    detectLayerProvider(),
    detectLayerDatabase(),
    opts?.scanWeb === false ? Promise.resolve([] as FindingDraft[]) : detectLayerWeb(),
    detectLayerLogs(),
  ]);
  layers.providers = true;
  layers.database = true;
  layers.browser = opts?.scanWeb !== false;
  layers.logs = true;

  findings.push(...providerFindings, ...dbFindings, ...webFindings, ...logFindings);
  return { findings, checkedAt: new Date().toISOString(), layers };
}

/** Persist findings (dedupe open ones with same kind+title). Returns saved rows. */
export async function persistFindings(drafts: FindingDraft[]): Promise<any[]> {
  const saved: any[] = [];
  for (const d of drafts) {
    try {
      const existing = await db.selfHealFinding.findFirst({
        where: { kind: d.kind, title: d.title, status: "open" },
      });
      if (existing) {
        saved.push(existing);
        continue;
      }
      const row = await db.selfHealFinding.create({
        data: {
          kind: d.kind,
          severity: d.severity,
          title: d.title,
          detail: d.detail,
          url: d.url,
          fixKind: d.fixKind,
        },
      });
      saved.push(row);
    } catch {
      // DB unavailable — findings still returned to the caller.
    }
  }
  return saved;
}

export async function listOpenFindings(limit = 50): Promise<any[]> {
  try {
    return await db.selfHealFinding.findMany({
      where: { status: "open" },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: limit,
    });
  } catch {
    return [];
  }
}
