/**
 * Self-verification for agent runs (server-only).
 *
 * The owner's requirement is specific: an agent must be able to check its own
 * work — "did what I produced actually match the instruction?" — and, when it
 * did not, correct itself once and report back. That is what this module adds.
 *
 * Two kinds of evidence, both deterministic (never "the model says it is fine"):
 *
 *   1. `browse` — the model may return URLs in its final answer. Each one is
 *      fetched through `src/lib/self-heal/browser.ts`, which enforces the SSRF
 *      guard, a scheme allowlist, a timeout, a response-size cap and a redirect
 *      cap. A URL the agent claims to have used must actually load.
 *   2. `check` — pass/fail assertions the caller supplies about the result
 *      (e.g. "the answer contains a link", "the draft is non-empty"). They are
 *      plain functions, so a test can pin them and no model can talk past them.
 *
 * The repair step is deliberately bounded: exactly one retry, and the retry is
 * fed the *specific failures* rather than "try again". If the second attempt
 * also fails, the run is reported as `failed` with the evidence — a false
 * "completed" is worse than an honest failure, because an admin reading the
 * dashboard would act on it.
 */

import { browseUrl, type BrowseResult } from "@/lib/self-heal/browser";

export interface VerifyCheck {
  /** Stable id, shown to the owner and used in logs. */
  id: string;
  /** What is being asserted, in the owner's language. */
  description: string;
  /** Return true when the result satisfies the instruction. */
  test: (answer: string) => boolean;
  /** Optional: only run when the answer mentions one of these. */
  when?: (answer: string) => boolean;
}

export interface VerifyFailure {
  id: string;
  detail: string;
  kind: "check" | "browse";
}

export interface VerifyReport {
  ok: boolean;
  checkedAt: string;
  checks: Array<{ id: string; ok: boolean; description: string }>;
  browsed: Array<{ url: string; ok: boolean; status: number | null; title: string | null; error: string | null }>;
  failures: VerifyFailure[];
  /** True when the run had to be repaired before it passed. */
  repaired: boolean;
  /** The instruction used for the repair attempt (empty when no repair ran). */
  repairInstruction?: string;
}

/** URLs written by the model, deduplicated, http(s) only, capped. */
export function extractUrls(answer: string, limit = 5): string[] {
  const found = String(answer ?? "").match(/https?:\/\/[^\s<>"'`)\]]+/gi) ?? [];
  const cleaned = found.map((raw) => raw.replace(/[.,;:!?]+$/, ""));
  return [...new Set(cleaned)].slice(0, limit);
}

/**
 * Runs the checks and the browse assertions. Never throws: a verification step
 * that can crash the run would be worse than no verification.
 */
export async function verifyAnswer(params: {
  answer: string;
  checks?: VerifyCheck[];
  /** Off when the deployment has no outbound network (tests, air-gapped hosts). */
  browse?: boolean;
  /**
   * Override the fetcher. Production always uses `browseUrl` (SSRF guard, size
   * cap, redirect cap). The seam exists because the guard blocks loopback, so a
   * hermetic test cannot stand a server on 127.0.0.1 and still exercise the real
   * path — the guard's own behaviour is asserted separately instead of being
   * relaxed here for tests.
   */
  browseFn?: (url: string) => Promise<BrowseResult>;
}): Promise<VerifyReport> {
  const answer = String(params.answer ?? "");
  const checks: VerifyReport["checks"] = [];
  const failures: VerifyFailure[] = [];

  for (const check of params.checks ?? []) {
    if (check.when && !check.when(answer)) continue;
    let ok = false;
    try {
      ok = Boolean(check.test(answer));
    } catch (error) {
      failures.push({ id: check.id, kind: "check", detail: `check threw: ${(error as Error)?.message ?? error}` });
      checks.push({ id: check.id, ok: false, description: check.description });
      continue;
    }
    checks.push({ id: check.id, ok, description: check.description });
    if (!ok) failures.push({ id: check.id, kind: "check", detail: check.description });
  }

  const browsed: VerifyReport["browsed"] = [];
  if (params.browse !== false) {
    const fetchPage = params.browseFn ?? browseUrl;
    const urls = extractUrls(answer);
    const results = await Promise.all(
      urls.map((url) => fetchPage(url).catch((error) => ({
        url,
        ok: false,
        status: null,
        title: null,
        links: [],
        brokenLinks: [],
        error: `browse failed: ${(error as Error)?.message ?? error}`,
        latencyMs: 0,
        truncated: false,
      } as BrowseResult)))
    );
    for (const r of results) {
      browsed.push({ url: r.url, ok: r.ok, status: r.status, title: r.title, error: r.error });
      if (!r.ok) {
        failures.push({
          id: `browse:${r.url}`,
          kind: "browse",
          detail: r.error ?? (r.status ? `HTTP ${r.status}` : "unreachable"),
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    browsed,
    failures,
    repaired: false,
  };
}

/**
 * The instruction for the single repair attempt. It quotes the failures instead
 * of asking the model to "try again", which is the difference between a repair
 * and a coin flip.
 */
export function buildRepairInstruction(originalTask: string, report: VerifyReport): string {
  const lines = report.failures.map((f) => `- ${f.id}: ${f.detail}`).join("\n");
  return [
    "Your previous answer failed verification. Fix exactly these problems and answer again.",
    `Original instruction: ${originalTask.slice(0, 1500)}`,
    "Problems detected:",
    lines,
    "Rules: do not invent URLs or citations; if a link cannot be verified, either link to a page you are sure exists or say the link could not be checked. Return only the corrected answer.",
  ].join("\n\n");
}

/**
 * One repair cycle. `retry` runs the same task again with the failure text.
 * Returns the (possibly corrected) answer and a report that says whether the
 * repair happened and whether it worked.
 */
export async function verifyWithRepair(params: {
  task: string;
  answer: string;
  checks?: VerifyCheck[];
  browse?: boolean;
  browseFn?: (url: string) => Promise<BrowseResult>;
  /** Produces a new answer from the repair instruction; omitted = no repair. */
  repair?: (instruction: string) => Promise<string>;
}): Promise<{ answer: string; report: VerifyReport }> {
  const first = await verifyAnswer({
    answer: params.answer,
    checks: params.checks,
    browse: params.browse,
    browseFn: params.browseFn,
  });
  if (first.ok || !params.repair) return { answer: params.answer, report: first };

  const instruction = buildRepairInstruction(params.task, first);
  let repairedAnswer: string;
  try {
    repairedAnswer = await params.repair(instruction);
  } catch (error) {
    return {
      answer: params.answer,
      report: { ...first, repaired: false, repairInstruction: instruction, failures: [
        ...first.failures,
        { id: "repair", kind: "check", detail: `repair attempt failed: ${(error as Error)?.message ?? error}` },
      ] },
    };
  }

  const second = await verifyAnswer({
    answer: repairedAnswer,
    checks: params.checks,
    browse: params.browse,
    browseFn: params.browseFn,
  });
  return {
    answer: repairedAnswer,
    // `repaired` means "a repair was attempted and the result now passes".
    report: { ...second, repaired: second.ok, repairInstruction: instruction },
  };
}
