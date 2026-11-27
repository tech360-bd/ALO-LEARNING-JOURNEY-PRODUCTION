# Local-first stack — every feature at $0, on our own box

**Policy:** no paid external service. `ALO_MONID_ENABLED=false`,
`ALO_PAID_AI_API_ALLOWED=false`, `ALO_OWNER_APPROVED_PAID_AI_API=false`,
`MONID_API_KEY` unset. Everything below runs on `alo-server-lap`.

This page is the operator's runbook: what to install, what to set, and how to
verify each piece without guessing.

---

## 1. Web search + page extraction (replaces paid Exa / Monid `run`)

| Order | Backend | Default address | Cost |
| --- | --- | --- | --- |
| 1 | SearXNG | `http://127.0.0.1:8080` | $0 |
| 2 | Wigolo | `http://127.0.0.1:3847` | $0 |
| 3 | DuckDuckGo HTML | (public) | $0, **off by default** |
| extract 1 | Crawl4AI | `http://127.0.0.1:11235` | $0 |
| extract 2 | **built-in native extractor** | in-repo | $0, always available |

Code: `src/lib/local-web-search.ts`. Routes: `POST /api/tools/web-search`
(owner), `POST /api/scraper` with `{"mode":"full"}` (existing API, now local).

```bash
# SearXNG (docker is the least fuss; a native install works too)
docker run -d --name searxng --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -v /opt/alo/searxng:/etc/searxng searxng/searxng:latest
# JSON must be enabled in /opt/alo/searxng/settings.yml:
#   search: { formats: [html, json] }
curl -s "http://127.0.0.1:8080/search?q=test&format=json" | head -c 200

# Crawl4AI (optional — the native extractor already works without it)
docker run -d --name crawl4ai --restart unless-stopped -p 127.0.0.1:11235:11235 \
  unclecode/crawl4ai:latest
```

Env (already in `ecosystem.learn.config.cjs`):

```ini
SEARXNG_BASE_URL=http://127.0.0.1:8080
WIGOLO_BASE_URL=http://127.0.0.1:3847
CRAWL4AI_BASE_URL=http://127.0.0.1:11235
LOCAL_SEARCH_DDG_FALLBACK=false
```

**Verify:** `curl -s -X POST http://127.0.0.1:3061/api/tools/web-search`
needs an admin session; without one, check the backends directly:

```bash
curl -s "http://127.0.0.1:8080/search?q=bangla&format=json" | head -c 200
curl -s http://127.0.0.1:11235/health
```

A backend being down is reported per backend (`skipped[].reason`) — the request
does not fail while another backend can still answer.

---

## 2. Local ASR (Bengali + English) — `faster-whisper`

`scripts/services/faster_whisper_server.py` implements the exact protocol
`/api/asr-transcribe` and `/api/v1/asr` already call (`POST /transcribe`).

```bash
python3 -m venv /opt/alo/venv && /opt/alo/venv/bin/pip install -U pip
/opt/alo/venv/bin/pip install "faster-whisper==1.0.3" fastapi uvicorn

# CPU int8, Bengal-aware default model. Start small on a 2-vCPU box:
/opt/alo/venv/bin/python scripts/services/faster_whisper_server.py \
  --port 8787 --model small --language bn
```

Env:

```ini
FASTER_WHISPER_URL=http://127.0.0.1:8787
WHISPER_MODEL=small          # medium = better Bangla, ~2.5x slower on CPU
WHISPER_COMPUTE_TYPE=int8
WHISPER_LANGUAGE=bn
```

Keep it alive with PM2 (same supervisor as the app):

```bash
pm2 start /opt/alo/venv/bin/python \
  --name alo-asr --interpreter none -- \
  scripts/services/faster_whisper_server.py --port 8787 --model small
pm2 save
```

**Verify:** `curl -s http://127.0.0.1:8787/health` →
`{"ok":true,"model":"small","paid":false,"usdPerMinute":0}`. A missing model is a
`503`, never invented text.

---

## 3. Local TTS (Piper) — `bn_BD-google-medium`, `en_US-lessac-medium`

`scripts/services/piper_server.py` serves the contract
`src/lib/local-audio.ts` calls (`POST /synthesize` → `audio/wav`).

```bash
/opt/alo/venv/bin/pip install piper-tts fastapi uvicorn
mkdir -p /opt/alo/models/piper
/opt/alo/venv/bin/python scripts/services/piper_server.py --port 8788 \
  --model-dir /opt/alo/models/piper \
  --preload bn_BD-google-medium,en_US-lessac-medium
```

Env: `PIPER_BASE_URL=http://127.0.0.1:8788`

PM2:

```bash
pm2 start /opt/alo/venv/bin/python --name alo-tts --interpreter none -- \
  scripts/services/piper_server.py --port 8788 --model-dir /opt/alo/models/piper
pm2 save
```

Fallback chain stays: **Piper HTTP → Piper CLI → eSpeak → built-in formant**, so
`/api/ai/voice` succeeds even with no service running (the built-in formant synth
is always available; it just sounds robotic).

**Verify:** `curl -s http://127.0.0.1:8788/health` → `{"ok":true,…,"paid":false}`.

---

## 4. Ollama — the unconditional primary model

`chainChat()` now asks Ollama **before** any remote provider. This is policy, not
preference: a remote call costs money, sends student text off-box, and fails when
the network does.

```bash
# install, then pull a Bengali-capable model
ollama pull qwen2.5:7b
systemctl status ollama
```

Env (already set): `OLLAMA_BASE_URL=http://127.0.0.1:11434`,
`OLLAMA_CHAT_MODEL=qwen2.5:7b`.

```ini
ALO_PROVIDER_ORDER=local-first     # default; the only way to get remote-first
```

A dead local model falls through to the next provider and the final response is
labelled `rule-based` — it never pretends the local model answered.

**Verify:** `curl -s http://127.0.0.1:11434/api/tags` lists `qwen2.5:7b`.

---

## 5. Health and login

`GET /api/health` returns a named reason header on every response:

```bash
curl -sI http://127.0.0.1:3061/api/health | grep -i x-alo-health-reason
# x-alo-health-reason: none                      → 200 healthy
# x-alo-health-reason: Database                  → 503, the database is the cause
# x-alo-health-reason: MySQL configuration,Administrator authentication,Database
```

`?details=1` (admin session) lists the five local services by name with an
actionable help line. They are **non-critical**: a stopped ASR daemon degrades a
capability, it does not turn the probe red.

For a `200` the three critical checks must pass:

| Check | Fix |
| --- | --- |
| `MySQL configuration` | `DATABASE_URL` must be `mysql://…` (production requires MySQL) |
| `Database` | the MySQL server must be up and `prisma generate` must have run |
| `Administrator authentication` | `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` + `NEXTAUTH_SECRET`, with `ADMIN_OTP_REQUIRED=false` |

### ⚠️ Two traps seen on the live box

1. **A rebuild deletes the running server's working directory.** Next.js'
   standalone output is served from `.next/standalone`; running `npm run build`
   in place replaces that directory while PM2 keeps the old (now unlinked) one
   open. `/api/health` still answers, but the process is serving code that no
   longer exists on disk, and `releaseSha` can be stale. After every build:
   `pm2 restart learn --update-env && pm2 save`.
2. **`.next/standalone/.env` is not copied by the build.** The build deletes it.
   Always re-create it from the real environment file, then restart:

```bash
cd /home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION
npm run build
cp -a <your real env file> .next/standalone/.env      # see below
pm2 restart learn --update-env && pm2 save
curl -sI http://127.0.0.1:3061/api/health | grep -i x-alo-health-reason
```

---

## 6. The $0 guarantee, enforced by tests

`tests/local-web-search.test.mjs`, `tests/local-first-chain.test.mjs`,
`tests/local-services.test.mjs` and `tests/health-local-services.test.mjs`
assert that:

- no module in the local search path references a paid vendor host
  (`api.monid.ai`, `api.exa.ai`, `api.firecrawl.dev`, …);
- every response carries `paidUsed: false` and `localSearchStatus()`
  reports `paidBackends: []`, `usdPerCall: 0`;
- the DuckDuckGo bridge is off unless explicitly enabled;
- the local model answers first even when a remote gateway is configured **and**
  both paid switches are open;
- the ASR/TTS daemons advertise `paid: false` and never fabricate a success when
  the model or binary is missing;
- the SSRF guard runs before any URL reaches a backend (including Crawl4AI).
