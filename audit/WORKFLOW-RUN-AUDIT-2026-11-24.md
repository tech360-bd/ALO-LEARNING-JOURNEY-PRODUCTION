# GitHub Actions and pull-request audit — 2026-11-24

## Scope and outcome

Audited all **115 Actions runs** returned for this repository at the start of the audit (UTC range **2026-10-16 through 2026-11-24**) and all **15 then-existing pull requests**. For each run, recorded metadata; for every failed/startup-failed run, checked its job and failed-step records and available check annotations. The complete 115-row inventory is [`workflow-runs-2026-11-24.csv`](./workflow-runs-2026-11-24.csv).

The current failures were **not all workflow-version problems**. The latest CI failures came from a database fallback bug in application code; that cause is fixed and the full GitHub CI workflow is green on the follow-up PR. The latest deployment preflight also exposed a stale Tailscale client pin, which has been aligned with the pinned action. The new Tailscale pin still requires a main-branch preflight to prove connectivity; repository secret values are not available to this audit.

## Run totals

| Workflow | Success | Failure | Startup failure | Cancelled | Skipped | Total |
|---|---:|---:|---:|---:|---:|---:|
| CI | 28 | 15 | 0 | 1 | 0 | 44 |
| Deploy to VPS | 12 | 13 | 0 | 0 | 0 | 25 |
| Run Datadog Synthetic tests | 0 | 2 | 0 | 0 | 42 | 44 |
| Historical workflow named `.github/workflows/deploy.yml` | 0 | 1 | 1 | 0 | 0 | 2 |
| **Total** | **40** | **31** | **1** | **1** | **42** | **115** |

The 42 Datadog skips are expected while the optional `DATADOG_SYNTHETICS_ENABLED` repository variable is not set to `true`; they are not passing synthetic tests. The one cancelled CI run (`43765787856`) is consistent with the workflow's cancel-obsolete-runs concurrency policy.

## Confirmed current CI defect and fix

Runs `45338217480` (PR #15), `45339006024` (main after PR #15), and the reusable validation job in `45339006085` all failed at **Tenant authentication and billing integration test**. The original check annotations only contained an exit code, and log retrieval returned EOF. PR #16 added an Actions annotation for the test stack; its first diagnostic run (`45400512381`) revealed:

```text
AssertionError: 500 !== 409
scripts/test-tenant-workflows.ts:38
```

The assertion exercises registration rollback: a second user with a different email but the same company name collides on the unique `MosCompany.slug`. The route correctly maps Prisma `P2002` to HTTP 409, but `src/lib/db.ts` classified every `PrismaClientKnownRequestError` and generic `Invalid prisma.*` message as a connectivity failure. In non-production test mode, the transaction wrapper therefore switched to the local JSON fallback instead of propagating the real MySQL constraint error to the route; registration returned 500.

**Fix in PR #16:** fallback now accepts Prisma initialization failures and explicit connection/configuration codes only. Constraint/validation failures such as `P2002` remain on MySQL. A regression test covers both cases. No fallback safety guard was weakened.

The full CI run `45401273670` passed after this fix. After the Tailscale YAML version update, CI run `45402151030` passed at code/workflow commit `f4dd141558847cc68477560bf9265b970f89a4c4`. The audit-inventory revision of PR #16 also passed in run `45403076219`. Across these runs, migrations, lint, typecheck, unit tests, tenant integration, media/photo-video checks, production build, and secret scan succeeded. PR #16 remains **open**, with CI green and Datadog skipped by design.

## Workflow and version audit

- Active workflows are `ci.yml`, `deploy.yml`, and `datadog-synthetics.yml`; the `.disabled` files are retired templates, not active workflows.
- Every external `uses:` reference in the active workflows has a version: `actions/checkout@v7`, `actions/setup-node@v5`, or a full commit SHA. The local reusable workflow reference (`./.github/workflows/ci.yml`) is intentionally versionless because it calls the workflow in the same revision. No missing action version was found.
- CI explicitly selects Node from `.node-version` (**22.20.0**); `package.json` permits Node 22 and `package-lock.json` is lockfile v3. `.nvmrc` contains `22` for local major-version selection; CI does not use it. Recent Actions runs successfully completed setup, install, Prisma, lint, and typecheck steps, so no missing Node setup explains the failures.
- Both Tailscale steps in `deploy.yml` overrode the pinned `tailscale/github-action` v4.4.0 default (**1.104.4**) with **1.94.2**. The pinned action metadata explicitly sets 1.104.4, and the corresponding Tailscale release exists (published 2026-10-28). PR #16 updates both explicit pins to 1.104.4. This is a verified version drift, although it is not yet proven to be the only reason the old client failed.
- The CI MySQL service uses the explicit `mysql:8.0` series tag; no run evidence implicated that image version, and the current MySQL migration and schema checks pass. I did not guess a patch/digest pin.

## Deployment and external configuration

- In the latest deploy run (`45339006085`), the missing-secrets preflight **passed**, then Tailscale connect failed with repeated `sudo failed with exit code 1`; deploy was skipped. This differs from the older deploy failures where the preflight explicitly reported missing secrets.
- Eight historical runs failed the fail-closed missing-secrets check: `45326386372`, `45322593042`, `42645408769`, `42641297686`, `42637315888`, `40438245149`, `40304292003`, and `38956588905`. The names varied by run; earlier messages included missing Tailscale OAuth and SSH host-key secrets. Do not weaken this gate.
- The new Tailscale client pin has only been exercised by PR CI, which does not run the main-only network preflight. The preflight must be rechecked after PR #16 lands. If it still fails, an administrator needs to verify the OAuth client ID/secret, `auth_keys` scope, permission for `tag:github-runner`, and the configured tailnet destination. Secret values were neither retrieved nor changed.

## Historical failures reviewed

- Older unit/rollback failures occurred in `45326386385`, `45326288727`, `45322592937`, `45322308178`, `44252760934`, and `43801867269` (with corresponding deploy validation failures in `45326386372`, `45322593042`, `44252760941`, and `43801867328`). Later CI revisions, including the green PR #16 run, pass those checks.
- Lint failures in `43760692892`, `43759505951`, `43760692872`, and `43759505995` reported `Expected an assignment or function call and instead saw an expression`; they are historical and lint now passes.
- Migration/schema failures included drift at `42965766847` and MySQL migration errors at `42965084436` / `42964542320`. The available migration annotation at `42965084436` identified `KnowledgeNode.companyId` as incompatible with a `SET NULL` foreign key. Current CI verifies the migration contract, applies migrations twice, and passes schema drift checks.
- Run `42890155769` failed dependency installation and secret scanning on an older dependency-update commit. The available annotation set did not give enough detail to safely attribute both failures; no current reproduction appears in the green PR #16 run.
- `42890155637`, `42890305884`, `42637195116`, and `42637194882` had no job records/annotations, so their cause cannot be established from Actions metadata. The two `.github/workflows/deploy.yml` runs are historical; the current named workflow is active and executing.
- Datadog run `38956588779` explicitly failed because API/App keys were missing. The current workflow is opt-in, checks both keys and approved test IDs before invoking the pinned action, and otherwise skips as intended.

## Pull-request audit

All 15 PRs present at the snapshot were merged. Their check history was reviewed; Datadog was skipped on PRs where the opt-in variable was off.

- **PRs #1 and #3–#12:** CI validation passed.
- **PR #2:** no check rollup was attached; its related CI and Datadog runs had no job records, so a pass cannot be claimed.
- **PRs #13–#15:** validation failed at the PR head while the independent secret-scan jobs passed. #13/#14 failed in the combined unit/rollback step; #15 failed in tenant integration. These PRs were merged with failing validation checks, and the same failures appeared on main. Keep the required CI validation green before merging future PRs.
- **PR #16:** open from the current Arena branch. The code/workflow fix passed CI in `45402151030`; the audit-inventory revision passed CI and secret scan in `45403076219`. Datadog is skipped by design. [PR #16](https://github.com/tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION/pull/16).

## Separate dependency-audit warning

A local `npm audit` during this review reported **13 advisories (6 high, 7 moderate, 0 critical)**. Findings include Prisma/@prisma-config dependency paths and Nodemailer, with some suggested fixes requiring major upgrades (Prisma 7 and Nodemailer 10); this is not what caused the Actions run failures. No dependency-wide `npm audit fix` was applied because it would cross the repository's deliberately blocked major-version upgrades and needs its own compatibility review.

## Remaining acceptance check

PR #16 is ready for review and its CI is green, but it is not merged. A green main-branch `Deploy to VPS` network preflight after the Tailscale version change remains the outstanding verification. If the next preflight still fails, the remaining issue is likely external Tailscale credentials/ACL configuration; the actual secrets cannot be inspected here.
