# Health 503 → 200: server runbook (2026-11-26)

The live probe returned:

```json
{"status":"unhealthy","legacyStatus":"PARTIAL","httpStatus":503,"checkedAt":"…","releaseSha":"unknown"}
```

Two independent causes were found in the code and fixed in PR #35. Everything
below is the part that must run **on the VPS**, because this repository has no
SSH access or network path to `alo-server-lap`.

## Why it was 503 (and how it now reports)

`/api/health` returns 503 only when a **critical** check fails. Before the fix,
`status` could never be `"ok"` unless *every* check passed, including optional
ones — so a server without `SMTP_PASS`, without a whisper daemon, or without an
AI provider was reported as `unhealthy/503` even though it served every route.
The probe now distinguishes:

| Condition | status | HTTP |
| --- | --- | --- |
| every check green | `healthy` | 200 |
| an optional feature unconfigured (SMTP, ASR daemon, AI provider) | `degraded` | **200** |
| a critical dependency missing (MySQL/Prisma, admin auth in production) | `unhealthy` | 503 |

`deploy/health-check.sh` and the deploy workflow accept `healthy`, `degraded`
and the legacy `ok`, and still require `releaseSha` to equal the released commit.

## Step 0 — find the exact cause in one request

After deploying this branch, sign in and call the diagnostic:

```bash
# on the VPS
curl -sS -b "next-auth.session-token=$(…)" http://127.0.0.1:3061/api/health/diagnose | jq .
```

Or, unauthenticated, only while admin auth is still unconfigured (that is the
window where an operator has no session at all):

```bash
curl -sS http://127.0.0.1:3061/api/health/diagnose | jq '.summary, .findings[] | select(.ok == false)'
```

It reports, per area, `ok` + a one-line fix, and **never** a secret or a full
DSN. Expected shapes:

- `MySQL / Prisma: production requires a MySQL DATABASE_URL`
  → `DATABASE_URL` is not in the process environment (PM2 env or
  `.next/standalone/.env`).
- `MySQL / Prisma: … did not initialize yet` with `fix: Prisma client not
  generated` → `prisma generate` never ran for this build.
- `MySQL / Prisma: … Access denied / Unknown database / ECONNREFUSED` → the DSN
  is reachable but wrong; the message says which.
- `Administrator authentication: not usable; passwordHash=interpolated` → the
  `.env` hash lost its `$` separators (see `docs/VERIFICATION-2026-11-26-PROD-SWEEP.md`).
- `Release SHA: RELEASE_SHA is not set…` → `releaseSha` was `"unknown"`.

## Step 1 — deploy the fix

```bash
cd /home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION
git fetch origin main && git log --oneline -1 origin/main      # expect the PR #35 merge
EXPECTED_SHA="$(git rev-parse origin/main)"
bash scripts/deploy-production.sh "$EXPECTED_SHA"              # existing rehearsed path
```

The build now writes `.next/standalone/RELEASE_SHA` (see
`scripts/write-release-sha.mjs`), so `releaseSha` is correct even if the PM2
environment is lost.

## Step 2 — make the environment true

```bash
# 1. The database URL must be present in the process environment.
pm2 env 0 | grep -c '^DATABASE_URL='        # 0 means missing → this is the 503
```

Set it in **one** place and keep it there. The PM2 file is a template with
redacted secrets, so the server-side `.env` is authoritative:

```bash
# /home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION/.next/standalone/.env
# mysql://learn_app_user:<password>@127.0.0.1:3306/db_learn
grep -c '^DATABASE_URL=' .next/standalone/.env
```

Note the database name disagreement below before changing anything.

```bash
# 2. Admin sign-in without SMS (owner decision).
grep -E '^ADMIN_(EMAIL|OTP_REQUIRED)=' .next/standalone/.env
# ADMIN_OTP_REQUIRED=false  → no HTTPSMS_* variables are needed.

# 3. The hash must be the ESCAPED form if it lives in .env:
#    ADMIN_PASSWORD_HASH=scrypt\$…\$…
grep -c 'ADMIN_PASSWORD_HASH=scrypt\\\$' .next/standalone/.env   # 1 = correct

# 4. MarketingOS secrets (needed by /dashboard, not by the health probe).
grep -cE '^JWT_SECRET=.{32,}' .next/standalone/.env
grep -c '^VAULT_MASTER_KEY=' .next/standalone/.env
```

Then reload **with** the environment:

```bash
pm2 restart learn --update-env && pm2 save
```

## Step 3 — verify (the mission's gate)

The scripted version of this step is one command, and it is what the deploy gate
should be read from:

```bash
cd /home/user/ALO-LEARNING-JOURNEY-PRODUCTION
ADMIN_EMAIL="…" ADMIN_PASSWORD="…" npm run verify:live -- --url=https://learn.alolabs.net --jar=/tmp/alo.jar
```

Save the `--jar`. It makes the authenticated steps below a plain `curl -b`, with
no CSRF dance and no copied token:

```bash
curl -sS -b /tmp/alo.jar https://learn.alolabs.net/api/health/diagnose | jq '.summary, .findings[]|select(.ok==false)'
curl -sS -b /tmp/alo.jar 'https://learn.alolabs.net/api/health?details=1' | jq '.checks[]|select(.ok==false)'
rm -f /tmp/alo.jar          # it is a live admin session; delete it when done
```

> **The jar must be captured over the scheme the browser uses.** In production
> `src/lib/auth.ts` mints a `__Secure-next-auth.session-token` with `secure: true`,
> and curl will not send a Secure cookie over plain `http`. So
> `--url=http://127.0.0.1:3061 --jar=…` is refused on purpose (the check says why)
> — use the https origin. If you only have the local port, put a TLS terminator in
> front of it, e.g. `ssh -L 8443:127.0.0.1:3061` through the tunnel that already
> serves the domain, and run with `--url=https://127.0.0.1:8443`.

It exits 0 only when `/api/health` is 200 with a real 40-hex `releaseSha`, and —
when credentials are supplied — when the sign-in produced a session that an
owner-only route actually accepts. `degraded` passes by contract; `unhealthy`
does not. On a failure it prints the containing fix command. (Passwords are read
from the environment or an interactive prompt and are never echoed.)

The equivalent by hand:

```bash
# local
curl -sS -i http://127.0.0.1:3061/api/health

# public
curl -sS https://learn.alolabs.net/api/health | jq .
curl -sS -o /dev/null -w '%{http_code}\n' https://learn.alolabs.net/login

# release identity must be the deployed commit, not "unknown"
curl -sS http://127.0.0.1:3061/api/health | jq -r '.releaseSha'
git rev-parse origin/main

# admin sign-in (no OTP) — expect 200 + a session cookie
curl -sS -c /tmp/jar -o /dev/null http://127.0.0.1:3061/api/auth/csrf
CSRF="$(curl -sS -b /tmp/jar -c /tmp/jar http://127.0.0.1:3061/api/auth/csrf | jq -r .csrfToken)"
curl -sS -b /tmp/jar -c /tmp/jar -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:3061/api/auth/callback/credentials \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=$ADMIN_EMAIL" \
  --data-urlencode "password=$ADMIN_PASSWORD" --data 'json=true'
curl -sS -b /tmp/jar http://127.0.0.1:3061/api/auth/session | jq .role
```

`status` must be `healthy` (or `degraded` with only SMTP/ASR/AI in
`failedOptional`), HTTP 200, and `releaseSha` equal to the deployed commit.

## Step 4 — the one schema question to settle first

`prisma/schema.prisma` migrations, `scripts/deploy-production.sh` and
`deploy/backup.sh` reference **`db_learn`**, while
`ecosystem.learn.config.cjs` carries `learn_aloeducation` in its redacted
template. Only one database holds the real data. Before touching
`DATABASE_URL`:

```bash
mysql -e 'SHOW DATABASES;'
mysql -e 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema="db_learn";'
mysql -e 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema="learn_aloeducation";'
```

Point `DATABASE_URL` at the one with the tables **and** the row counts you
expect. Do not run `prisma migrate reset`, `db push --force-reset`, or a
migration against the wrong schema — see `MIGRATION-RECOVERY-PLAN.md`.

## If it is still not 200

1. `curl -sS http://127.0.0.1:3061/api/health/diagnose | jq '.summary'` — the
   `blocking` array names the failing area.
2. `pm2 logs learn --lines 120 --nostream | grep -i prisma` — the raw error
   (credentials in it are redacted by the diagnostic, not by PM2).
3. `pm2 env 0 | grep -cE '^(DATABASE_URL|NEXTAUTH_SECRET|ADMIN_EMAIL)='` — a
   count of 3 means the process really has the variables.
4. `node -e 'console.log(process.version)'` and
   `ls node_modules/@prisma/engines` — a missing engine binary is reported as
   such by the diagnostic.
