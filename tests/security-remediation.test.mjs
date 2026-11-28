import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFile(path.join(root, rel), "utf8");

// ── Phase 1: Workforce tenant isolation ─────────────────────────────────────
test("Phase 1: workforce engine fails closed when companyId is missing", async () => {
  const engine = await import("../src/lib/workforce/engine.ts");
  assert.equal(await engine.getEmployee("emp-1", ""), null);
  assert.equal(await engine.getEmployeeById("emp-1", ""), null);
  assert.deepEqual(await engine.getDepartmentEmployees("dept-1", ""), []);
  assert.deepEqual(await engine.getMemories("emp-1", undefined, 20, ""), []);
  assert.equal(await engine.getWorkingMemory("emp-1", ""), null);
  assert.deepEqual(await engine.getRelevantMemories("emp-1", "query", ""), []);
  assert.deepEqual(await engine.retrieveKnowledge("query", "dept-1", undefined, 5, ""), []);
  assert.deepEqual(await engine.findApplicableSops("task", "senior", "dept-1", ""), []);
  assert.equal(await engine.addMemory("emp-1", { memoryType: "fact", title: "t", content: "c" }, ""), null);
  assert.equal(await engine.getEmployeeStats("emp-1", ""), null);
  assert.equal(await engine.executeSop("sop-1", {}, ""), null);
  await assert.rejects(() => engine.executeWithEmployee("emp-1", "task", undefined, ""), /not found|companyId/i);
});

// ── Phase 3: Provider destination validators ────────────────────────────────
test("Phase 3: provider destination validators block SSRF & host injection", async () => {
  const {
    validateWordpressSiteUrl,
    validateMailchimpServerPrefix,
    validateShopifyShopDomain,
  } = await import("../src/lib/provider-http.ts");

  assert.equal(validateWordpressSiteUrl("https://blog.example.com/wp/"), "https://blog.example.com/wp");
  assert.throws(() => validateWordpressSiteUrl("http://blog.example.com"));
  assert.throws(() => validateWordpressSiteUrl("https://127.0.0.1/wp"));
  assert.throws(() => validateWordpressSiteUrl("https://169.254.169.254/latest"));
  assert.throws(() => validateWordpressSiteUrl("https://blog.example.com/?token=secret"));

  assert.equal(validateMailchimpServerPrefix(" US12 "), "us12");
  assert.throws(() => validateMailchimpServerPrefix("us12.attacker.com"));
  assert.throws(() => validateMailchimpServerPrefix("us12/../../admin"));

  assert.equal(validateShopifyShopDomain("https://My-Store.myshopify.com/admin"), "my-store.myshopify.com");
  assert.throws(() => validateShopifyShopDomain("evil.com"));
  assert.throws(() => validateShopifyShopDomain("shop.myshopify.com.evil.com"));
});

// ── Phase 4: SSRF IPv4-mapped IPv6 & CGNAT blocking ─────────────────────────
test("Phase 4: isPrivateIp and isUrlSafe block CGNAT and IPv4-mapped IPv6 bypasses", async () => {
  const { isPrivateIp, isUrlSafe } = await import("../src/lib/ssrf.ts");

  for (const priv of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "[::ffff:7f00:1]",
  ]) {
    assert.equal(isPrivateIp(priv), true, `expected ${priv} to be blocked as private`);
  }

  assert.equal(isPrivateIp("93.184.216.34"), false);
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);

  assert.equal((await isUrlSafe("http://[::ffff:7f00:1]/")).allowed, false);
  assert.equal((await isUrlSafe("http://[::ffff:a9fe:a9fe]/latest/meta-data/")).allowed, false);
  assert.equal((await isUrlSafe("http://100.64.0.1/")).allowed, false);
});

// ── Phase 5: media-token fail-closed & route-level auth guards ──────────────
test("Phase 5: media-token fails closed in production when NEXTAUTH_SECRET is unset", async () => {
  const { mintMediaToken, verifyMediaToken } = await import("../src/lib/media-token.ts");
  const prevEnv = process.env.NODE_ENV;
  const prevSecret = process.env.NEXTAUTH_SECRET;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.NEXTAUTH_SECRET;
    await assert.rejects(() => mintMediaToken("/avatar-videos/test.mp4"), /NEXTAUTH_SECRET/);
    assert.equal(await verifyMediaToken("0".repeat(32), "/avatar-videos/test.mp4"), false);

    process.env.NEXTAUTH_SECRET = crypto.randomBytes(32).toString("hex");
    const tok = await mintMediaToken("/avatar-videos/test.mp4");
    assert.equal(await verifyMediaToken(tok, "/avatar-videos/test.mp4"), true);
    assert.equal(await verifyMediaToken(tok, "/avatar-videos/other.mp4"), false);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prevSecret;
  }
});

test("Phase 5: requireOwnerOrResponse fails closed and sensitive routes wire it on every handler", async () => {
  const { requireOwnerOrResponse } = await import("../src/lib/auth.ts");
  const prevReqAuth = process.env.ALO_REQUIRE_AUTH;
  const prevEmail = process.env.ADMIN_EMAIL;
  const prevHash = process.env.ADMIN_PASSWORD_HASH;
  try {
    process.env.ALO_REQUIRE_AUTH = "true";
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD_HASH;

    const denied = await requireOwnerOrResponse();
    assert.ok(denied.response);
    assert.ok(denied.response.status === 401 || denied.response.status === 503);
    assert.equal(denied.response.headers.get("cache-control"), "no-store");

    const routePaths = [
      "src/app/api/backups/route.ts",
      "src/app/api/seed/route.ts",
      "src/app/api/export/route.ts",
      "src/app/api/video/cinematic/route.ts",
      "src/app/api/video/generate/route.ts",
      "src/app/api/family-studio/route.ts",
      "src/app/api/avatar-video/file/route.ts",
    ];
    for (const rel of routePaths) {
      const src = await read(rel);
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/g)];
      assert.ok(handlers.length > 0, `${rel} must export at least one handler`);
      for (const h of handlers) {
        const after = src.slice(h.index, h.index + 240);
        assert.match(after, /requireOwnerOrResponse\(\)/, `${rel} ${h[1]} must call requireOwnerOrResponse()`);
      }
    }
  } finally {
    if (prevReqAuth === undefined) delete process.env.ALO_REQUIRE_AUTH;
    else process.env.ALO_REQUIRE_AUTH = prevReqAuth;
    if (prevEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = prevEmail;
    if (prevHash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
    else process.env.ADMIN_PASSWORD_HASH = prevHash;
  }
});

// ── Phase 6: AI chain & router pinning / streaming fixes ────────────────────
test("Phase 6: router avoids trailing colon preferredModel and primes external AI in streaming", async () => {
  const routerSrc = await read("src/lib/omni/router.ts");
  const chainSrc = await read("src/lib/ai-chain.ts");

  assert.doesNotMatch(routerSrc, /\$\{preferred === "local-ollama" \? "ollama" : preferred\}:/);
  assert.match(routerSrc, /preferredProvider:/);
  assert.match(routerSrc, /routeChatStream[\s\S]{0,200}primeExternalAiConfig/);
  assert.doesNotMatch(routerSrc, /stream:\s*true,\s*format:\s*"json"/);

  assert.match(chainSrc, /x-goog-api-key/);
  assert.doesNotMatch(chainSrc, /generateContent\?key=/);
  assert.match(chainSrc, /requestProviderJson/);
  assert.doesNotMatch(chainSrc, /marketing\.alolabs\.net/);
});

// ── Phase 7: Video escaping, Bengali font, voice & path validation ──────────
test("Phase 7: video-exec resolves Bengali font, escapes drawtext, validates voice & media paths", async () => {
  const {
    resolveVideoFontFile,
    escapeDrawtext,
    validateVoiceId,
    resolveSafeMediaInputPath,
  } = await import("../src/lib/video-exec.ts");

  const font = resolveVideoFontFile();
  assert.match(font, /HindSiliguri-Bold\.ttf$/);

  const escaped = escapeDrawtext("Hello: 100%; [x]=a,b 'test' \\ \nline2");
  assert.doesNotMatch(escaped, /[\r\n]/);
  assert.ok(escaped.includes("\\:") && escaped.includes("\\%") && escaped.includes("\\;") && escaped.includes("\\[") && escaped.includes("\\]"));

  assert.equal(validateVoiceId("bn"), "bn");
  assert.equal(validateVoiceId("bn+m1"), "bn+m1");
  assert.equal(validateVoiceId("-bad"), "bn");
  assert.equal(validateVoiceId("bn;rm -rf /"), "bn");

  assert.equal(await resolveSafeMediaInputPath("../../etc/passwd"), null);
  assert.equal(await resolveSafeMediaInputPath("/etc/passwd"), null);
  assert.ok(await resolveSafeMediaInputPath("public/fonts/HindSiliguri-Bold.ttf"));

  const genSrc = await read("src/app/api/video/generate/route.ts");
  assert.doesNotMatch(genSrc, /absolutePath:/);
});

// ── Phase 8: OAuth callback atomic state claim & redirect origin ────────────
test("Phase 8: OAuth callback claims state atomically before token exchange", async () => {
  const cbSrc = await read("src/app/api/v1/integrations/[provider]/callback/route.ts");
  const claimIdx = cbSrc.indexOf("db.oAuthState.updateMany");
  const fetchIdx = cbSrc.indexOf("fetch(tokenUrl");
  assert.ok(claimIdx > -1 && fetchIdx > -1 && claimIdx < fetchIdx, "OAuthState must be claimed atomically before token fetch");
  assert.match(cbSrc, /AbortSignal\.timeout/);
  assert.match(cbSrc, /redirect:\s*'error'/);
  assert.match(cbSrc, /NEXT_PUBLIC_SITE_URL/);
});

// ── Phase 9: Security IP extraction, bearer auth, and vault GCM tag check ───
test("Phase 9: ipFromRequest validates IPs and ignores spoofed left-side XFF entries", async () => {
  const { ipFromRequest } = await import("../src/lib/security.ts");

  const spoofedReq = new Request("http://localhost/api/test", {
    headers: { "x-forwarded-for": "evil-payload, 10.0.0.99, 198.51.100.42" },
  });
  assert.equal(ipFromRequest(spoofedReq), "198.51.100.42");

  const realIpReq = new Request("http://localhost/api/test", {
    headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" },
  });
  assert.equal(ipFromRequest(realIpReq), "203.0.113.7");

  const garbageReq = new Request("http://localhost/api/test", {
    headers: { "x-forwarded-for": "not-an-ip; DROP TABLE" },
  });
  assert.equal(ipFromRequest(garbageReq), "127.0.0.1");
});

test("Phase 9: vault decryptSecret enforces 12-byte IV and 16-byte GCM auth tag", async () => {
  const { encryptSecret, decryptSecret } = await import("../src/lib/vault.ts");
  const { ciphertext } = encryptSecret("super-secret-value");
  assert.equal(decryptSecret(ciphertext), "super-secret-value");

  const [ver, ivB64, ctB64, tagB64] = ciphertext.split(":");
  const shortTag = Buffer.from(tagB64, "base64").subarray(0, 4).toString("base64");
  assert.throws(() => decryptSecret(`${ver}:${ivB64}:${ctB64}:${shortTag}`), /authTag length/i);

  const shortIv = Buffer.from(ivB64, "base64").subarray(0, 8).toString("base64");
  assert.throws(() => decryptSecret(`${ver}:${shortIv}:${ctB64}:${tagB64}`), /IV length/i);
});

test("Phase 9: getSessionUser rejects non-Bearer Authorization headers", async () => {
  const { getSessionUser } = await import("../src/lib/auth.ts");
  const req = new Request("http://localhost/api/test", {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(await getSessionUser(req), null);
});

// ── Security Acceptance Suite (Section 4) ────────────────────────────────────
test("Acceptance: webhook secrets are encrypted at rest and never returned in GET routes", async () => {
  const { storeWebhookSecret, resolveWebhookSecret, signWebhookPayload } = await import(
    "../src/lib/webhook-signature.ts"
  );
  const rawSecret = crypto.randomBytes(24).toString("hex");
  const stored = storeWebhookSecret(rawSecret);
  assert.ok(stored.startsWith("1:") && stored.split(":").length === 4, "stored secret must be AES-GCM encrypted");
  assert.ok(!stored.includes(rawSecret), "stored secret must not contain plaintext");
  assert.equal(resolveWebhookSecret(stored), rawSecret);
  assert.equal(signWebhookPayload(rawSecret, '{"ok":true}').length, 64);

  const settingsSrc = await read("src/app/api/settings/webhooks/route.ts");
  const v1Src = await read("src/app/api/v1/webhooks/route.ts");
  assert.match(settingsSrc, /secretConfigured:\s*Boolean\(w\.secret\)/);
  assert.match(v1Src, /secretConfigured:\s*Boolean\(h\.secret\)/);
  assert.doesNotMatch(settingsSrc, /\bsecret:\s*w\.secret/);
  assert.doesNotMatch(v1Src, /\bsecret:\s*h\.secret/);
});

test("Acceptance: redirect-based SSRF and DNS rebinding are blocked in fetchSafePublicUrlUsing (Node 22 lookup compatible)", async () => {
  const http = await import("node:http");
  const { EventEmitter } = await import("node:events");
  const { fetchSafePublicUrlUsing, isUrlSafe } = await import("../src/lib/ssrf.ts");

  // 1) Redirect to metadata IP must be rejected on hop 2
  const mockHop302 = (_url, _opts, cb) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302;
      res.headers = { location: "http://169.254.169.254/latest/meta-data/" };
      res.destroy = () => {};
      cb(res);
    };
    req.destroy = () => {};
    return req;
  };
  let checks = 0;
  await assert.rejects(
    () =>
      fetchSafePublicUrlUsing(
        "https://public.example.test/start",
        {},
        {
          httpRequest: mockHop302,
          httpsRequest: mockHop302,
          checkUrl: async (u) => {
            checks++;
            if (checks === 1) return { allowed: true, resolvedIps: ["93.184.216.34"] };
            return isUrlSafe(u);
          },
        }
      ),
    /SSRF guard/i
  );

  // 2) Mixed public + private resolved IPs (DNS rebinding vector) must be rejected immediately
  await assert.rejects(
    () =>
      fetchSafePublicUrlUsing(
        "https://rebind.example.test/",
        {},
        {
          checkUrl: async () => ({ allowed: true, resolvedIps: ["93.184.216.34", "127.0.0.1"] }),
        }
      ),
    /private\/blocked IP/i
  );

  // 3) Real Node 22 socket lookup with { all: true } receives [{ address, family }] instead of crashing
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned-ok");
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = srv.address();
    let seenAllLookup = false;
    const realHttpReq = (url, opts, cb) => {
      const wrappedOpts = {
        ...opts,
        lookup(host, lookupOpts, lcb) {
          if (lookupOpts && lookupOpts.all) seenAllLookup = true;
          return opts.lookup(host, lookupOpts, (err, addrOrArr, fam) => {
            if (err) return lcb(err);
            // Redirect socket target to local test server after verifying lookup returned valid Node 22 shape
            if (Array.isArray(addrOrArr)) {
              assert.equal(addrOrArr[0].address, "93.184.216.34");
              return lcb(null, [{ address: "127.0.0.1", family: 4 }]);
            }
            assert.equal(addrOrArr, "93.184.216.34");
            return lcb(null, "127.0.0.1", fam || 4);
          });
        },
      };
      return http.request(url, wrappedOpts, cb);
    };
    const resp = await fetchSafePublicUrlUsing(
      `http://public.example.test:${port}/hello`,
      {},
      {
        httpRequest: realHttpReq,
        checkUrl: async () => ({ allowed: true, resolvedIps: ["93.184.216.34"] }),
      }
    );
    assert.equal(resp.status, 200);
    assert.equal(Buffer.from(resp.body).toString("utf8"), "pinned-ok");
    assert.equal(seenAllLookup, true, "Node 22 autoSelectFamily calls lookup with { all: true }");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("Acceptance: OAuth concurrent state replay allows only one atomic claim", async () => {
  const cbSrc = await read("src/app/api/v1/integrations/[provider]/callback/route.ts");
  assert.match(cbSrc, /updateMany\(\s*\{[\s\S]*consumed:\s*false[\s\S]*data:\s*\{\s*consumed:\s*true/);
  assert.match(cbSrc, /claimed\.count\s*!==\s*1/);

  // Simulate two simultaneous callbacks racing to consume the same OAuthState row
  let consumed = false;
  const atomicClaim = async () => {
    await Promise.resolve();
    if (consumed) return { count: 0 };
    consumed = true;
    return { count: 1 };
  };
  const [r1, r2] = await Promise.all([atomicClaim(), atomicClaim()]);
  assert.equal(r1.count + r2.count, 1, "exactly one concurrent callback may consume OAuthState");
});

test("Acceptance: HTTP Range boundary parsing handles valid, suffix, open-ended, and invalid ranges", async () => {
  const { parseByteRange } = await import("../src/lib/video-exec.ts");
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { ok: true, start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=500-", 1000), { ok: true, start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=0-9999", 1000), { ok: true, start: 0, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { ok: true, start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-0", 1000), { ok: false });
  assert.deepEqual(parseByteRange("bytes=1000-1050", 1000), { ok: false });
  assert.deepEqual(parseByteRange("bytes=200-100", 1000), { ok: false });
  assert.deepEqual(parseByteRange("bytes=0-1,2-3", 1000), { ok: false });
  assert.deepEqual(parseByteRange("bytes=abc-def", 1000), { ok: false });
  assert.deepEqual(parseByteRange("bytes=0-0", 0), { ok: false });
});

