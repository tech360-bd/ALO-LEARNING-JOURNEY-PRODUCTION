# `.github/workflows` — what each file does, and what was wrong with it

Everything in this directory was audited file by file against the **runs that
actually happened** on `tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION`
(196 commits, 109 CI runs, 57 `Deploy to VPS` runs, 109 Datadog runs).

## The five files

| File | State | Runs on | Jobs |
| --- | --- | --- | --- |
| `ci.yml` | **active** | PR → `main`, push → `main`, and `workflow_call` from `deploy.yml` | `validate`, `security-scan` |
| `deploy.yml` | **active**, every job gated | push → `main`, `workflow_dispatch` | `verify` (calls `ci.yml`), `network-preflight`, `deploy` |
| `datadog-synthetics.yml` | active but **disabled by default** | PR/push → `main` | `build`, skipped unless `vars.DATADOG_SYNTHETICS_ENABLED == 'true'` |
| `deploy.yml.disabled` | retired template | never | — (a `.disabled` suffix is not a workflow) |
| `docker.yml.disabled` | retired template | never | — |

`deploy.yml.disabled` / `docker.yml.disabled` are kept as documented tombstones,
not as dead code: they explain that ALO deploys as a Next.js standalone build
under PM2 (port 3061), not as a container, and that renaming them would create a
second competing deploy path.

## Job names this repository's gates depend on

A required status check that names a job the workflow no longer has can **never
turn green**. So the names are a contract, checked by
`scripts/validate-workflows.mjs` (`KNOWN_JOBS`) and by
`tests/workflows.test.mjs`:

| File | Required job ids |
| --- | --- |
| `ci.yml` | `validate`, `security-scan` |
| `deploy.yml` | `verify`, `network-preflight`, `deploy` |
| `datadog-synthetics.yml` | `build` |

If a gate somewhere asks for **`Lint + Typecheck + Unit tests`**,
**`Repository hygiene`**, **`PostgreSQL integration`** or **`verified release`**,
none of those exist in this repository — not on `main`, not in any of the 33
branches (including the parent fork `alaminiubateee969-cmd/…`), and not anywhere
in the history of `.github/`. The equivalents here are:

| A gate naming … | The check that really exists here |
| --- | --- |
| `Lint + Typecheck + Unit tests` | `CI / validate` — steps *Lint*, *Typecheck*, *Unit tests* |
| `Repository hygiene` | `CI / Secret scan` (secret scan + no tracked database file) and the step *Validate workflow files* |
| `PostgreSQL integration` | not applicable — this application is **MySQL only** (Prisma + MySQL 8 service container); a PostgreSQL job would test a database the product never runs on |
| `verified release` | `Deploy to VPS / deploy` — exact-SHA build, `releaseSha` must equal `${{ github.sha }}` on `/api/health`, plus `npm run verify:live` / `scripts/verification/smoke-standalone.mjs` |

Adding the four names above as no-op jobs was considered and rejected: a job
that exists only to make a check green is the fake success this project forbids.
`main` is at `b51de2a` with every real job green except `network-preflight`,
whose cause is fixed below.

## What was broken (and is now fixed)

### 1. `Deploy to VPS` failed on every merge to `main`

`network-preflight` is a **fail-closed** job: its third step exits when the
Tailscale/SSH secrets are absent. Its own comment claimed it ran *"only once the
readiness switch is on"*, but the `if:` also matched every push:

```yaml
# before — preflight ran on every push, with deployment switched off
if: github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || vars.VPS_DEPLOY_ENABLED == 'true')
```

`vars.VPS_DEPLOY_ENABLED` is unset in this fork (the API token cannot read
variables, but the job footprint proves it: the switch is what gates `deploy`,
and `deploy` has been `skipped` in all 57 runs while `network-preflight` failed in
each). So every merge produced a red `Deploy to VPS` run:

| Run | Date | Failing job | Failing step |
| --- | --- | --- | --- |
| 45958367979 | 2026-11-27 | `network-preflight` | *Fail closed if networking secrets are missing* |
| 45953077679 | 2026-11-27 | `network-preflight` | same |
| 45910557693 | 2026-11-26 | `network-preflight` | same |
| 45892763352 | 2026-11-26 | `network-preflight` | same |
| 45882882574 | 2026-11-26 | `network-preflight` | *Join tailnet (explicit, full error output)* |

Fix: the preflight now requires the switch on an automatic push, and still
always runs when a human dispatches it. Nothing about the deploy path's safety
changed — `deploy` still requires `VPS_DEPLOY_ENABLED`, the `production`
environment approval, and a green `verify`. The regression is pinned by a test
(`a merge with deployment switched off cannot produce a red preflight`).

### 2. The standalone smoke test was silently mis-wired

`scripts/verification/smoke-standalone.mjs` spawns the built server with a
hand-written `env:` block. It forwarded `PATH`, `NODE_ENV`, `PORT`, `HOSTNAME` —
and **dropped every credential**, even though the script itself reads
`SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` to sign in. The parent process had
them; the child never did. Measured before the fix: **6/13 probes passed**,
with `POST /api/auth/callback/credentials … session email=<none>`.

Fix: the child inherits the documented environment (`ADMIN_*`, `NEXTAUTH_*`,
`DATABASE_URL`, `ALO_*`, `VAULT_*`, provider keys, `RELEASE_SHA`), and the smoke
now also fails when the built `RELEASE_SHA` marker does not match the checked-out
commit (a stale `.next` used to pass silently). Measured after the fix: **14/14**.

CI runs it in `validate` after *Verify standalone output*:

| Probe | Result |
| --- | --- |
| `GET /api/health` | accepted as `200 healthy/degraded` **or** a truthful `503 unhealthy` (`SMOKE_HEALTH_EXPECT=honest`) — never a 500, never a fake "healthy" |
| `health carries a real release SHA` | 40-hex SHA present |
| `release SHA matches the checked-out commit` | `RELEASE_SHA=$GITHUB_SHA` |
| `GET /login` | 200 |
| credentials sign-in | session email + role |
| `/api/health/diagnose`, `/api/approvals` | owner session works; 401 without one |
| `/api/ai/voice` (bn), `/api/video/from-photo` | real artefacts produced offline |
| `/api/ai/chat`, `/api/asr-transcribe` | honest non-500 answers when Ollama/whisper are absent |

The throwaway admin password and session secret are **generated per run**
(`crypto.randomBytes`); a literal credential in a workflow file is a finding for
`scripts/scan-secrets.mjs`, and the scanner confirmed it.

### 3. Nothing checked the workflow files themselves

A wrong action major (`setup-node@v2`), a renamed required job, or a
`workflow_dispatch` input that no `if:` reads fails in a way that looks like an
infrastructure flake. `scripts/validate-workflows.mjs` now fails on:

- a required job name missing from its file (`KNOWN_JOBS`);
- an action pinned to a version that does not exist or to a moving branch;
- a `workflow_dispatch` input nothing reads;
- a job without `runs-on` (and not a reusable `uses:` call), or a step with
  neither `uses` nor `run`.

It runs in `CI / Secret scan` (*Validate workflow files*) and in
`npm run verify`, and `tests/workflows.test.mjs` (16 tests) feeds it deliberately
broken workflows so the rules cannot rot. Audit-only warnings that stay
visible: `actions/checkout@v7` / `actions/setup-node@v5` are major tags, not
SHAs — pinning them to SHAs is a follow-up, and the two occurrences of each are
kept identical so they cannot drift apart.

### 4. `datadog-synthetics.yml` is off, and stays off

The job is skipped unless the repository variable `DATADOG_SYNTHETICS_ENABLED`
is `'true'`, and then requires the *Test IDs variable* and both API keys. It is
a **paid** third-party service: per the standing cost rule it must not be
switched on without explicit owner approval. Verified: all 109 runs are
`skipped`.

## Version facts used here

| Thing | Value | Source |
| --- | --- | --- |
| Node in CI | from `.node-version` (22.20.0) | `actions/setup-node` `node-version-file` |
| `actions/checkout` | `v7` (latest release `v7.0.1`) | GitHub API |
| `actions/setup-node` | `v5` (latest release `v7.1.0`; v5 still published) | GitHub API |
| `tailscale/github-action` | `064b1055…` = `v4.4.0` | GitHub API |
| `DataDog/synthetics-ci-github-action` | `703985…` = `v4.1.1`, inputs `api-key`/`app-key`/`public-ids`/`fail-on-missing-tests`/`variables` | action.yml at that SHA |
| App version | `0.2.1` (`package.json`) — a candidate, never a release tag | `Record candidate version` step |
| Release identity | the exact commit SHA (`RELEASE_SHA`) | `scripts/write-release-sha.mjs` |

## Reproducing the audit locally

```bash
npm run verify            # typecheck + lint + unit tests + workflow validation
node scripts/validate-workflows.mjs                      # 3 files, 0 errors
node --test tests/workflows.test.mjs                     # 16 tests
RELEASE_SHA=$(git rev-parse HEAD) npm run build
SMOKE_PORT=3096 SMOKE_HEALTH_EXPECT=honest SMOKE_EXPECT_AUTH=1 \
  SMOKE_ADMIN_EMAIL=owner@alolabs.net SMOKE_ADMIN_PASSWORD='…' \
  ADMIN_EMAIL=owner@alolabs.net ADMIN_PASSWORD_HASH="$(printf '%s' '…' | node scripts/hash-admin-password.mjs | tail -n1)" \
  NEXTAUTH_SECRET=… node scripts/verification/smoke-standalone.mjs   # 14/14
```

## What still needs a human

1. **`vars.VPS_DEPLOY_ENABLED` is unset**, so production deploys are skipped by
   design. Turning it on is a separate decision; the workflow then requires
   `TAILSCALE_OAUTH_CLIENT_ID` + `TAILSCALE_OAUTH_SECRET` (OAuth client, not a
   `tskey-` auth key), `SERVER_HOST`/`VPS_USER`/`VPS_SSH_KEY`/`VPS_SSH_HOST_KEY`,
   and required reviewers on the `production` environment.
2. **Branch protection / required checks** are not readable with this token
   (`403`). If a rule elsewhere requires `Lint + Typecheck + Unit tests`,
   `Repository hygiene`, `PostgreSQL integration` or `verified release`, it must
   be renamed to one of the real jobs above — no workflow in this repository
   provides those names.
