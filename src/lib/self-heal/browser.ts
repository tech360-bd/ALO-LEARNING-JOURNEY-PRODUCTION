// ALO Learning Journey — Safe web browser for self-healing (server-only).
//
// Browses public URLs to detect errors (HTTP failures, broken links,
// missing titles, error pages). Safety:
//  - SSRF protection via src/lib/ssrf.ts (private IPs, metadata endpoints).
//  - Timeout + response size cap + redirect cap.
//  - Read-only: never submits forms, never logs in, never sends credentials.
//  - Only http(s) public URLs. Same-origin app pages are fetched via the
//    public site URL, never via localhost (avoids SSRF + auth bypass).

import { fetchSafePublicUrl, isUrlSafe } from "@/lib/ssrf";

export interface BrowseResult {
  url: string;
  ok: boolean;
  status: number | null;
  title: string | null;
  links: string[];
  brokenLinks: string[];
  error: string | null;
  latencyMs: number;
  truncated: boolean;
}

const MAX_BYTES = 200_000;
const MAX_LINKS = 100;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g, " ").slice(0, 200) : null;
}

function extractLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < MAX_LINKS) {
    const href = m[1].trim();
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    try {
      const u = new URL(href, base);
      if (u.protocol === "http:" || u.protocol === "https:") out.push(u.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...new Set(out)];
}

function looksLikeErrorPage(html: string, status: number): string | null {
  if (status >= 400) return `HTTP ${status}`;
  const lower = html.slice(0, 8000).toLowerCase();
  if (lower.includes("something went wrong") || lower.includes("internal server error")) {
    return "error page text detected";
  }
  return null;
}

/** Fetch one public URL and extract error signals. Never throws. */
export async function browseUrl(rawUrl: string): Promise<BrowseResult> {
  const start = Date.now();
  const base: BrowseResult = {
    url: rawUrl,
    ok: false,
    status: null,
    title: null,
    links: [],
    brokenLinks: [],
    error: null,
    latencyMs: 0,
    truncated: false,
  };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ...base, error: "invalid URL", latencyMs: Date.now() - start };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ...base, error: `scheme ${url.protocol} not allowed`, latencyMs: Date.now() - start };
  }

  const safety = await isUrlSafe(url.toString());
  if (!safety.allowed) {
    return { ...base, error: `blocked by SSRF guard: ${safety.reason ?? "unsafe URL"}`, latencyMs: Date.now() - start };
  }

  let current = url.toString();
  let status: number | null = null;
  let html = "";
  try {
    const res = await fetchSafePublicUrl(current, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      timeoutMs: TIMEOUT_MS,
      maxBytes: 2_000_000,
      maxRedirects: MAX_REDIRECTS,
      headers: { "user-agent": "ALO-SelfHeal-Browser/1.0 (read-only error detection)" },
    });
    current = res.url;
    status = res.status;
    const text = Buffer.from(res.body).toString("utf8");
    html = text.slice(0, MAX_BYTES);
    if (text.length > MAX_BYTES) base.truncated = true;
  } catch (err) {
    return {
      ...base,
      status,
      error: err instanceof Error ? err.message.slice(0, 300) : "fetch failed",
      latencyMs: Date.now() - start,
    };
  }

  const links = extractLinks(html, current);
  const pageError = looksLikeErrorPage(html, status ?? 0);
  return {
    ...base,
    ok: status !== null && status < 400 && !pageError,
    status,
    title: extractTitle(html),
    links,
    brokenLinks: [],
    error: pageError,
    latencyMs: Date.now() - start,
  };
}

/** HEAD-check a list of links for broken targets (sequential, capped, SSRF-safe redirects). */
export async function checkLinks(links: string[], limit = 20): Promise<string[]> {
  const broken: string[] = [];
  for (const link of links.slice(0, limit)) {
    const safety = await isUrlSafe(link);
    if (!safety.allowed) continue;
    try {
      const res = await fetchSafePublicUrl(link, {
        method: "HEAD",
        maxRedirects: MAX_REDIRECTS,
        maxBytes: 0,
        timeoutMs: 8_000,
        headers: { "user-agent": "ALO-SelfHeal-Browser/1.0" },
      });
      if (res.status >= 400) broken.push(`${link} → HTTP ${res.status}`);
    } catch (err) {
      broken.push(`${link} → ${err instanceof Error ? err.message.slice(0, 120) : "fetch failed"}`);
    }
  }
  return broken;
}

export interface SiteScan {
  baseUrl: string;
  pages: BrowseResult[];
  brokenLinks: string[];
  scannedAt: string;
}

/** Scan a small set of public pages (sequential, capped). */
export async function scanSite(baseUrl: string, paths: string[] = ["/", "/login", "/contact"]): Promise<SiteScan> {
  const pages: BrowseResult[] = [];
  const brokenLinks: string[] = [];
  const base = baseUrl.replace(/\/+$/, "");
  for (const p of paths.slice(0, 8)) {
    const result = await browseUrl(`${base}${p.startsWith("/") ? p : `/${p}`}`);
    pages.push(result);
    if (result.links.length) {
      const broken = await checkLinks(result.links, 10);
      brokenLinks.push(...broken.map((b) => `${p}: ${b}`));
    }
  }
  return { baseUrl, pages, brokenLinks: brokenLinks.slice(0, 30), scannedAt: new Date().toISOString() };
}
