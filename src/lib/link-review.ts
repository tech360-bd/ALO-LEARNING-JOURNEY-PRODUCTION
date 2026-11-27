/**
 * Link review — "I pasted a GitHub link, is it safe to adopt?"
 *
 * The owner's example is explicit: an agent should thoroughly check a shared
 * GitHub link and, if the code is suitable and carries no risk, integrate it.
 * This module does the *checking* half, deterministically, and produces the
 * evidence an approval needs. It never runs the linked code.
 *
 * ── Hard rules ─────────────────────────────────────────────────────────────
 *  - Public http(s) only, through the SSRF guard (`browseUrl`). A link to
 *    localhost, a private range or a cloud-metadata address is reported, not
 *    fetched.
 *  - Read-only HTTP GETs on well-known public endpoints (`api.github.com` for
 *    repo metadata and the README). No `git clone`, no `npm install`, no
 *    `postinstall`, no script from the repo is ever executed — reviewing a
 *    repository must not be able to execute it.
 *  - The verdict is rule-based (licence, activity, size, risk flags). An AI model
 *    may summarise the README, but it cannot turn a failed rule into a pass.
 *
 * ── Licence is the first gate ──────────────────────────────────────────────
 * Several popular "free" projects are not plain open source (open-webui's
 * branding clause above 50 users, LiteLLM's `enterprise/` directory,
 * `free-claude-code`'s AGPL-3.0-only). Adopting one is a licensing decision, so
 * the verdict names the licence and the risk explicitly instead of saying "MIT-ish".
 */

import { browseUrl } from "@/lib/self-heal/browser";

export type LinkVerdict = "adopt" | "adopt-with-changes" | "review-manually" | "reject";

export interface RepoFacts {
  host: "github.com" | "gitlab.com" | "other";
  owner: string;
  repo: string;
  url: string;
}

export interface LicenceAssessment {
  spdx: string | null;
  name: string;
  /** Copyleft (AGPL/GPL/LGPL/MPL) — obligations, not necessarily a blocker. */
  copyleft: boolean;
  /** Custom/bespoke terms where "free" does not mean "open source". */
  custom: boolean;
  /** Known custom-licence traps this repository has already hit. */
  knownTraps: string[];
  adoptionRisk: "low" | "medium" | "high";
}

export interface LinkReview {
  link: string;
  repo: RepoFacts | null;
  reachable: boolean;
  httpStatus: number | null;
  /** Facts pulled from the GitHub API when it is reachable. */
  metadata?: {
    description: string | null;
    stars: number | null;
    archived: boolean;
    pushedAt: string | null;
    sizeKb: number | null;
    language: string | null;
    licenseSpdx: string | null;
    licenseName: string | null;
    topics: string[];
  };
  licence?: LicenceAssessment;
  /** Things that must be true before this code may be adopted. */
  riskFlags: string[];
  verdict: LinkVerdict;
  /** One-line explanation of the verdict, in the owner's language. */
  summary: string;
  /** Concrete next steps; adoption is always an approval, never automatic. */
  nextSteps: string[];
  checkedAt: string;
  error?: string;
}

/** `https://github.com/owner/repo(/…)` → facts. Sub-paths keep the repo. */
export function parseRepoUrl(raw: string): RepoFacts | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const hostKind: RepoFacts["host"] =
    host === "github.com" ? "github.com" : host === "gitlab.com" ? "gitlab.com" : "other";
  const [owner, repoRaw] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/i, "");
  // Owners/repos are [A-Za-z0-9._-]; anything else is a crafted path, not a repo.
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return { host: hostKind, owner, repo, url: `https://${host}/${owner}/${repo}` };
}

const CUSTOM_LICENCE_NAMES = [
  "other",
  "noassertion",
  "unknown",
  "custom",
  "open webui license",
  "business source license",
  "proprietary",
];

/**
 * Judges a licence string from GitHub's API. `NOASSERTION` means GitHub could not
 * classify it, which is *not* the same as permissive.
 */
export function assessLicence(spdx: string | null, name: string | null): LicenceAssessment {
  const rawSpdx = (spdx ?? "").trim();
  const upper = rawSpdx.toUpperCase();
  const lowerName = (name ?? "").toLowerCase();
  const knownTraps = [
    "open webui license",
    "agpl",
    "business source license",
    "server side public license",
    "elastic license",
  ].filter((trap) => lowerName.includes(trap) || upper.toLowerCase().includes(trap));

  const custom =
    upper === "" ||
    upper === "NOASSERTION" ||
    CUSTOM_LICENCE_NAMES.some((n) => upper.toLowerCase() === n || lowerName === n);
  const copyleft = /^(AGPL|GPL|LGPL|MPL|EUPL|OSL)/.test(upper);
  const permissive = ["MIT", "APACHE-2.0", "BSD-2-CLAUSE", "BSD-3-CLAUSE", "ISC", "0BSD", "UNLICENSE"].includes(upper);

  let adoptionRisk: LicenceAssessment["adoptionRisk"];
  if (upper === "AGPL-3.0" || upper === "AGPL-3.0-ONLY" || upper === "AGPL-3.0-OR-LATER") adoptionRisk = "high";
  else if (custom) adoptionRisk = "high";
  else if (copyleft) adoptionRisk = "medium";
  else if (permissive) adoptionRisk = "low";
  else adoptionRisk = "medium"; // a recognised but unusual licence

  return {
    spdx: rawSpdx || null,
    name: name ?? rawSpdx ?? "unknown",
    copyleft,
    custom,
    knownTraps,
    adoptionRisk,
  };
}

interface GitHubRepoResponse {
  description?: string | null;
  stargazers_count?: number;
  archived?: boolean;
  pushed_at?: string | null;
  size?: number;
  language?: string | null;
  license?: { spdx_id?: string | null; name?: string | null } | null;
  topics?: string[];
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor((Date.now() - ms) / 86_400_000);
}

/**
 * Reviews one link. Never throws: a failure is a verdict
 * (`review-manually` / `reject`) with the reason attached.
 */
export async function reviewLink(
  rawLink: string,
  options: {
    /** GitHub API fetcher (injectable so the verdict rules can be tested offline). */
    fetchJson?: typeof fetch;
    /** Page probe (default: the SSRF-guarded browser). */
    browse?: (url: string) => Promise<{ ok: boolean; status: number | null; error: string | null }>;
  } = {}
): Promise<LinkReview> {
  const checkedAt = new Date().toISOString();
  const base: LinkReview = {
    link: rawLink,
    repo: null,
    reachable: false,
    httpStatus: null,
    riskFlags: [],
    verdict: "review-manually",
    summary: "",
    nextSteps: [],
    checkedAt,
  };

  const repo = parseRepoUrl(rawLink);
  if (!repo) {
    return { ...base, verdict: "reject", summary: "Not a repository link (expected https://github.com/owner/repo)." };
  }
  // Only the two hosts whose public API this module can read are reviewable.
  // Calling any two-segment path a "repository" would make the verdict look
  // researched when nothing was actually checked.
  if (repo.host === "other") {
    return {
      ...base,
      repo,
      verdict: "reject",
      summary: `Only GitHub and GitLab links can be reviewed; ${repo.url} is neither. Open the page yourself, or share the upstream repository link.`,
    };
  }

  // 1) Is the page even reachable? Goes through the SSRF guard by default; the
  // seam exists so the licence/risk rules can be tested without the network.
  const probe = options.browse ?? browseUrl;
  const page = await probe(repo.url).catch((error) => ({
    ok: false,
    status: null,
    error: `unreachable: ${(error as Error)?.message ?? error}`,
  }));
  const reachable = page.ok || page.status === 200;
  if (!reachable) {
    return {
      ...base,
      repo,
      httpStatus: page.status,
      verdict: "reject",
      summary: `The link does not load (${page.error ?? (page.status ? `HTTP ${page.status}` : "unreachable")}).`,
      error: page.error ?? undefined,
    };
  }

  // 2) Facts + licence from the public API (no auth needed for a public repo).
  let metadata: LinkReview["metadata"];
  let licence: LicenceAssessment | undefined;
  if (repo.host === "github.com") {
    const doFetch = options.fetchJson ?? fetch;
    try {
      const res = await doFetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "ALO-LinkReview/1.0" },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as GitHubRepoResponse;
        metadata = {
          description: data.description ?? null,
          stars: typeof data.stargazers_count === "number" ? data.stargazers_count : null,
          archived: Boolean(data.archived),
          pushedAt: data.pushed_at ?? null,
          sizeKb: typeof data.size === "number" ? data.size : null,
          language: data.language ?? null,
          licenseSpdx: data.license?.spdx_id ?? null,
          licenseName: data.license?.name ?? null,
          topics: Array.isArray(data.topics) ? data.topics.slice(0, 20) : [],
        };
        licence = assessLicence(metadata.licenseSpdx, metadata.licenseName);
      } else {
        base.riskFlags.push(`github_api_http_${res.status}`);
      }
    } catch {
      base.riskFlags.push("github_api_unreachable");
    }
  }

  const riskFlags = [...base.riskFlags];
  if (metadata?.archived) riskFlags.push("repository_archived");
  const staleDays = daysSince(metadata?.pushedAt);
  if (staleDays !== null && staleDays > 730) riskFlags.push(`no_commits_for_${Math.floor(staleDays / 365)}y`);
  if (metadata?.sizeKb !== null && metadata?.sizeKb !== undefined && metadata.sizeKb > 1_500_000) {
    riskFlags.push("very_large_repository");
  }
  if (licence?.copyleft) riskFlags.push("copyleft_obligations");
  if (licence?.custom) riskFlags.push("custom_or_unclassified_licence");
  for (const trap of licence?.knownTraps ?? []) riskFlags.push(`licence_trap:${trap}`);

  // Declared as the full union: an early `reject` above is a different return,
  // so TypeScript would otherwise narrow this to the three remaining verdicts.
  // Kept in an array so the "reject" early return above does not narrow this
  // variable to the three remaining verdicts.
  const decided: LinkVerdict[] = [];
  let verdict: LinkVerdict;
  let summary: string;
  const name = metadata?.description ? `${repo.owner}/${repo.repo} — ${metadata.description}` : `${repo.owner}/${repo.repo}`;

  if (!licence) {
    verdict = "review-manually";
    summary = `${name} loads, but no licence could be read. Adopting code without a licence is a legal risk, not a technical one.`;
  } else if (licence.adoptionRisk === "high") {
    verdict = "review-manually";
    summary = `${name} uses ${licence.name} (${licence.spdx ?? "unclassified"}). This is not a permissive licence — read it before adopting anything.`;
  } else if (metadata?.archived) {
    verdict = "review-manually";
    summary = `${name} is archived; it will not receive security fixes.`;
  } else if (licence.adoptionRisk === "low" && riskFlags.length === 0) {
    verdict = "adopt";
    summary = `${name} is reachable, actively maintained, and ${licence.name}. No licence or activity risk was detected.`;
  } else {
    verdict = "adopt-with-changes";
    summary = `${name} is adoptable with care: ${riskFlags.join(", ") || "minor concerns"}.`;
  }

  decided.push(verdict);
  const nextSteps: string[] = [];
  if (decided[0] !== "reject") {
    nextSteps.push("Read the licence yourself for anything you intend to ship (this check is evidence, not legal advice).");
    nextSteps.push("Pin a commit SHA, not a branch, before using any of its code.");
    nextSteps.push(
      "Do not run its install scripts on the app host; review the diff and let CI build it in a throwaway container."
    );
    nextSteps.push("Open a pull request with the change — never push to main directly, and never auto-deploy.");
    if (licence?.knownTraps.length) {
      nextSteps.push(`Pay special attention to: ${licence.knownTraps.join(", ")}.`);
    }
  } else {
    nextSteps.push("Ask for a link to the source with a clear licence, or for a version you are allowed to use.");
  }

  return {
    link: rawLink,
    repo,
    reachable: true,
    httpStatus: page.status,
    metadata,
    licence,
    riskFlags,
    verdict,
    summary,
    nextSteps,
    checkedAt,
  };
}
