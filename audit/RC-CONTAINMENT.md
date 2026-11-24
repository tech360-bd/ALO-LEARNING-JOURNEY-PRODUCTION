# ALO release candidate · security containment verification

**24 November 2026 UTC · NO-GO.** This is a follow-up on the [repair baseline](2026-11-24-readiness.md). “Passed” means the named check actually executed. Source inspection, an isolated handler run, a real database transaction and a live service receipt are different evidence. No production credentials, infrastructure or database were used.

## A. Branch and commit

`tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION`, `arena/d3ffecde-alo-learning-journey-productio`, HEAD and base `91948c674c93e6fe5b3a8710492bde811c4eb3ae`. Node 22.22.3, npm 10.9.8, root Next 16.4.6, Prisma/client 6.19.3. There is **no new release SHA**; CI on the public base is not CI on this candidate.

## B. Working-tree status

Recorded `git status --porcelain=v1 -uall`, HEAD and branch before editing. Initial inventory: 62 modified tracked files, one deleted tracked file and ten untracked files, empty staging area. Reviewed the delta from HEAD (credential deletion inspected by names/metadata only), the proposed new files and the previous report. Prior role/MFA/session/billing contact, AI guard, frontend, CI, migration safety and media changes are present; subsequent changes extend or tighten those repairs. No reset, checkout, staging, commit, push, PR, history rewrite or deployment. No changes to schema, migrations, user media, or archived MarketingOS app. A dirty working tree, including its untracked files, is the deliverable.

## C. Complete inventory

[File-by-file inventory](RC-FILES.md) compares the before and final status against the same HEAD. It includes deleted files and new tests/docs, not just `git diff --stat`. The transient test dependencies/standalone output are intentionally ignored and not deliverables.

## D. Credential incident: OPEN, public exposure confirmed

- File: root `.env.save`. Git object `ea8c47e1ad8aceb5ea388c0804108b692867a67f` at HEAD. Read-only repository API: **public**; zero reported forks at inspection time. No access to credentials was tested. Any internet user could have read the public revision; neither actual readers nor lack of abuse can be established here.
- Local checkout is shallow. Queried published branches and the commits-by-path API at **each of 15 branch tips**, and inspected root tree metadata. `main` contains the file and the path history returns the base SHA. Its parent `85bfe5d7b3150656b1b6bb0aced053f469fb06f5` has no root `.env.save`. The other 14 published tips return no path commit. This local Arena branch inherits the blob in HEAD, though it is deleted on disk. No published tags or releases were listed. This is not proof about dangling objects, renamed copies, deleted refs, PR refs or external mirrors.
- `git archive HEAD -- .env.save | tar -t` confirms that a **source archive of that SHA includes the file**. Baseline Docker `COPY . .` admitted it to the builder context. Neither fact proves a production image shipped. The tracked cPanel ZIP was inspected in memory: only `.env.example` by env basename and zero exact matches to the selected populated credential values in its direct uncompressed members. No claim about other archives, encrypted/encoded content, Docker layers or caches.
- Actions listed zero retained artifacts. Base CI and reusable deploy verification failed; remote deployment job skipped. The logs API did not return readable log archives for runs 44252760934 and 44252760941. CI checkouts **contained** the file; logs, expired artifacts and external caches are **not cleared**. No raw logs, credentials or archive contents were published.

**Secret inventory (names and exposure only):**

| Name | Exposure status in tracked backup |
|---|---|
| `DATABASE_URL` | Populated, credential-bearing |
| `NEXTAUTH_SECRET`, `JWT_SECRET`, `CRON_SECRET` | Populated |
| `ADMIN_PASSWORD_HASH`, `ALO_ADMIN_PASSWORD_HASH` | Populated password verifiers; not plaintext passwords |
| `HTTPSMS_API_KEY` | Populated |
| `BACKUP_ENCRYPTION_KEY`, `VAULT_MASTER_KEY` | Populated encryption keys |
| `LIPSYNC_API_KEY`, `TELNYX_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SMTP_PASS`, `SMTPPASS`, `SMTP_PASSWORD`, `POSTIZ_API_KEY` | Empty in this file; no conclusion about other environments |

Non-secret but sensitive: account addresses, administrator/OTP phone metadata, service URLs and paths. `REDIS_URL` was set with no URL userinfo. No secret is classified as inactive just because validity was not tested.

**Rotation sequence — operator only:**

1. Security owner records affected environments privately, restricts access to incident evidence, checks provider billing/SMS usage, database access, admin/login and cron audit trails, privileged memberships and old invitations. Stop unintended deliveries. Do not paste credentials into a PR, support chat or CI job.
2. **Independently revocable:** issue a replacement SMS API credential and revoke the exposed one at its issuer; coordinate the new credential with the OTP sender and verify controlled delivery. Change the administrator password, regenerate both required verifier settings, and invalidate admin sessions. Rotating the hash alone is not password rotation.
3. **Coordinated service cutovers:** provision least-privilege DB credentials; update every app/backup/worker consumer, test with least privilege, then revoke the old DB account/credential. Replace cron bearer at caller and receiver. Rotate NextAuth signing material on every admin instance and validate a new login plus rejection of old cookies. Rotate MarketingOS signing material across gateway/API instances; explicitly invalidate legacy **refresh** credentials and sessions too. JWT key rotation alone does not invalidate a DB-backed refresh token.
4. **Data keys — do not replace in place.** Inventory versioned vault envelopes (OAuth/manual connections, provider credentials, MFA seeds) and encrypted backup sets. This vault currently decrypts **one version with one cached master key**, not a dual-reader keyring. Do not assume a rotation script mentioned in comments exists. Preserve restricted old-key access. On a restored isolated copy, either stage tested old/new readers with versioned writes or quiesce writers for a reviewed transactional re-encryption procedure. Compare row counts, verify authenticated decryption and rollback of representative records without logging plaintext. Revoke compromised upstream credentials/re-enroll previously disclosed MFA seeds as well: re-encryption cannot take back disclosure.
5. For `BACKUP_ENCRYPTION_KEY`, produce and restore a new-key backup; securely retain the ability to restore every required older backup until its retention expires or a replacement has been restored and verified. Obtain DBA/security approval before retiring either old key. Only after containment, coordinate history/cache/artifact remediation separately. Rotation completion and rejection of old credentials require **operator evidence**, not repository edits.

## E. Git, Docker and CI scanner

CI now runs `node --test tests/secret-scanner.test.mjs` and `node scripts/scan-secrets.mjs`. Walks `git ls-files -coz --exclude-standard` and reads worktree bytes, including tracked files in ignored directories; no extension/size/directory omission of scripts, tests, archived services, workflows, docs, lockfiles or binary assets. Symlink targets are scanned as link text, not followed; deletions are absent in the candidate checkout. All scanned files get credential URL, key assignment, private-key and common provider token patterns. App source also gets a shorter literal-assignment heuristic. Reports **rule and path fingerprint only**, not matched values, lines or untrusted filenames. Read/enumeration errors fail the command. Test uses a throwaway Git index/repository, synthesizes a non-issued token, checks nonzero exit/redaction across five formerly problematic directories, a clean pass and env-backup filename detection. No real credential fixtures. On the final inventory the scanner inspected 1,149 entries with zero findings. A separate non-logging in-memory comparison also found zero candidate files containing any exact value of the nine selected incident credential settings; it does not detect transformations.

Root and nested `.env`, `.env.*`, backup/editor variants and `.envrc` excluded; root `.env.example` intended exception. `git check-ignore --no-index` verified nested backups. Docker rules additionally exclude private key files; **source rule review, not a built Docker image**. Git ignores are not enforcement against forced adds. This scanner is a heuristic current-tree gate, not archive extraction, remote CI proof, full-history scanning, private forensic discovery, or issuer revocation. Perform a separately authorized full-ref/history and artifact scan with redacted results. External clones cannot be recalled.

## F. Roles and MFA

Role writes in `api/users`/`api/team` check active tenant membership server-side, not frontend flags. Assignable roles come from a canonical allowlist; owners cannot grant ownership or platform authority; tenant admins cannot modify peers or higher roles. Target members are looked up under company ID. Protected-invitation checks now also cover revocation. Existing invite/role labels and member management preserved. Unit matrix and compatibility cases passed. Previously assigned privileged rows still require review. No claim of verified MySQL row effects or race-free management authorization under concurrent demotion.

Setup creates QR PNG locally. Old encrypted base64 enrollments and tagged Base32 enrollments round-trip through the real vault primitives and both produce the expected RFC test code. Setup refuses replacement of enabled MFA. Setup/verify/disable are authenticated and each limited to 5 attempts per user/minute before sensitive work; login guesses rate-limited. Only a matching unused time step enables MFA/login; login requires password and successful challenge before JWT issuance. Disable checks a fresh code and the unchanged enrollment row; no seed-bearing URL or new plaintext log. No unauthenticated reset or bypass added. Lost authenticators need an independently approved identity-proofed recovery process; do not disable MFA ad hoc. Rate limits are per process, not distributed. ALO admin NextAuth/SMS OTP behavior is separate; browser smoke uses explicit test-only admin OTP opt-out, not a handset test. Actual persisted enrollment/login/disable and recovery remain staging gates.

## G. Sessions and tokens

Cutover policy: **reject sid-less access tokens immediately; sign in again**. Both gateway and route enforce HS256, finite lifetime and required token/session identity. Gateway signature/claims acceptance only selects permitted routes; privileged handlers must also check active `UserSession`, account and live tenant membership/role. Unit tests include signed legacy rejection and expiration/invalid signature. No production session was touched. Registration and login issue the session row with the token; device revoke scopes by user and session. Refresh conditionally consumes the original tenant’s token and binds its successor; logout-all and device revocation invalidate linked credentials. One remaining hook that cleared only local auth now requests server revocation first. Network failure still cannot guarantee server logout. Rotating access signing keys does not settle the legacy refresh transition (§D).

Disposable harness includes login session lookup, concurrent refresh, expired/reused refresh rejection, device/session revoke, logout-all and isolation from another user. **Not run against MySQL.** It calls real handlers, not a browser; after it passes require two-tenant HTTP tests including simultaneous revoke/rotate. Do not infer target DB behavior from source or JWT unit tests.

## H. Billing containment

Both credit POSTs delegate to the same authenticated refusal: 403 for insufficient authority; 503 for an otherwise authorized purchase without verified settlement. Neither writes a balance, adjustment or paid invoice; GET still queries only the tenant. Payments record **pending** intents only for tenant owner/platform admin; no receipt, client-set outcome or invoice-paid write. New invoices can only start draft/sent. Invoice UI now supplies a provider and acknowledges a pending request, not a charge.

Idempotency uses the **existing unique payment primary key**: tenant + invoice identity for invoice intents, tenant + stable request key for unallocated intents (`Idempotency-Key` or `requestId` required). Identical retries return the saved row without re-emitting the event; different parameters for the same key produce 409. No backfill or modification of historical payments, credit balances, or invoices. Legacy pending rows with older IDs are not deduplicated retroactively. DB harness seeds a nonzero balance, checks reads and unchanged amount, rejects credit attempts, rejects client settlement, repeats/conflicts pending requests, races two invoice requests and compares the entire pre-existing invoice row afterwards. This is implemented **not MySQL-verified**. No real provider, ledger settlement, subscription certification or top-up approval. Keep billing settlement disabled.

## I. Media and storage

`test-photo-video-workflow.ts`: invalid single photo, mixed batch, forced real late render failure after caption creation (temporary test filesystem), successful 2 s 714×1268 H.264 draft, full MP4 length, 206 byte-range, gallery, Bengali SRT, invalid media ID, and no orphan job/partial output. A second Node process reopened the same temporary storage and found the render: evidence for disk persistence across process lifetimes, **not** a VPS restart. FFprobe independently verified H.264/AAC plus Bengali drawtext/SRT/formant WAV in `verify-media-pipeline.mjs`.

Per-request UUID paths; only partial outputs of the newly allocated ID cleaned. New render/work directories request owner-only access; pre-existing directories/umask not modified. Public generated image lookup checks real paths and disallows symlink escape. No untrusted source path is used as an output ID. Host permissions, trusted ownership of serving directories, disk quota, ingress limits, high concurrency and native-reader caption/audio review remain unverified. The deploy script links shared storage, but runtime public assets can still be copied before the release switch; writes after copy or before rollback may disappear from the active release. Symlink rollback smoke does not verify those files. Block release pending host storage/backup/restore rehearsal under writes.

## J. Native Prisma and MySQL

`npm ci` attempted on the original and final lockfiles. **Both failed, exit 1** during Prisma postinstall generation. `binaries.prisma.sh` TLS closed before the checksum for `c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine.gz` could be retrieved. No MySQL daemon/client, Docker or Podman/disposable service supplied. **Stopped native/DB verification.** No alternate unsigned binaries, production connection, schema push, migration or production seed. `test:migrations:integration`, `test:integration`, and the new tenant harness explicitly refused the missing disposable database (exit 1). No native generation, DB connection, fresh double-apply, rollback, restored-copy recovery or tenant/billing acceptance pass for this candidate.

For *separate* compile evidence only, used the pinned 6.19.3 Prisma WASM DMMF and official generator in no-engine mode: 141 real models, 11,249,632 bytes of schema-specific declarations. No-engine local build output **cannot be promoted**. Normal native generation in clean authorized CI remains mandatory.

## K. Outbound requests and downloads

Scraper, its secondary enrichment fetch, RSS parser and event webhook delivery now share `public-http.ts`. HTTPS/standard port and DNS names only, no credentials, literals, redirects, or private/reserved IPv4. Conservative IPv4-only lookup validates the A records **in the socket lookup callback**, connects to the selected address without a second hostname resolution, validates TLS against the original hostname, disables connection reuse, enforces a 10 s deadline and bounds response bytes (2 MiB retrieval; 64 KiB webhook). These callers read bounded text, not executable files. Webhooks also require exact operator-approved origins (`MOS_WEBHOOK_ALLOWED_ORIGINS`, empty = deny), and creation/deletion require team management authority. Policy unit tests offline; no live endpoint or negative intrusion testing. HTTP-only/IPv6-only/redirecting services must use a reviewed compatible endpoint, not bypass the checks.

This is **not** a project-wide egress certification. The old `ssrf.ts` precheck is not a pinned transport. Separate OAuth callback/connection discovery, provider validation and media download adapters still need origin/redirect, timeout, size, MIME/magic, destination-path and PII policy verification. Enforce network egress restrictions even if application checks pass; leave unapproved integrations off. Limit posted webhook payloads to data the tenant has authorized; an allowlisted host alone is not consent.

## L. Dependency advisories

Reproduced `npm audit --omit=dev --json`: **7 high + 4 moderate affected packages**, not eleven unique root vulnerabilities. After removing two unused root deps: **6 high + 0 moderate**, audit exit 1. Registry resolution removed 178 lockfile nodes, added none, changed no version of a retained node. The separate nested package was not upgraded or deployed. See [per-package and per-advisory triage](RC-ADVISORIES.md) for versions, paths, applicability, patch ranges, compatibility and required regression gates. No forced Prisma major upgrade, incompatible NextAuth downgrade or unverified SMTP override. A passing policy test does not remediate an installed vulnerable package.

## M. Command results

| Command | Current candidate evidence |
|---|---|
| `npm ci` | FAIL 1, native postinstall as above |
| `npm test` | PASS 0 · **159/159**, 0 skipped (previous 154) |
| `npm run lint` / `npm run typecheck` | PASS; schema-specific no-engine client, not DB verification |
| `npm run verify:migrations` | PASS · 141 models, 1,823 scalar column types, six additive migrations, 101 TEXT defaults; static only |
| `NEXT_TELEMETRY_DISABLED=1 npm run build` / `test -f .next/standalone/server.js` | PASS · standalone Node build, static/public assets; **no native DB runtime** |
| `LD_LIBRARY_PATH="$PWD/.cache/alo-browser/syslibs/lib" node scripts/test-browser-smoke.mjs` | Real local standalone browser smoke: mobile contact failure retains input, public font, admin page gate, credential sign-in, separate tenant login, logout and responsive layout. Isolated headless Chromium, no external delivery. |
| `node scripts/verify-media-pipeline.mjs` / `TSX_TSCONFIG_PATH=$PWD/tsconfig.json node --import tsx scripts/test-photo-video-workflow.ts` | PASS · real local codecs and handler/disk workflow (§I) |
| `bash scripts/test-deploy-rollback.sh` | PASS · temporary symlink flip/rollback and Bash syntax; ShellCheck not installed |
| `node --test tests/secret-scanner.test.mjs` / `node scripts/scan-secrets.mjs` | PASS · controlled redacted failure and clean candidate worktree, not history or hosted CI |
| `npm run test:migrations:integration` / `npm run test:integration` / `TSX_TSCONFIG_PATH=$PWD/tsconfig.json node --import tsx scripts/test-tenant-workflows.ts` | BLOCKED 1 each, disposable MySQL required |
| `npm audit --omit=dev --json` | FAIL 1 · six remaining high affected packages |
| `git diff --check` | PASS · no schema/migration or staged changes |

## N. Remaining production blockers

| Priority | Blocker | Release consequence |
|---|---|---|
| Critical | Public credential exposure; no verified revocation, session invalidation or key-transition restore | Block entire release |
| High | No native install/build/connection or disposable MySQL persistence, concurrency, migration history and recovery verification | Block entire release; do not ship the diagnostic build |
| High | Six dependency findings unresolved in core Prisma and mail/auth chains | Block pending tested remediation/security review |
| High | Host shared/writeable storage handoff, restore, proxy limits, PM2 configuration and rollback not verified | Block release |
| High | No accepted trusted settlement or provider idempotency design; unverified legacy grants/refresh rows, actual MFA/session/billing row effects | Do not enable paid or broad tenant workflows |
| High | Remaining provider paths, outbound controls, delivery retries and high-impact approvals unverified | Keep external integrations/delivery gated; no global safety claim |

## O. Operator actions required

1. Incident owner/DBA/identity owner: execute §D rotation, key preservation, restore and access review first; document issuer rejection of old credentials and controlled functionality of replacements. No credentials in evidence.
2. Release engineer: on an approved clean Node 22/npm runner with the pinned native Prisma engines and a **disposable local MySQL 8**, run normal install/generation and CI, verify DB connectivity, double migration apply and drift, tenant/billing negative and concurrent tests, and the UI through real HTTP. Repeat recovery and checksum verification against an authorized restored copy per `MIGRATION-RECOVERY-PLAN.md`.
3. Security/dependency owners: test remaining upgrade paths in isolation, including real controlled SMTP and credential-login behavior. Network/tenant owners approve webhook destinations; validate OAuth/download contracts and egress enforcement before enabling them. Never approve paid or live delivery just to make a test green.
4. Operations: rehearse rolling media writes, restart, release switch, rollback and restore with persistent shared paths/permissions. Confirm actual process name, port, DNS/TLS and health via separately authorized procedures. No live host was probed.

## P. Final release decision

**NO-GO.** Candidate code and isolated checks improved. Public credential revocation, data-key continuity, clean native delivery, live database invariants and host storage recovery remain unverified. No production change is authorized by this report.
