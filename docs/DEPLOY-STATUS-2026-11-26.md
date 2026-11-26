# অটো-ডিপ্লয়: বর্তমান অবস্থা (২০২৬-১১-২৬, #20 merge-এর পর)

## যা হয়েছে

| ধাপ | অবস্থা | প্রমাণ |
|---|---|---|
| Secrets সব বসানো | ✅ | আপনার তালিকা |
| `VPS_DEPLOY_ENABLED=true` | ✅ | আপনার কমান্ড |
| কোড-সাইড পিন মিলানো (PR #20) | ✅ merged `1e6f0c9` | main CI `45820900334` pass |
| `verify` (lint/typecheck/test/build) | ✅ | রান `45820900410` |
| Secret scan | ✅ | একই রান |
| `network-preflight` | ❌ **Tailscale connect** | `sudo failed with exit code 1` |
| `deploy` | ⏭ skipped | উপরেরটার উপর নির্ভরশীল |

**অর্থাৎ: কোড আর GitHub-এর ৯০% কনফিগ প্রস্তুত। শুধু Tailscale-এ ঢোকার পথটা আটকে আছে।**

## আসল বাধা: `Tailscale connect`

Action কী চালায় (সোর্স থেকে যাচাই করা, `v4.4.0`):

```
sudo -E tailscale up \
  --advertise-tags=tag:github-runner \
  --hostname=gha-learn-deploy-<run_id> \
  --accept-routes \
  --authkey=<TAILSCALE_OAUTH_SECRET>?preauthorized=true&ephemeral=true
```

এর যেকোনো একটি ভুল হলে GitHub একই এরর দেখায় — `sudo failed with exit code 1`।
তাই PR #21 যোগ করে একটি read-only ডায়াগনস্টিক ধাপ, যা পরের রানেই আসল কারণ
দেখাবে (`tailscaled.log`, sudo অবস্থা, client-id দৈর্ঘ্য, `tailscale status`)।

### আপনার যা যা মিলিয়ে দেখতে হবে (Tailscale admin console)

1. **OAuth client** (`Settings → OAuth clients`)
   - Scope: `auth_keys` = **write** (এটাই সবচেয়ে সাধারণ ভুল)
   - Tags: **`tag:github-runner`** — এই ট্যাগটাই client-এ বাধ্যতামূলক
   - Client মেয়াদোত্তীর্ণ নয়
2. **ACL** (`Access controls` → JSON) — এই দুটি অংশ দরকার:
   ```json
   "tagOwners": {
     "tag:github-runner": ["autogroup:admin"]
   },
   "acls": [
     { "action": "accept", "src": ["tag:github-runner"], "dst": ["tag:server:22"] }
   ]
   ```
   `tag:server` আপনার VPS-এর বাস্তব ট্যাগ (বা `"*:*"` দিয়ে টেস্ট)।
3. **VPS নিজে tailnet-এ আছে?**
   ```bash
   tailscale status | head
   tailscale ip -4
   ```
   `SERVER_HOST` ভ্যারিয়েবলের মান এই `100.x.y.z` (বা MagicDNS নাম) হতে হবে।
4. **OAuth secret** ঠিকভাবে বসেছে? (সিক্রেট দেখানো যাবে না, শুধু দৈর্ঘ্য)

## এরপরের ধাপ (ক্রম অনুযায়ী)

```bash
# ১) Tailscale ঠিক করার পর নেটওয়ার্ক যাচাই
gh workflow run deploy.yml -f mode=preflight-only --ref main
gh run watch

# ২) PM2 নাম সংশোধন (আপনার এখনকার মান ভুল: "learn")
gh variable set VPS_PM2_APP --body "learn"

# ৩) রিলিজ SHA রিফ্রেশ (এখন main = 1e6f0c9, আপনার ভ্যারিয়েবলে পুরোনো 285ae78)
SHA=$(gh api repos/tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION/commits/main --jq .sha)
gh variable set VPS_RESTORE_TEST_SHA --body "$SHA"
gh variable set VPS_SCHEMA_PREFLIGHT_SHA --body "$SHA"
gh variable set VPS_RESTORE_TEST_REFERENCE --body "restore-$(date +%F)"
gh variable set VPS_SCHEMA_PREFLIGHT_REFERENCE --body "schema-$(date +%F)"
```

## সার্ভারে একবার (ম্যানুয়াল, প্রথম ইনস্টল)

Deploy স্ক্রিপ্ট ধরে নেয় PM2 প্রসেস **আগে থেকেই online** এবং `current` সিমলিংক
আছে। না থাকলে থেমে যাবে (`this deploy path does not bootstrap or start a first
PM2 process`)। সার্ভারে চালিয়ে আউটপুট পাঠান:

```bash
cd /home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION 2>/dev/null || echo "APP_DIR নেই"
ls -la; echo "--- shared ---"; ls -la shared/ 2>/dev/null
echo "--- current ---"; readlink -f current
echo "--- pm2 ---"; pm2 list
echo "--- port ---"; ss -lntH | grep 3061 || echo "3061 এ কিছু শুনছে না"
echo "--- node ---"; node -v
```

## মনে রাখবেন

- **`production` environment-এ required reviewer** থাকলে প্রতিটি ডিপ্লয়ের আগে
  অনুমোদন দিতে হবে — তখন "সাথে সাথে লাইভ" হবে না, কিন্তু ভুল রিলিজ থেকে বাঁচাবে।
- **মাইগ্রেশন** (নতুন Prisma মাইগ্রেশন থাকলে) আলাদা SHA-অনুমোদন ছাড়া চলবে না;
  ডেটাবেস অটো-রোলব্যাক হয় না।
- কোড-রোলব্যাক অটো: নতুন রিলিজের PM2 health ফেল করলে আগের রিলিজে ফিরে যায়।

## ৮. আসল কারণ পাওয়া গেছে (রান `45824287514`)

ডায়াগনস্টিক annotation থেকে:

```
tailscale-status: Logged out.
tailscaled.log:  ... machineAuthorized=false ...
                 Received error: invalid key: unable to validate API key
sudo-non-interactive=yes
tailscale-binary=/usr/local/bin/tailscale
oauth-client-id-length=17
```

**অর্থ: runner কখনো tailnet-এ ঢোকেনি — credential-ই গ্রহণ হয়নি।**
Tailscale-এর ডকুমেন্ট ও বাস্তব রিপোর্ট অনুযায়ী `invalid key: unable to validate
API key` চারটি কারণে হতে পারে:

1. OAuth client-এ **`auth_keys` write scope নেই**
2. OAuth client **`tag:github-runner`-এর মালিক নয়** — এই ট্যাগ
   `tagOwners`-এ সেই client-এর নামে থাকতে হবে
3. Client/secret **ভুল বা রিভোক করা** (secret কপি করার সময় নতুন লাইন/স্পেস)
4. `TAILSCALE_OAUTH_SECRET`-এ OAuth client secret-এর বদলে **auth key
   (`tskey-auth-…`)** বসানো হয়েছে — action তখন `?preauthorized=true&ephemeral=true`
   যোগ করে key-টা নষ্ট করে দেয়

### সবচেয়ে সহজ সমাধান: সাধারণ auth key ব্যবহার করুন

Auth key-তে কোনো scope/tagOwners ঝামেলা নেই। এখন কোড দুটোই সমর্থন করে:

```bash
# ১) Tailscale admin → Settings → Keys → Generate auth key
#    ✔ Ephemeral  ✔ Pre-authorized  ✔ Tags: tag:github-runner  ✔ Expiry: 90 দিন
# ২) GitHub-এ secret হিসেবে বসান
gh secret set TAILSCALE_AUTH_KEY
# (আগের OAuth দুটো মুছে ফেলার দরকার নেই — authkey থাকলে সেটাই ব্যবহার হবে)
```

> পুরোনো বাগ: action-টি `invalid key` লগ করে **তবুও success** দেখিয়ে SSH ধাপে
> চলে যেত। এখন `Assert tailnet membership` ধাপ যোগ করা হয়েছে — tailnet-এ না
> ঢুকলে সাথে সাথে পরিষ্কার এরর দিয়ে থামবে।

## ৯. চূড়ান্ত নির্ণয় (রান `45826673198`) — সমস্যাটা আপনার সিক্রেটের মানে

```
credential-in-use=oauth client pair
oauth-client-id-length=17   oauth-secret-length=17   auth-key-length=0
tailscaled.log-errors: ... Received error: invalid key: unable to validate API key
```

**`oauth-secret-length=17`** — Tailscale-এর আসল OAuth client secret কখনো ১৭
অক্ষরের হয় না। আসল secret শুরু হয় `tskey-client-` দিয়ে এবং সাধারণত ৪০+
অক্ষরের হয়। অর্থাৎ GitHub-এ যা বসানো আছে সেটি **প্লেসহোল্ডার/ভুল মান**
(যেমন `your-client-secret`)। একইভাবে `client-id`-ও ১৭ অক্ষর — সাধারণত ছোট
আইডি হয়, তবে secret-এর ১৭ অক্ষর প্রমাণ করে মানগুলো ঠিকভাবে কপি হয়নি।

### ⚠️ এই কাজটি আমাকে না জানিয়ে করুন

Secret-এর মান চ্যাটে **পাঠাবেন না** — শুধু নিজে বসান।

#### পথ A (সহজতম): Auth key দিয়ে

1. <https://login.tailscale.com/admin/settings/keys> → **Generate auth key**
   - ✔ **Reusable** (বা Ephemeral)
   - ✔ **Pre-approved**
   - Tags: **`tag:github-runner`** নির্বাচন করুন
   - Expiry: 90 দিন
2. ব্রাউজারে আপনার নিজের টার্মিনালে:
   ```bash
   gh secret set TAILSCALE_AUTH_KEY
   # প্রম্পটে key পেস্ট করুন (tskey-auth-... দিয়ে শুরু)
   ```
3. যাচাই — দৈর্ঘ্য ৪৫+ হওয়া উচিত:
   ```bash
   gh workflow run deploy.yml -f mode=preflight-only --ref main
   gh run watch
   ```
   ডায়াগনস্টিকে `credential-in-use=plain auth key` আর
   `auth-key-length=50+` দেখতে পাওয়া উচিত।

#### পথ B: OAuth ঠিক করা

1. <https://login.tailscale.com/admin/settings/oauth> → **Generate OAuth client**
   - Scope: **`auth_keys` → Write**
   - Tags: **`tag:github-runner`**
2. Client secret পুরোটা কপি করুন (`tskey-client-…`), স্পেস/নিউলাইন ছাড়া:
   ```bash
   gh secret set TAILSCALE_OAUTH_CLIENT_ID
   gh secret set TAILSCALE_OAUTH_SECRET
   ```
3. `tagOwners`-এ ট্যাগের মালিকানা নিশ্চিত করুন (Access controls → JSON):
   ```json
   "tagOwners": { "tag:github-runner": ["autogroup:admin"] }
   ```

### তারপর যা বাকি (আগেই বলা)

```bash
gh variable set VPS_PM2_APP --body "learn"   # লাইভ PM2 নাম
SHA=$(gh api repos/tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION/commits/main --jq .sha)
gh variable set VPS_RESTORE_TEST_SHA --body "$SHA"
gh variable set VPS_SCHEMA_PREFLIGHT_SHA --body "$SHA"
```

## ১০. সংশোধন (২০২৬-১১-২৬, অপারেটরের যাচাইকৃত সার্ভার তথ্য)

অপারেটর লাইভ সার্ভার (`alo-server-lap`, Tailscale `100.94.234.101`) যাচাই করে
দুটি ভুল ধরেছেন, দুটোই ঠিক করা হয়েছে:

| আগে (ভুল) | এখন (সঠিক) |
|---|---|
| `VPS_PM2_APP=learn-aloeducation` | **`learn`** — লাইভ PM2 `id:39`, `ecosystem.learn.config.cjs`-এর সাথে মিলে |
| `DEPLOY_URL=https://learn.aloeducation.com` | **`https://learn.alolabs.net`** — সার্ভারের `.env` (`NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`) ও Cloudflare Tunnel দিয়ে `127.0.0.1:3061` |

`learn.aloeducation.com` এই সার্ভারে সক্রিয় নয় (`HTTP 000`), তাই সেটি আর
কখনো দাবি করা হয় না — তবে `http://learn.alolabs.net` ও
`https://learn.alolabs.net` দুটোই গ্রহণযোগ্য, আর পাবলিক স্বাস্থ্য-চেক সবসময়
TLS-এ (`https://`) হয়।

### নতুন যুক্ত হওয়া গুরুত্বপূর্ণ লজিক

PM2 প্রসেসের `cwd` হলো `$APP_DIR/.next/standalone` — যা রিলিজ-নির্দিষ্ট নয়।
ডিপ্লয় স্ক্রিপ্ট এখন:

1. `.next/static`, `public`, Prisma engine ও `.env` → `.next/standalone`-এ কপি করে
2. **`$APP_DIR/.next/standalone` → `releases/<sha>/.next/standalone`** সিমলিংক
   atomically সুইচ করে (rollback-এ আগের রিলিজে ফেরে)
3. `RELEASE_SHA=<sha>` লেখে standalone `.env`-এ এবং `pm2 reload learn --update-env`-এ
   export করে — যাতে `/api/health` ঠিক ওই SHA ফেরত দেয়
4. কোনো `sudo` ব্যবহার করে না (আপনার সার্ভারে passwordless sudo বন্ধ)

> **একবারের ম্যানুয়াল ধাপ:** এখন যদি `.next/standalone` আসল ডিরেক্টরি হয়
> (সিমলিংক নয়), প্রথম ডিপ্লয় স্পষ্ট এরর দিয়ে থেমে যাবে। তখন সার্ভারে:
> ```bash
> cd /home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION
> mv .next/standalone .next/standalone.predeploy
> ```
> এরপর ডিপ্লয় চালালে স্ক্রিপ্ট নিজেই সিমলিংক বানাবে। (`.env` হারাবে না — শেয়ার্ড
> `shared/.env` থেকে কপি হয়।)

## ১১. সর্বশেষ অবস্থা (main `b1ccd5f`)

### কোড সম্পূর্ণ প্রস্তুত ✅

| PR | কী হলো |
|---|---|
| #26 | `learn` PM2 নাম, `learn.alolabs.net` ডোমেইন, standalone release symlink, `RELEASE_SHA` ইনজেকশন |
| #27 | নিজেরাই `tailscale up` চালানো — আসল এরর দৃশ্যমান |
| #28 | ট্যাগ ঐচ্ছিক (`TAILSCALE_TAGS` unset ⇒ untagged join) |
| #29 | action-কে OAuth pair পাঠানো বন্ধ (সেটাই `tailscale` ইনস্টল আটকাত) |
| #30 | preflight দ্রুত ব্যর্থ হয় + নেটওয়ার্ক প্রমাণ annotation |
| #31 | single-use key শনাক্তকরণ + `ping` ফ্ল্যাগ ঠিক |

প্রতিটি PR-এ CI-র ২১টি ধাপ (lint, typecheck, 250 টেস্ট, migration parity, deploy-script tests, build) পাস করেছে।

### শুধু একটি জিনিস বাকি: **Reusable auth key**

রান `45851130345`-এ join সফল হয়েছিল (`alo-server-lap` peer হিসেবে দেখা গেছে),
কিন্তু পরের রানেই আবার `Logged out` — কারণ Tailscale-এ **`Reusable` ডিফল্টে বন্ধ**,
তাই একটি key একবারই কাজ করে।

```
Tailscale admin → Settings → Keys → Generate auth key
   ✔ Reusable      ← এটাই আসল সমাধান
   ✔ Ephemeral
   ✔ Pre-approved
   Tags: কিছুই দেবেন না (TAILSCALE_TAGS খালি রাখুন)
```
```bash
gh secret set TAILSCALE_AUTH_KEY     # নতুন key পেস্ট করুন
gh workflow run deploy.yml -f mode=preflight-only --ref main
```

### এরপর যা দেখা যাবে

সফল join হলে `Network evidence` annotation সরাসরি বলবে কোন স্তরে সমস্যা (যদি থাকে):

```
target=<host> port=<port>
peers=N tailnet-host-visible=1
ping: pong from alo-server-lap ...
tcp:open
ssh: (খালি = সফল)
```

`tcp:closed` ⇒ সার্ভারে UFW/tailnet ACL-এ 22 খোলা নেই।
`ssh:` এ `Permission denied` ⇒ `VPS_SSH_KEY`-এর পাবলিক অংশ সার্ভারের `authorized_keys`-এ নেই।
`ssh:` এ `Host key verification failed` ⇒ `VPS_SSH_HOST_KEY` ভুল।
