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
gh variable set VPS_PM2_APP --body "learn-aloeducation"

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
