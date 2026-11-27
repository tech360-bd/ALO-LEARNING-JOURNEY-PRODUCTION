import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";

// Local-first web search / extraction — and the $0 guarantee.
//
// Every backend is a REAL local HTTP server speaking the documented protocol
// (SearXNG `?format=json`, Wigolo `POST /search`, Crawl4AI `POST /crawl`), so
// these tests exercise the actual fetch/parse path rather than a mock of it.
// The last test is the one the policy cares about: no configuration of this
// module may ever contact a paid API.

const hits = [];
const servers = [];

function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}`);
      handler(req, res, raw);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

after(() => servers.forEach((s) => s.close()));

// ── Backends ────────────────────────────────────────────────────────────────
const searxng = await serve((req, res) => {
  const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
  if (q === "empty") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ results: [] }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      results: [
        { title: "ALO <b>Learning</b> Journey", url: "https://learn.alolabs.net/", content: "Free &amp; open classes" },
        { title: "Second", url: "https://example.org/b", content: "snippet b" },
      ],
    }),
  );
});

const wigolo = await serve((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ results: [{ title: "Wigolo hit", url: "https://wigolo.example/1", snippet: "from wigolo" }] }));
});

const crawl4ai = await serve((req, res) => {
  if (req.url !== "/crawl") {
    res.writeHead(404);
    return res.end("{}");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      results: [
        {
          markdown: "# Page\n\nLocal extraction works. " + "more text ".repeat(200),
          metadata: { title: "Crawl title" },
        },
      ],
    }),
  );
});

// A page for the NATIVE extractor (no Crawl4AI available).
const page = await serve((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    "<html><head><title>Native title</title><style>.x{}</style></head><body><script>bad()</script><h1>Hello</h1><p>Bangla: বাংলা লেখা</p></body></html>",
  );
});

// ── Import once the servers exist ───────────────────────────────────────────
process.env.SEARXNG_BASE_URL = searxng;
process.env.WIGOLO_BASE_URL = wigolo;
process.env.CRAWL4AI_BASE_URL = crawl4ai;
process.env.LOCAL_SEARCH_DDG_FALLBACK = "false";
const web = await import("../src/lib/local-web-search.ts");

const ENV_KEYS = ["SEARXNG_BASE_URL", "WIGOLO_BASE_URL", "CRAWL4AI_BASE_URL", "LOCAL_SEARCH_DDG_FALLBACK"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  hits.length = 0;
  process.env.SEARXNG_BASE_URL = searxng;
  process.env.WIGOLO_BASE_URL = wigolo;
  process.env.CRAWL4AI_BASE_URL = crawl4ai;
  process.env.LOCAL_SEARCH_DDG_FALLBACK = "false";
});

test("SearXNG results are parsed, entities decoded and nothing is paid", async () => {
  const result = await web.localWebSearch("bangla classes", { limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.backend, "searxng");
  assert.equal(result.paidUsed, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].title, "ALO Learning Journey", "markup must be stripped from a title");
  assert.equal(result.results[0].snippet, "Free & open classes", "HTML entities must be decoded");
  assert.match(hits[0], /^GET \/search\?q=bangla/);
  assert.match(hits[0], /format=json/, "the JSON format is required — HTML scraping is not used for SearXNG");
});

test("limit and query length are bounded before the backend is called", async () => {
  const many = await web.localWebSearch("bangla classes", { limit: 9999 });
  assert.ok(many.results.length <= 20, "limit is capped at 20");

  hits.length = 0;
  const tooShort = await web.localWebSearch("a");
  assert.equal(tooShort.ok, false);
  assert.equal(hits.length, 0, "a 1-character query must not reach a backend");
});

test("SearXNG down → Wigolo serves, and the fallback is recorded", async () => {
  process.env.SEARXNG_BASE_URL = "http://127.0.0.1:45999"; // nothing listens here
  const result = await web.localWebSearch("anything");
  assert.equal(result.ok, true);
  assert.equal(result.backend, "wigolo");
  assert.equal(result.paidUsed, false);
  assert.equal(result.skipped[0].backend, "searxng");
  assert.match(result.skipped[0].reason, /ECONNREFUSED|unreachable|HTTP/i);
  assert.equal(result.results[0].url, "https://wigolo.example/1");
});

test("an empty-but-reachable backend falls through instead of reporting success", async () => {
  const result = await web.localWebSearch("empty");
  assert.equal(result.ok, true, "wigolo still answers");
  assert.equal(result.backend, "wigolo");
  assert.equal(result.skipped[0].reason, "reachable but returned no results");
});

test("every backend down → honest ok:false with reasons, no throw", async () => {
  process.env.SEARXNG_BASE_URL = "http://127.0.0.1:45999";
  process.env.WIGOLO_BASE_URL = "http://127.0.0.1:45999";
  const result = await web.localWebSearch("bangla classes");
  assert.equal(result.ok, false);
  assert.equal(result.backend, "none");
  assert.equal(result.results.length, 0);
  assert.equal(result.skipped.length, 3, "two dead backends + the disabled DDG fallback");
  assert.match(result.skipped[2].reason, /disabled/);
  assert.equal(result.paidUsed, false);
});

test("the DuckDuckGo bridge stays OFF unless explicitly enabled", async () => {
  process.env.SEARXNG_BASE_URL = "http://127.0.0.1:45999";
  process.env.WIGOLO_BASE_URL = "http://127.0.0.1:45999";
  const result = await web.localWebSearch("bangla classes");
  assert.equal(result.ok, false);
  assert.ok(result.skipped.every((s) => s.backend !== "ddg-html" || /disabled/.test(s.reason)));
  // Nothing in this run touched the public internet.
  assert.deepEqual(hits.filter((h) => !h.includes("127.0.0.1")), []);
});

test("Crawl4AI serves extraction when it is running", async () => {
  const result = await web.extractPage("https://learn.alolabs.net/some-page");
  assert.equal(result.ok, true);
  assert.equal(result.backend, "crawl4ai");
  assert.equal(result.title, "Crawl title");
  assert.match(result.text, /Local extraction works/);
  assert.equal(result.paidUsed, false);
  assert.match(hits[0], /^POST \/crawl/);
});

test("the SSRF guard runs BEFORE any backend: an unsafe URL is never handed to a service", async () => {
  // This is the bug the guard exists for: a Crawl4AI service on the owner's own
  // box would happily fetch cloud-metadata and hand the credentials back.
  hits.length = 0;
  const result = await web.extractPage(page); // a loopback page = must be refused
  assert.equal(result.ok, false);
  assert.equal(result.backend, "none");
  assert.deepEqual(result.skipped.map((s) => s.backend), ["crawl4ai", "native"]);
  for (const entry of result.skipped) assert.match(entry.reason, /SSRF guard/);
  assert.deepEqual(hits, [], "no backend may be contacted for an unsafe URL");
  assert.equal(result.paidUsed, false);
});

test("a dead Crawl4AI never claims it served — the native extractor is the only fallback", async () => {
  // Pointing Crawl4AI at a closed port makes the outcome network-independent:
  // whatever else happens, a successful extraction can ONLY have come from the
  // in-repo native extractor. (Whether example.com is reachable differs between
  // CI and a sandbox, so that is not asserted.)
  process.env.CRAWL4AI_BASE_URL = "http://127.0.0.1:45999";
  const result = await web.extractPage("https://example.com/");

  assert.notEqual(result.backend, "crawl4ai", "a closed port cannot have served the page");
  assert.equal(result.paidUsed, false);
  if (result.ok) {
    assert.equal(result.backend, "native", "the native extractor is the only other backend");
  } else {
    assert.equal(result.backend, "none");
    assert.ok(
      result.skipped.some((entry) => entry.backend === "crawl4ai"),
      `the failed backend must be recorded: ${JSON.stringify(result.skipped)}`,
    );
  }
});

// The built-in converter is the fallback that needs no service, no key and no
// network — it is the part that has to keep working when everything else is
// offline, so it is tested directly on real markup.
test("the built-in HTML→text converter works with no service at all", () => {
  const src = fs.readFileSync(new URL("../src/lib/local-web-search.ts", import.meta.url), "utf8");
  assert.match(src, /export function htmlToText/, "the converter must be exported to be the documented fallback");

  const converted = web.htmlToText(
    "<html><head><title>ALO &amp; Bangla</title><style>.x{}</style></head>" +
      "<body><script>bad()</script><h1>Hello</h1><p>বাংলা লেখা</p><noscript>no js</noscript></body></html>",
  );
  assert.equal(converted.title, "ALO & Bangla");
  assert.match(converted.text, /Hello/);
  assert.match(converted.text, /বাংলা লেখা/, "UTF-8 Bangla must survive");
  assert.doesNotMatch(converted.text, /bad\(\)/, "scripts must be stripped");
  assert.doesNotMatch(converted.text, /\.x\{\}/, "styles must be stripped");
  assert.doesNotMatch(converted.text, /no js/, "noscript content must be stripped");
  assert.equal(converted.truncated, false);
});

test("the native extractor refuses cloud-metadata and private hosts", async () => {
  for (const unsafe of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://10.0.0.5/internal",
    "http://localhost:3061/api/health",
  ]) {
    const result = await web.extractPage(unsafe);
    assert.equal(result.ok, false, unsafe);
    assert.equal(result.text, "", unsafe);
    // EVERY backend must have been refused, including Crawl4AI: the guard runs
    // before a URL is handed to any service, not inside one of them.
    assert.equal(result.skipped.length, 2, `${unsafe} → ${JSON.stringify(result.skipped)}`);
    for (const entry of result.skipped) {
      assert.match(entry.reason, /SSRF/i, `${unsafe} via ${entry.backend}: ${entry.reason}`);
    }
  }
});

test("non-http schemes are refused before any fetch", async () => {
  hits.length = 0;
  const result = await web.extractPage("file:///etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(hits.length, 0);
  assert.match(result.skipped[0].reason, /only http\(s\)/);
});

test("text is capped so one huge page cannot flood a model", async () => {
  const capped = web.htmlToText("<body>" + "word ".repeat(500) + "</body>", { maxChars: 10 });
  assert.ok(capped.text.length <= 10, `chars=${capped.text.length}`);
  assert.equal(capped.truncated, true);

  // Crawl4AI's own output is capped too, before it can reach a model.
  const result = await web.extractPage("https://learn.alolabs.net/capped", { maxChars: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.backend, "crawl4ai");
  assert.ok(result.chars <= 500, `chars=${result.chars}`);
  assert.equal(result.truncated, true, "the stub page is longer than the cap");
});

test("THE $0 GUARANTEE: no backend is paid and no vendor host is contacted", async () => {
  const status = web.localSearchStatus();
  assert.deepEqual(status.paidBackends, []);
  assert.equal(status.usdPerCall, 0);
  // Every configured backend is loopback (the owner's own services).
  for (const url of [status.backends.searxng, status.backends.wigolo, status.backends.crawl4ai]) {
    const host = new URL(url).hostname;
    assert.ok(["127.0.0.1", "localhost", "::1"].includes(host) || url.startsWith("http://127."), `${url} is not loopback`);
  }

  // The module's source must not contain a paid vendor host at all.
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/lib/local-web-search.ts", import.meta.url), "utf8"));
  for (const vendor of ["api.monid.ai", "api.exa.ai", "api.firecrawl.dev", "api.apollo.io", "api.ahrefs.com", "api.hunter.io", "openai.com/v1", "api.groq.com"]) {
    assert.equal(src.includes(vendor), false, `local-web-search must never reference ${vendor}`);
  }
  // And every response carries paidUsed:false.
  const search = await web.localWebSearch("bangla classes");
  const extract = await web.extractPage(page);
  assert.equal(search.paidUsed, false);
  assert.equal(extract.paidUsed, false);
});

test("the status view explains the order and why nothing costs money", () => {
  const status = web.localSearchStatus();
  assert.deepEqual(status.order.search, ["searxng", "wigolo"], "DDG is absent while disabled");
  assert.deepEqual(status.order.extract, ["crawl4ai", "native"]);
  assert.match(status.note, /never depends on a paid API/);

  process.env.LOCAL_SEARCH_DDG_FALLBACK = "true";
  assert.deepEqual(web.localSearchStatus().order.search, ["searxng", "wigolo", "ddg-html"], "opt-in is reflected");
});

after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
