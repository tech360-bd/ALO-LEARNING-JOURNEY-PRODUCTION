/**
 * Local-first web search and page extraction — the $0 replacement for paid
 * Exa / Monid `run`.
 *
 * ── Design rule ───────────────────────────────────────────────────────────
 * Nothing in this module can spend money. Every backend is something the owner
 * runs on their own box (SearXNG, Wigolo, Crawl4AI) or code in this repository
 * (the native extractor). There is no API key, no quota, no vendor in the
 * request path — so "search the web" works the same at 3am with the network
 * flapping as it does at noon.
 *
 * ── Backend order (first working backend wins) ────────────────────────────
 *   SEARCH   1. SearXNG   `SEARXNG_BASE_URL`   (default http://127.0.0.1:8080)
 *            2. Wigolo    `WIGOLO_BASE_URL`    (default http://127.0.0.1:3847)
 *            3. DuckDuckGo HTML (keyless, last resort — see the note below)
 *   EXTRACT  1. Crawl4AI  `CRAWL4AI_BASE_URL`  (default http://127.0.0.1:11235)
 *            2. native extractor (always available, no service needed)
 *
 * A backend that is down is reported as `skipped`, never as an error that hides
 * the working fallback. The response always says which backend actually served
 * it, so the owner can see whether their SearXNG is being used or whether the
 * box quietly fell all the way through.
 *
 * ── Why DuckDuckGo last, not first ────────────────────────────────────────
 * The HTML endpoint is unauthenticated and can rate-limit or change its markup
 * at any time. It is a genuine "network is up but my services are down" bridge,
 * so it is last and its result is labelled `ddg-html` — an operator can tell at
 * a glance that the first two backends were unavailable.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * The native extractor goes through `isUrlSafe()` (the repo's SSRF guard), so a
 * request for `http://169.254.169.254/` or an internal host is refused instead
 * of being fetched. Extracted text is capped and HTML is stripped before it can
 * reach a model or a database.
 */

import { isUrlSafe } from "@/lib/ssrf";
import { runtimeEnvSync } from "@/lib/runtime-config";

export type SearchBackend = "searxng" | "wigolo" | "ddg-html" | "none";
export type ExtractBackend = "crawl4ai" | "native" | "none";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  ok: boolean;
  query: string;
  backend: SearchBackend;
  results: WebSearchResult[];
  /** Backends that were tried and could not serve, in the order tried. */
  skipped: Array<{ backend: Exclude<SearchBackend, "none">; reason: string }>;
  ms: number;
  /** True when a paid backend was needed — always false in this module. */
  paidUsed: false;
}

export interface PageExtraction {
  ok: boolean;
  url: string;
  backend: ExtractBackend;
  title: string | null;
  /** Plain text (markdown-ish) of the page body, capped. */
  text: string;
  chars: number;
  truncated: boolean;
  skipped: Array<{ backend: Exclude<ExtractBackend, "none">; reason: string }>;
  ms: number;
  paidUsed: false;
}

const SEARCH_TIMEOUT_MS = 8_000;
const EXTRACT_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 60_000;
const MAX_RESULTS = 20;

function env(name: string, fallback: string): string {
  const direct = process.env[name];
  if (typeof direct === "string" && direct.length > 0) return direct.replace(/\/+$/, "");
  try {
    const value = runtimeEnvSync(name);
    if (value) return value.replace(/\/+$/, "");
  } catch {
    // Dashboard config unavailable — the documented default is the right answer.
  }
  return fallback.replace(/\/+$/, "");
}

/** Where each backend lives, as the operator configured it. */
export function localBackends() {
  return {
    searxng: env("SEARXNG_BASE_URL", "http://127.0.0.1:8080"),
    wigolo: env("WIGOLO_BASE_URL", "http://127.0.0.1:3847"),
    crawl4ai: env("CRAWL4AI_BASE_URL", "http://127.0.0.1:11235"),
    /** Opt-in: the third backend is off unless the owner wants it. */
    ddgFallback: env("LOCAL_SEARCH_DDG_FALLBACK", "false") === "true",
  };
}

/** The most useful sentence an operator can get out of a fetch failure. */
function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string }; name?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
  const code = e?.cause?.code ?? e?.cause?.message;
  if (code) return `${e?.message ?? "fetch failed"} (${code})`;
  return e?.message ?? "unreachable";
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return stripTags(text);
}

/**
 * HTML → readable text, with no network involved.
 *
 * Exported because it is the part that must work when *nothing* else does: if
 * Crawl4AI is down and the page is already in hand (cached, uploaded, or fetched
 * by another module), this is the whole extractor. It is also the only part that
 * can be unit-tested hermetically.
 */
export function htmlToText(html: string, opts: { maxChars?: number } = {}): {
  title: string | null;
  text: string;
  truncated: boolean;
} {
  const maxChars = Math.max(1, Math.min(MAX_TEXT_CHARS, opts.maxChars ?? MAX_TEXT_CHARS));
  const raw = String(html ?? "");
  const title = raw.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i)?.[1]?.trim() ?? null;
  const body = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? raw;
  const text = stripTags(body);
  return {
    title: title ? decodeEntities(title) : null,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Search backends ────────────────────────────────────────────────────────

async function searchSearxng(query: string, limit: number): Promise<WebSearchResult[]> {
  const base = localBackends().searxng;
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const data = (await fetchJson(url, { headers: { accept: "application/json" } }, SEARCH_TIMEOUT_MS)) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .slice(0, limit)
    .map((r) => ({
      title: decodeEntities(String(r.title ?? r.url)).slice(0, 300),
      url: String(r.url),
      snippet: decodeEntities(String(r.content ?? "")).slice(0, 500),
    }));
}

async function searchWigolo(query: string, limit: number): Promise<WebSearchResult[]> {
  const base = localBackends().wigolo;
  // Wigolo exposes a small REST surface; both shapes are accepted so a version
  // difference reports results instead of a parse error.
  const data = (await fetchJson(
    `${base}/search`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, limit }),
    },
    SEARCH_TIMEOUT_MS,
  )) as { results?: Array<{ title?: string; url?: string; snippet?: string; content?: string }> };

  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .slice(0, limit)
    .map((r) => ({
      title: decodeEntities(String(r.title ?? r.url)).slice(0, 300),
      url: String(r.url),
      snippet: decodeEntities(String(r.snippet ?? r.content ?? "")).slice(0, 500),
    }));
}

async function searchDuckDuckGo(query: string, limit: number): Promise<WebSearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; ALO-Learning-Journey/1.0)" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out: WebSearchResult[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,600}?class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    // DDG wraps links in /l/?uddg=<encoded>; unwrap so the URL is the real one.
    let href = m[1];
    const wrapped = href.match(/[?&]uddg=([^&]+)/);
    if (wrapped) {
      try {
        href = decodeURIComponent(wrapped[1]);
      } catch {
        /* keep the wrapped form */
      }
    }
    if (!/^https?:\/\//.test(href)) continue;
    out.push({
      title: decodeEntities(m[2]).slice(0, 300),
      url: href,
      snippet: decodeEntities(m[3]).slice(0, 500),
    });
  }
  return out;
}

/**
 * Search the web locally. Never throws: an unreachable backend is recorded in
 * `skipped` and the next one is tried; if every backend fails the response is
 * `ok:false` with the reasons, which is more useful than a thrown error.
 */
export async function localWebSearch(rawQuery: string, opts: { limit?: number } = {}): Promise<WebSearchResponse> {
  const started = Date.now();
  const query = String(rawQuery ?? "").trim().slice(0, 400);
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(opts.limit ?? 10)));
  const skipped: WebSearchResponse["skipped"] = [];

  if (query.length < 2) {
    return { ok: false, query, backend: "none", results: [], skipped: [{ backend: "searxng", reason: "query too short" }], ms: 0, paidUsed: false };
  }

  const chain: Array<[Exclude<SearchBackend, "none" | "ddg-html">, (q: string, l: number) => Promise<WebSearchResult[]>]> = [
    ["searxng", searchSearxng],
    ["wigolo", searchWigolo],
  ];

  for (const [name, fn] of chain) {
    try {
      const results = await fn(query, limit);
      if (results.length > 0) {
        return { ok: true, query, backend: name, results, skipped, ms: Date.now() - started, paidUsed: false };
      }
      skipped.push({ backend: name, reason: "reachable but returned no results" });
    } catch (err) {
      skipped.push({ backend: name, reason: describeFetchError(err) });
    }
  }

  if (localBackends().ddgFallback) {
    try {
      const results = await searchDuckDuckGo(query, limit);
      if (results.length > 0) {
        return { ok: true, query, backend: "ddg-html", results, skipped, ms: Date.now() - started, paidUsed: false };
      }
      skipped.push({ backend: "ddg-html", reason: "reachable but returned no results" });
    } catch (err) {
      skipped.push({ backend: "ddg-html", reason: describeFetchError(err) });
    }
  } else {
    skipped.push({ backend: "ddg-html", reason: "disabled (set LOCAL_SEARCH_DDG_FALLBACK=true to allow)" });
  }

  return { ok: false, query, backend: "none", results: [], skipped, ms: Date.now() - started, paidUsed: false };
}

// ─── Extraction backends ────────────────────────────────────────────────────

/** Crawl4AI: POST /crawl {urls:[…]} → markdown per url. */
async function extractCrawl4ai(url: string): Promise<{ title: string | null; text: string }> {
  const base = localBackends().crawl4ai;
  const data = (await fetchJson(
    `${base}/crawl`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ urls: [url] }),
    },
    EXTRACT_TIMEOUT_MS,
  )) as {
    results?: Array<{ markdown?: string | { raw_markdown?: string }; metadata?: { title?: string }; title?: string }>;
    markdown?: string;
  };

  const first = Array.isArray(data?.results) ? data.results[0] : undefined;
  const md =
    (typeof first?.markdown === "string" && first.markdown) ||
    (typeof first?.markdown === "object" && first.markdown?.raw_markdown) ||
    (typeof data?.markdown === "string" && data.markdown) ||
    "";
  if (!md.trim()) throw new Error("crawl4ai returned no markdown");
  return { title: first?.metadata?.title ?? first?.title ?? null, text: String(md) };
}

/**
 * The native extractor: fetch the page (SSRF-guarded) and turn it into text.
 * Always available, so a scrape never depends on Python or Docker running.
 */
async function extractNative(url: string, maxChars: number): Promise<{ title: string | null; text: string; truncated: boolean }> {
  const safe = await isUrlSafe(url);
  if (!safe.allowed) {
    throw new Error(`refused by SSRF guard: ${safe.reason ?? "unsafe host"}`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ALO-Learning-Journey/1.0; +local-first)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(describeFetchError(err));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/|html|xml|json/.test(type)) throw new Error(`unsupported content-type: ${type.slice(0, 60)}`);

  // Read at most 2 MB: a huge page must not exhaust memory on a 1-box deploy.
  const buf = Buffer.from(await res.arrayBuffer());
  const slice = buf.subarray(0, 2_000_000).toString("utf8");
  const converted = htmlToText(slice, { maxChars });
  return { ...converted, truncated: converted.truncated || buf.length >= 2_000_000 };
}

/**
 * Extract one page as text. Crawl4AI first (it renders JS when configured to),
 * native extractor second — so the feature works on a bare server.
 */
export async function extractPage(rawUrl: string, opts: { maxChars?: number } = {}): Promise<PageExtraction> {
  const started = Date.now();
  const maxChars = Math.max(500, Math.min(MAX_TEXT_CHARS, opts.maxChars ?? MAX_TEXT_CHARS));
  const skipped: PageExtraction["skipped"] = [];
  let url = String(rawUrl ?? "").trim();

  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, url, backend: "none", title: null, text: "", chars: 0, truncated: false, skipped: [{ backend: "native", reason: "only http(s) URLs are extracted" }], ms: 0, paidUsed: false };
  }
  // A bare host like "example.com" is normalised, so a paste from chat works.
  if (!url.includes("://")) url = `https://${url}`;

  // ── SSRF check BEFORE any backend sees the URL ──────────────────────────
  // This must not live inside the native extractor: a Crawl4AI service on the
  // owner's own box would otherwise fetch `http://169.254.169.254/…` (cloud
  // metadata) and hand the credentials back to us, with our blessing. One
  // check, in front of every backend, and the native extractor keeps its own
  // check as defence in depth.
  const safe = await isUrlSafe(url);
  if (!safe.allowed) {
    const reason = `refused by SSRF guard: ${safe.reason ?? "unsafe host"}`;
    return {
      ok: false,
      url,
      backend: "none",
      title: null,
      text: "",
      chars: 0,
      truncated: false,
      skipped: [
        { backend: "crawl4ai", reason },
        { backend: "native", reason },
      ],
      ms: Date.now() - started,
      paidUsed: false,
    };
  }

  try {
    const result = await extractCrawl4ai(url);
    const text = result.text.slice(0, maxChars);
    return {
      ok: true,
      url,
      backend: "crawl4ai",
      title: result.title,
      text,
      chars: text.length,
      truncated: result.text.length > maxChars,
      skipped,
      ms: Date.now() - started,
      paidUsed: false,
    };
  } catch (err) {
    skipped.push({ backend: "crawl4ai", reason: describeFetchError(err) });
  }

  try {
    const result = await extractNative(url, maxChars);
    return {
      ok: true,
      url,
      backend: "native",
      title: result.title,
      text: result.text,
      chars: result.text.length,
      truncated: result.truncated,
      skipped,
      ms: Date.now() - started,
      paidUsed: false,
    };
  } catch (err) {
    skipped.push({ backend: "native", reason: err instanceof Error ? err.message : "fetch failed" });
  }

  return { ok: false, url, backend: "none", title: null, text: "", chars: 0, truncated: false, skipped, ms: Date.now() - started, paidUsed: false };
}

/** What the dashboard shows about the local search stack. Never a network call. */
export function localSearchStatus() {
  const backends = localBackends();
  return {
    backends,
    order: { search: ["searxng", "wigolo", ...(backends.ddgFallback ? ["ddg-html"] : [])], extract: ["crawl4ai", "native"] },
    paidBackends: [],
    usdPerCall: 0,
    note: "All backends are self-hosted or in-repo; the native extractor is always available, so search/extraction never depends on a paid API.",
  };
}
