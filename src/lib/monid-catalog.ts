/**
 * Monid catalogue knowledge — the provider/endpoint/pricing facts taken from
 * `monid-ai/monid` (MIT, checked 2026-11-27, 5,683★).
 *
 * Why this file exists: the agent must be able to answer "what can Monid reach,
 * and what does it cost?" **without a network call and without a key**, and it
 * must never state a price it did not read from a source. Every number below
 * carries the file it came from, so it can be re-audited when Monid reprices.
 *
 * ⚠️ These are the vendor "credit" rates declared in the connector definitions
 * (Monid's own pool is US dollars), i.e. what Monid charges for the call — not
 * what the underlying vendor charges Monid. The billed amount is settled by the
 * Monid engine on the raw response, so the live quote comes from `inspect` and
 * the actual charge from the run result. This file is for *estimating before
 * asking*, never for asserting what was charged.
 *
 * Sources (paths inside monid-ai/monid):
 *   connectors/<name>/provider.ts
 *   connectors/<name>/endpoints/<endpoint>/endpoint.ts
 */

export interface MonidEndpointFact {
  /** Endpoint id used by `inspect` / `run` (`-e`). */
  endpoint: string;
  /** What it does, in one line, from the connector's own summary. */
  summary: string;
  /**
   * The declared rate, when one could be read unambiguously.
   * `null` = the connector does not declare a flat price we can quote, so the
   * live quote must come from `inspect` instead of a guess.
   */
  price: {
    /** Base charge per call, USD. */
    baseUsd?: number;
    /** Extra charge per unit above the included allowance, USD. */
    perExtraUsd?: number;
    /** Units included in the base charge (exa: the first 10 results). */
    includedUnits?: number;
    /** Which result field the extra units are counted from. */
    countField?: string;
    note: string;
  } | null;
  /** Vendor doc page, when the connector names one. */
  docsUrl?: string;
}

export interface MonidProviderFact {
  /** Provider id used by `inspect` / `run` (`-p`). */
  provider: string;
  displayName: string;
  summary: string;
  /** How the connector authenticates at Monid's egress (for support answers). */
  auth: "bearer" | "header";
  /** Which job categories the connector advertises. */
  categories: string[];
  endpoints: MonidEndpointFact[];
  homepageUrl?: string;
}

/**
 * The connectors whose pricing could be read unambiguously. 35 connector
 * directories exist in the repo; only these five were verified end to end, and
 * the file says so rather than implying full coverage.
 */
export const MONID_PROVIDERS: MonidProviderFact[] = [
  {
    provider: "exa",
    displayName: "Exa",
    summary: "AI-native web search and content extraction (neural + keyword).",
    auth: "header",
    categories: ["web-search"],
    homepageUrl: "https://exa.ai",
    endpoints: [
      {
        endpoint: "search",
        summary: "Search the web by meaning; base fee covers the first 10 results.",
        price: {
          baseUsd: 0.007,
          perExtraUsd: 0.001,
          includedUnits: 10,
          countField: "results",
          note: "$0.007 base (first 10 results) + $0.001 per extra result; exa's own costDollars receipt wins when present",
        },
        docsUrl: "https://exa.ai/docs/reference/search",
      },
      { endpoint: "contents", summary: "Fetch page contents for known URLs.", price: null },
    ],
  },
  {
    provider: "firecrawl",
    displayName: "Firecrawl",
    summary: "Scrape, crawl, map and batch-scrape sites into clean text.",
    auth: "bearer",
    categories: ["web-scraping"],
    endpoints: [
      { endpoint: "scrape", summary: "Scrape one URL into markdown/text.", price: null },
      { endpoint: "crawl", summary: "Crawl a whole site (async, status endpoint).", price: null },
      { endpoint: "crawl-status", summary: "Poll a crawl started earlier.", price: null },
      { endpoint: "map", summary: "List a site's URLs quickly.", price: null },
      { endpoint: "batch-scrape", summary: "Scrape many URLs in one call (async).", price: null },
      { endpoint: "batch-scrape-status", summary: "Poll a batch scrape.", price: null },
      { endpoint: "search", summary: "Search plus scrape the results.", price: null },
      { endpoint: "agent", summary: "Agent-driven extraction across pages.", price: null },
    ],
  },
  {
    provider: "apollo",
    displayName: "Apollo",
    summary: "People and company enrichment, job postings and news.",
    auth: "bearer",
    categories: ["enrichment", "people", "company"],
    endpoints: [
      { endpoint: "people-match", summary: "Match a person from partial details.", price: null },
      { endpoint: "people-show", summary: "Read one person record.", price: null },
      { endpoint: "organizations-enrich", summary: "Enrich a company domain.", price: null },
      { endpoint: "organizations-show", summary: "Read one company record.", price: null },
      { endpoint: "mixed-companies-search", summary: "Search companies.", price: null },
      { endpoint: "mixed-people-api-search", summary: "Search people.", price: null },
      { endpoint: "organizations-job-postings", summary: "List a company's job postings.", price: null },
      { endpoint: "news-articles-search", summary: "Search news articles.", price: null },
    ],
  },
  {
    provider: "ahrefs",
    displayName: "Ahrefs",
    summary: "SEO: backlinks, keyword explorer, SERP overview, site explorer.",
    auth: "bearer",
    categories: ["seo"],
    endpoints: [
      { endpoint: "keywords-explorer", summary: "Keyword ideas and volume.", price: null },
      { endpoint: "serp-overview", summary: "Who ranks for a query.", price: null },
      { endpoint: "site-explorer", summary: "A site's organic footprint.", price: null },
      { endpoint: "batch-analysis", summary: "Several SEO reports in one call.", price: null },
    ],
  },
  {
    provider: "hunterio",
    displayName: "Hunter.io",
    summary: "Find and verify professional email addresses.",
    auth: "bearer",
    categories: ["email", "enrichment"],
    endpoints: [
      { endpoint: "domain-search", summary: "Emails published by a domain.", price: null },
      { endpoint: "email-finder", summary: "Derive one person's email.", price: null },
      { endpoint: "email-verifier", summary: "Check deliverability of an address.", price: null },
      { endpoint: "email-count", summary: "How many emails a domain has.", price: null },
      { endpoint: "companies-find", summary: "Find a company.", price: null },
      { endpoint: "people-find", summary: "Find a person.", price: null },
      { endpoint: "combined-find", summary: "Company + person in one call.", price: null },
      { endpoint: "discover", summary: "Discover related targets.", price: null },
      { endpoint: "discover-ai", summary: "AI-assisted discovery.", price: null },
      { endpoint: "discover-people", summary: "Discover people.", price: null },
      { endpoint: "domain-finder", summary: "Find a company's domain.", price: null },
      { endpoint: "multi-domain-search", summary: "Search several domains.", price: null },
      { endpoint: "multi-domain-search-reveal", summary: "Reveal a multi-domain search.", price: null },
    ],
  },
];

/** How many connector directories the upstream repo actually has (2026-11-27). */
export const MONID_CONNECTOR_DIRECTORIES = 35;

export function findProvider(provider: string): MonidProviderFact | undefined {
  const needle = provider.trim().toLowerCase();
  return MONID_PROVIDERS.find((p) => p.provider === needle || p.displayName.toLowerCase() === needle);
}

export function findEndpoint(provider: string, endpoint: string): MonidEndpointFact | undefined {
  return findProvider(provider)?.endpoints.find((e) => e.endpoint === endpoint.trim().toLowerCase());
}

export interface PriceEstimate {
  /** Best estimate before the call, in USD; null when the model is unreadable. */
  usd: number | null;
  /** The exact sentence to show the owner; never rounded silently. */
  text: string;
  /** True when the number came from a declared flat rate, not a guess. */
  fromDeclaredRate: boolean;
}

/**
 * Estimate a call's cost from the declared rates + the input that will be sent.
 *
 * Only exa's base-plus-overage model is computable offline (it needs
 * `numResults`). For anything else the honest answer is "ask `inspect`", which
 * is exactly what the text says. A wrong cheap number is worse than no number:
 * the owner approves spending real balance on it.
 */
export function estimateCallCost(provider: string, endpoint: string, input?: Record<string, unknown>): PriceEstimate {
  const fact = findEndpoint(provider, endpoint);
  if (!fact) {
    return {
      usd: null,
      fromDeclaredRate: false,
      text: `No local price fact for ${provider}#${endpoint} — run inspect to get the live quote before approving.`,
    };
  }
  if (!fact.price) {
    return {
      usd: null,
      fromDeclaredRate: false,
      text: `${provider}#${endpoint} does not declare a flat rate here — run inspect for the live quote.`,
    };
  }

  const base = fact.price.baseUsd;
  const perExtra = fact.price.perExtraUsd;
  const included = fact.price.includedUnits;

  if (base === undefined) {
    return { usd: null, fromDeclaredRate: false, text: `${fact.price.note} — run inspect for the live quote.` };
  }

  if (perExtra !== undefined && included !== undefined) {
    // Count the surplus the request will ask for. exa's request defaults to 10
    // results, so the request's own numResults is the only signal we have; the
    // response count is what actually bills, hence the caveat in the text.
    const body = (input?.body ?? {}) as Record<string, unknown>;
    const requested = Number(body.numResults ?? included);
    const units = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : included;
    const extra = Math.max(0, units - included);
    const usd = Number((base + extra * perExtra).toFixed(4));
    return {
      usd,
      fromDeclaredRate: true,
      text: `≈$${usd.toFixed(4)} — $${base} base (${included} included)${extra ? ` + ${extra} × $${perExtra} extra` : ""}; the final charge comes from the run result.`,
    };
  }

  return {
    usd: base,
    fromDeclaredRate: true,
    text: `$${base} per call (declared rate) — the final charge comes from the run result.`,
  };
}

/** Answer "what can Monid do for us?" from the facts, with no network call. */
export function catalogueReport(): string {
  const providerCount = MONID_PROVIDERS.length;
  const endpointCount = MONID_PROVIDERS.reduce((n, p) => n + p.endpoints.length, 0);
  const lines = [
    `Monid: ${providerCount} providers verified here (the repo has ${MONID_CONNECTOR_DIRECTORIES} connector directories, 2,000+ endpoints across 72+ providers upstream).`,
    "discover and inspect are free; run is billed per call and always needs owner approval.",
    "",
    "| provider | endpoints | categories | auth at Monid egress |",
    "| --- | --- | --- | --- |",
    ...MONID_PROVIDERS.map(
      (p) => `| ${p.displayName} | ${p.endpoints.length} | ${p.categories.join(", ")} | ${p.auth} |`,
    ),
    "",
    `Verified endpoint facts: ${endpointCount}. Anything not listed is reachable but unpriced here — inspect it first.`,
  ];
  return lines.join("\n");
}
