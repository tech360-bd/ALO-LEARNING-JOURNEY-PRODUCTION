// ALO Learning Journey — Self-healing learning memory (server-only).
//
// Self-learning loop: every fix attempt records (pattern -> fix -> outcome).
// Future scans suggest the fix with the best historical success rate for
// each error pattern. Persisted to SelfHealLearning when the DB is
// available; otherwise kept in memory (still useful within the process).
//
// Pattern format: "<kind>:<subject>" e.g. "provider_down:groq",
// "http_error:learn.alolabs.net/login". Subjects are normalized (lowercase,
// truncated) so similar errors share one learning record.

import { db } from "@/lib/db";

export interface LearnedSuggestion {
  pattern: string;
  fixKind: string;
  attempts: number;
  successes: number;
  successRate: number;
}

const mem = new Map<string, { fixKind: string; attempts: number; successes: number; lastSuccessAt: string | null }>();

export function normalizePattern(kind: string, subject?: string): string {
  const s = (subject ?? "*").toLowerCase().trim().replace(/\s+/g, "_").slice(0, 80) || "*";
  return `${kind.toLowerCase().trim()}:${s}`;
}

/** Record one fix outcome. Never throws. */
export async function recordOutcome(pattern: string, fixKind: string, success: boolean): Promise<void> {
  const key = pattern.toLowerCase().trim();
  const m = mem.get(key) ?? { fixKind, attempts: 0, successes: 0, lastSuccessAt: null };
  m.fixKind = fixKind;
  m.attempts += 1;
  if (success) {
    m.successes += 1;
    m.lastSuccessAt = new Date().toISOString();
  }
  mem.set(key, m);

  try {
    const existing = await db.selfHealLearning.findUnique({ where: { pattern: key } });
    if (existing) {
      await db.selfHealLearning.update({
        where: { pattern: key },
        data: {
          fixKind,
          attempts: existing.attempts + 1,
          successes: existing.successes + (success ? 1 : 0),
          lastSuccessAt: success ? new Date() : existing.lastSuccessAt,
        },
      });
    } else {
      await db.selfHealLearning.create({
        data: { pattern: key, fixKind, attempts: 1, successes: success ? 1 : 0, lastSuccessAt: success ? new Date() : null },
      });
    }
  } catch {
    // DB unavailable — memory record stands.
  }
}

/** Best learned fix for a pattern, or null when never tried. */
export async function suggestFix(pattern: string): Promise<LearnedSuggestion | null> {
  const key = pattern.toLowerCase().trim();
  const m = mem.get(key);
  if (m && m.attempts > 0) {
    return { pattern: key, fixKind: m.fixKind, attempts: m.attempts, successes: m.successes, successRate: m.successes / m.attempts };
  }
  try {
    const row = await db.selfHealLearning.findUnique({ where: { pattern: key } });
    if (row && row.attempts > 0) {
      return { pattern: key, fixKind: row.fixKind, attempts: row.attempts, successes: row.successes, successRate: row.successes / row.attempts };
    }
  } catch {
    // ignore
  }
  return null;
}

/** Top learned patterns by success rate (for the dashboard). */
export async function topPatterns(limit = 20): Promise<LearnedSuggestion[]> {
  const out = new Map<string, LearnedSuggestion>();
  try {
    const rows = await db.selfHealLearning.findMany({ orderBy: { successes: "desc" }, take: limit });
    for (const r of rows) {
      out.set(r.pattern, {
        pattern: r.pattern,
        fixKind: r.fixKind,
        attempts: r.attempts,
        successes: r.successes,
        successRate: r.attempts > 0 ? r.successes / r.attempts : 0,
      });
    }
  } catch {
    // ignore
  }
  for (const [pattern, m] of mem) {
    if (!out.has(pattern)) {
      out.set(pattern, {
        pattern,
        fixKind: m.fixKind,
        attempts: m.attempts,
        successes: m.successes,
        successRate: m.attempts > 0 ? m.successes / m.attempts : 0,
      });
    }
  }
  return [...out.values()].sort((a, b) => b.successRate - a.successRate || b.successes - a.successes).slice(0, limit);
}

/** Test hook. */
export function _resetLearner(): void {
  mem.clear();
}
