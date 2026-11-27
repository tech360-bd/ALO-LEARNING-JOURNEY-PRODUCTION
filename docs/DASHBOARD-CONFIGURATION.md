# Changing configuration from the dashboard (no SSH, no terminal)

Mission E. Once the project is live, an environment variable, an API key or an
SMTP setting must be changeable **from the Super Admin dashboard of this same
deployment** — not by SSH-ing into the VPS and editing a file.

## Where it is

`Super Admin -> right panel -> Configuration` (below *Self-Healing*, above
*Pending approvals*). The panel is a grouped list: **AI providers, Messaging,
Storage, Security, Runtime**. Each row shows

| Column | Meaning |
| --- | --- |
| Label + env name | the setting, and the exact variable it maps to |
| source badge | `environment` / `dashboard` / `default` / `unset` |
| effective value | the value in force; secrets are always `****abcd` |
| input | hidden for `environment`-sourced rows (a dashboard value cannot win) |
| "Takes effect after a restart" | shown when the value is read once at boot |

Save writes only what changed. The response reports, per setting, `ok`,
`masked` (for secrets) and `restartRequired`; if anything needs a restart the
panel prints the exact command. **The panel never executes it.**

API behind it (owner-only, `requireOwner`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/super-admin/config` | grouped list, masked values, sources |
| `POST` | `/api/super-admin/config` | `{ values: { NAME: value \| null } }`, max 20 per call |
| `HEAD` | `/api/super-admin/config?probe=NAME` | is it set, and where from (`x-alo-source`) — never the value |

## The rules it cannot break

1. **Allowlist, not arbitrary env injection.** `CONFIG_FIELDS` in
   `src/lib/runtime-config.ts` is the complete list (~35 names). `NODE_OPTIONS`,
   `LD_PRELOAD`, `PATH`, `ALO_CUSTOM_AI_PROVIDERS_JSON` and anything else are
   rejected with `not an allowlisted setting`. This keeps the earlier decision
   intact: gateways/providers are configured by *known* variables only, so a
   dashboard user cannot turn this into remote code execution or an arbitrary
   proxy.
2. **Real environment always wins.** If `SMTP_PORT` is exported by PM2, the row
   shows `environment` and its input is disabled. The file is a fallback, never
   an override, so a service-manager value can never be silently shadowed.
3. **Secrets are encrypted at rest and never echoed.** Values of kind `secret`
   go through `src/lib/vault.ts` (AES-256-GCM) before being written; the API
   returns `****` plus the last four characters. Reading a secret back in
   plaintext is not implemented anywhere — not even for the owner.
4. **Atomic, private writes.** `write-then-rename` with mode `0600`, so a crash
   mid-save cannot leave a truncated config and no other system user can read
   the file.
5. **A file, not a database row.** These values configure the database, the mail
   transport and the vault itself; storing them in MySQL would create a
   bootstrapping cycle.
6. **"Restart required" is reported, not hidden.** `DATABASE_URL`,
   `NEXTAUTH_SECRET`, `VAULT_MASTER_KEY`, `ADMIN_*` and `ALO_MEDIA_DIR` are read
   once at boot, so the panel says so and gives
   `pm2 restart learn --update-env && pm2 save`.
7. **Present is not the same as working.** The panel reports the *source* of a
   key. Whether the key authenticates is decided by the provider status route,
   not asserted by the config panel.

## Where the values are picked up

`primeRuntimeConfig()` reads the file once per request; `runtimeEnvSync()` (used
inside the synchronous payment guard and provider helpers) falls back to a
one-off synchronous read when the cache is cold, so a route that never awaited
the prime still honours dashboard values. Primed at:

- `src/app/api/ai/chat/route.ts` (chat chain)
- `src/app/api/ai/local-status/route.ts` (status the UI shows)
- `src/app/api/super-admin/providers/route.ts` (owner's provider status)
- `src/lib/omni/router.ts` -> `routeChat()` (every routing call)
- `src/app/api/super-admin/config/route.ts` (its own reads/writes)

The AI policy is unchanged: local Ollama first, external providers only after
**both** `ALO_PAID_AI_API_ALLOWED` and `ALO_OWNER_APPROVED_PAID_AI_API`, free
models only for free-tier providers, no student/family data ever sent out.
Those two switches are editable from the dashboard, and clearing either one
takes effect immediately.

## What the live check proved (local production build, port 3061)

| Check | Result |
| --- | --- |
| `GET /api/super-admin/config` without a session | `401` |
| Save `GROQ_API_KEY`, `GROQ_MODEL`, `SMTP_PORT` | `200`, key masked `****3a2b`, port `2525` |
| `GET` afterwards | `source: dashboard`, plaintext absent from the payload |
| File on disk | mode `0600`, key present only as a `{cipher}` envelope |
| `HEAD ?probe=GROQ_API_KEY` | `200`, `x-alo-source: dashboard` |
| Save `NODE_OPTIONS` | `400`, `not an allowlisted setting` |
| Both owner switches on | `external.enabled: true`, `groq: configured` |
| Clear switch 2 | `external.enabled: false` |

## Verification

```bash
node --experimental-strip-types --import ./tests/ts-alias-loader.mjs \
  --test tests/runtime-config.test.mjs     # 9 tests
```

Tests use a `mkdtemp` config path and a throwaway `VAULT_MASTER_KEY`. They
assert the file mode, that the plaintext never reaches disk, env-beats-dashboard,
refusal of non-allowlisted names, numeric/URL/boolean/placeholder validation,
fall-back-to-default on clear, the fail-closed path for a tampered envelope, and
the cold-cache synchronous read.

## Known limits

- **Rotating `VAULT_MASTER_KEY` needs a restart** — the vault caches the master
  key per process, so the panel reports `restartRequired` and the stored secrets
  have to be re-entered.
- **A dashboard key does not prove the account works.** Set the key, then check
  *Providers* for `configured`/`ready`.
- **No file upload.** Anything that is a path (certificates, media dir) is a
  plain string setting, not a browser upload.
