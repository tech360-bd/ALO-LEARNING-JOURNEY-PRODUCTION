# Remediation Baseline — 2026-11-28

**Repository:** `tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION`  
**Branch:** `arena/910dafda-alo-learning-journey-productio`  
**Base Commit:** `d550e9c7ec28c0666efe8b27c0607c30167f7c05`  
**Date:** 2026-11-28 (UTC)

---

## 1. Environment & Toolchain Inventory

| Component | Baseline Status | Notes |
| --- | --- | --- |
| Node.js | `v22.22.3` | Matches `.node-version` / `package.json` (`>=22 <23`) |
| npm | `10.9.8` | `npm ci --ignore-scripts` installed 710 packages from `registry.npmjs.org` |
| Prisma Client | `6.19.3` (WASM DMMF no-engine in sandbox) | `binaries.prisma.sh` is outside sandbox outbound allowlist (`github.com`, `registry.npmjs.org`, `pypi.org`). Generated `node_modules/.prisma/client` locally from `prisma_schema_build_bg.wasm` + `@prisma/client/generator-build` for typechecking/unit tests; native `prisma validate` / `prisma generate` runs in GitHub Actions CI. |
| FFmpeg / FFprobe | Available via `@ffmpeg-installer/ffmpeg` & `@ffprobe-installer/ffprobe` | Installed in `node_modules/@ffmpeg-installer/linux-x64` & `@ffprobe-installer/linux-x64` |
| MySQL / MariaDB | Not installed in sandbox | `test-tenant-workflows.ts`, `test-reliability-workflows.ts`, and `test-migrations.mjs` require live MySQL 8.0 (verified in CI `.github/workflows/ci.yml`) |
| Bun / Docker / eSpeak / ShellCheck | Not installed in sandbox | `Dockerfile` / `bun.lock` drift audited statically |

---

## 2. Baseline Verification Results (Pre-Remediation)

| Check | Outcome | Details |
| --- | --- | --- |
| `npm run verify:migrations` | PASS | 150 models, 1,900 scalar column types, 8 migrations |
| `npm run verify:workflows` | PASS | 3 active workflow files checked, 0 errors (11 SHA-pinning warnings) |
| `npm run lint` | PASS | `eslint .` exits 0 (with core rules currently disabled in `eslint.config.mjs`) |
| `npm run typecheck` | PASS | `tsc --noEmit` exits 0 (against WASM-generated 150-model client; 34 files use `@ts-nocheck`) |
| `npm test` | PASS | 462 passed, 0 failed across `tests/*.test.mjs` |
| `node scripts/scan-secrets.mjs` | PASS | 1,273 worktree entries scanned, 0 findings |
| `node scripts/verify-media-pipeline.mjs` | PASS | Offline media pipeline smoke test passed |
| `TSX_TSCONFIG_PATH="$PWD/tsconfig.json" node --import tsx scripts/test-photo-video-workflow.ts` | PASS | Handler smoke test passed |
| `bash scripts/test-deploy-rollback.sh` | PASS | Deploy rollback & `bash -n` passed (`shellcheck` absent) |
| `scripts/test-tenant-workflows.ts` | BLOCKED (Infra) | Requires disposable MySQL `DATABASE_URL` |
| `scripts/test-reliability-workflows.ts` | BLOCKED (Infra) | Requires disposable MySQL `DATABASE_URL` |

---

## 3. Remediations Tracked (Findings 1–13)

1. **Phase 1 — Workforce Cross-Tenant Isolation**
   - `src/app/api/workforce/memory/route.ts`: Remove unconditional `return true` before ownership check; enforce tenant `companyId` scoping on `GET`/`POST`/`DELETE`.
   - `src/app/api/workforce/knowledge/route.ts` & `src/lib/workforce/engine.ts`: Scope `retrieveKnowledge()`, `findApplicableSops()`, `executeSop()`, and `getMemories()` by explicit `companyId` (no global `companyId: { not: '' }` bypass).
2. **Phase 2 — Webhook Secret Exposure & Unvalidated Destinations**
   - `src/app/api/v1/webhooks/route.ts` & `src/app/api/settings/webhooks/route.ts`: Never return raw `secret` in API responses; encrypt or hash consistently (`storeWebhookSecret`), enforce `publicUrl(url, true)` SSRF/origin validation, validate `status` enum, return `403` for insufficient role, and align HMAC signing/redaction.
3. **Phase 3 — Integration SSRF & Credential Exfiltration**
   - `src/app/api/v1/integrations/[provider]/credentials/route.ts`, `.../connections/[connectionId]/discover/route.ts`, `.../connections/[connectionId]/validate/route.ts`: Validate `site_url`, `shop`, `server_prefix` strictly; pin DNS via `public-http.ts`/`provider-http.ts` with `redirect: 'error'` and timeouts; verify `integration.provider === provider`.
4. **Phase 4 — Shared Outbound HTTP SSRF Redirects & Unbounded Reads**
   - `src/lib/local-web-search.ts`, `src/lib/self-heal/browser.ts`, `src/lib/public-http.ts`: Disable `redirect: 'follow'` (or re-validate each hop safely), enforce bounded reads via `readLimitedStream` (`src/lib/read-limited-stream.mjs`), and prevent TOCTOU DNS rebinding.
5. **Phase 5 — Route-Level Auth & Fail-Closed Media Token**
   - `src/lib/media-token.ts`: Remove insecure fallback secret in production (fail closed at runtime signing/verification without breaking Next.js build when env is absent).
   - `src/app/api/{backups,seed,export,video/cinematic,video/generate,family-studio}/route.ts`: Enforce handler-level auth/role checks independent of `src/proxy.ts`.
6. **Phase 6 — AI Provider Pinning, Registry SSRF & Streaming**
   - `src/lib/omni/router.ts`, `src/lib/ai-chain.ts`: Fix `preferredModel = "${preferred}:"` empty suffix bug, properly prioritize/filter requested provider/model, validate `tryRegistryProviders()` `baseUrl` against SSRF, fix `_zaiPromise` permanent failure caching, and fix `routeChatStream()` `primeExternalAiConfig()` + `format: "json"` bug.
7. **Phase 7 — OAuth Callback Atomicity & External Redirects**
   - `src/app/api/v1/integrations/[provider]/callback/route.ts`: Atomic `oauthState.consumed` `updateMany` claim, bounded timeout on token exchange, and canonical public origin redirects (`getCallbackUrl` / `NEXT_PUBLIC_SITE_URL`) instead of internal `request.url`.
8. **Phase 8 — Audit IP Attribution, Bearer Parsing & AES-GCM Validation**
   - `src/lib/security.ts`, `src/lib/auth.ts`, `src/lib/vault.ts`: Wire real IP attribution into `createAuditLog()`, harden `ipFromRequest()` against spoofed `x-forwarded-for`, unify Bearer token extraction via `readBearerToken()`, and validate `iv.length === 12` / `authTag.length === 16` in `decryptSecret()`.
9. **Phase 9 — Video/Audio FFmpeg & HTTP Range Reliability**
   - `src/app/api/video/{cinematic,generate}/route.ts`, `src/app/api/avatar-video/{,file/}route.ts`: Harden `drawtext` escaping, validate `audioPath`/`voice` strictly against traversal/injection, use `public/fonts/HindSiliguri-Bold.ttf`, remove `absolutePath` disclosure, fix `avatar-video/file` Range parsing + Web stream + HTTP status codes, and avoid fragile shell-string assembly.
10. **Phase 10 — Security & Integration Tests**
    - Add deterministic unit/regression tests in `tests/*.test.mjs` covering Phases 1–9.
11. **Phase 11 — TypeScript & ESLint Cleanup**
    - Eliminate `@ts-nocheck` across `src/` where feasible, tighten `tsconfig.json` / `eslint.config.mjs` safely without breaking clean compilation.
12. **Phase 12 — Docker, Package Manager & CI Consistency**
    - Audit and align `Dockerfile`, `docker-compose.yml`, `package.json`, `.github/workflows/`, and documentation on canonical Node 22 + `npm ci` + port `3061`.
13. **Phase 13 — Documentation Archival & Final Evidence**
    - Clean up root `.md` sprawl cleanly (archiving superseded audits/worklogs), remove stale references, and produce `audit/2026-11-28-remediation-results.md` and `audit/2026-11-28-security-verification.md`.
