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

### 1. `Deploy to VPS` failed on every merge to `main` — fixed

`network-preflight` is a **fail-closed** job: its third step exits when the
Tailscale/SSH secrets are absent. Its own comment claimed it ran *"only once the
readiness switch is on"*, but the `if:` also matched every push — and unlike the
first assumption in this audit, `vars.VPS_DEPLOY_ENABLED` really **is** `'true'`:
the job runs on every push (so `network-preflight` passed its `if:`), while
`deploy` is `skipped` (it also needs the `verify` job and the approval gate). The
secrets are the part that is missing, so the job died in *Fail closed if
networking secrets are missing* on every merge:

| Run | Date | Failing step |
| --- | --- | --- |
| 45963030024 | 2026-11-27 | Fail closed if networking secrets are missing |
| 45958367979 | 2026-11-27 | same |
| 45953077679 | 2026-11-27 | same |
| 45910557693 | 2026-11-26 | same |
| 45892763352 | 2026-11-26 | same |
| 45882882574 | 2026-11-26 | *Join tailnet (explicit, full error output)* |

The switch means *"a deployment is wanted"*. It never meant *"this repository can
authenticate"*. Two changes make the two questions separate:

1. A read-only **`Classify deployment readiness`** step (`id: readiness` — the
   **first step after checkout**, because a step cannot read an output that a
   later step produces; run 45964504678 was red for exactly that reason) asks
   whether the OAuth pair, the host and the pinned SSH material are all present,
   and writes `ready=true|false` to `$GITHUB_OUTPUT`. When they are absent it
   writes the exact missing list to the **job summary** and the run continues.
2. Every Tailscale/SSH step is gated on `steps.readiness.outputs.ready == 'true'`,
   so an unconfigured repository is reported as **skipped-until-configured**, not
   as a deployment failure. A merge to `main` therefore stops showing a red
   `Deploy to VPS` that deployed nothing.

Fail-closed is unchanged where it matters: a credential that is **present but
malformed** still fails hard (a `tskey-` auth key instead of an OAuth client, a
too-short pair, a malformed host key), and **`workflow_dispatch` with
`mode=deploy` still fails loudly** — a human who explicitly asked for a
deployment must never get a silent skip. `deploy` still requires the switch, the
`production` approval and a green `verify`.

The step graph was also replayed locally for the four cases that matter:

| Case | Expected | Result |
| --- | --- | --- |
| switch on, secrets absent (today) | preflight skipped, job green | `RESULT: network-preflight green` |
| `workflow_dispatch mode=deploy`, secrets absent | hard failure | fails in *Classify deployment readiness* |
| secrets present but `tskey-` / too short | hard failure | fails in *Fail closed if networking secrets are missing* |
| full OAuth pair + host + SSH material | network steps run | reaches *Tailscale connect* |

Pinned by four tests, including the ordering one: *the readiness classifier runs
before every step that reads its output* and *the fail-closed
malformed-credential guard cannot fire before readiness*.

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

## The last red run, diagnosed from its own annotations

After the ordering fix, run **45965932281** (merge of #45) reached the guard — and
the guard was right:

```
notice:  credentials present — running the network preflight
notice:  OAuth client id looks like a Tailscale client id
notice:  oauth-client-id-length=17 oauth-secret-length=17 auth-key-length=62
failure: the OAuth pair looks too short (client id 17, secret 17)
```

So the secrets **exist** but are **placeholders**: a 17-character client id and a
17-character secret, where a real Tailscale OAuth client id is 20+ characters
(tailscale IDs end in `CNTRL`) and the secret is 40+. The join would fail with
`invalid key`; the guard stops before that and says why. Nothing in code can fix a
placeholder — only the owner can paste the real OAuth client.

Two improvements came out of that run:

- The message now names the exact shape ("client id 17 chars, secret 17 chars; a
  real client id is 20+ and the secret 40+"), links the OAuth page and the
  required scopes/tag, and the threshold was raised from 10/20 to 20/40
  characters so a placeholder cannot look "long enough".
- *Network evidence* no longer runs when the join was refused. Previously it
  reported `peers=0 / tcp:closed / ssh: connect timed out` while the runner had
  never joined, which reads like a network outage. It now says plainly that the
  pair is a placeholder and there is no evidence to collect.

## What still needs a human

1. **`vars.VPS_DEPLOY_ENABLED` is `'true'` and the deploy secrets are
   placeholders, not real credentials** (client id and secret both 17
   characters — see the run above). That is why the preflight used to fail (see §1) and why `deploy` is
   still `skipped`. To actually deploy, add (they cannot be read by this token,
   which is why their absence is inferred from the step that fails):
   `TAILSCALE_OAUTH_CLIENT_ID` + `TAILSCALE_OAUTH_SECRET` (OAuth client, not a
   `tskey-` auth key), `SERVER_HOST`/`VPS_USER`/`VPS_SSH_KEY`/`VPS_SSH_HOST_KEY`,
   and required reviewers on the `production` environment.
2. **Branch protection / required checks** are not readable with this token
   (`403`). If a rule elsewhere requires `Lint + Typecheck + Unit tests`,
   `Repository hygiene`, `PostgreSQL integration` or `verified release`, it must
   be renamed to one of the real jobs above — no workflow in this repository
   provides those names.
