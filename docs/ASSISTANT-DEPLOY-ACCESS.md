# অটো-ডিপ্লয় চালু করার গাইড (কী শেয়ার করবেন, কী করতে হবে)

লক্ষ্য: **যেকোনো ফাইল/ফিচার প্রস্তাব করলাম → PR → merge → সাথে সাথে সার্ভারে লাইভ।**
হাতে কিছু না। এই ডকুমেন্টে ঠিক কী বাকি আছে এবং আপনার কাছ থেকে কী তথ্য দরকার তা দেওয়া আছে।

---

## ১. এখন পাইপলাইন কোথায় দাঁড়িয়ে আছে

```
branch ──PR──▶ CI (validate + Secret scan)  ✅ পাস
                    │
                 merge to main
                    ▼
        Deploy to VPS workflow
          ├─ verify (CI আবার)              ✅ পাস
          ├─ network-preflight             ❌ Tailscale connect fail
          └─ deploy                        ⏭ skipped (switch বন্ধ)
```

তিনটি আলাদা কারণ আছে, একটির সাথে অন্যটির সম্পর্ক নেই:

| # | সমস্যা | কোথায় | সমাধান |
|---|---|---|---|
| ১ | `Tailscale connect` ব্যর্থ | `network-preflight` step 4 | Tailscale OAuth সিক্রেট + ACL ঠিক করা |
| ২ | `deploy` job স্কিপড | `vars.VPS_DEPLOY_ENABLED` সেট নেই | ভ্যারিয়েবল `true` করা |
| ৩ | `production` environment গেট নেই | GitHub Environments | Required reviewer যোগ করা |

**ফাইল হারানো বা কোডের সমস্যা নয়** — `verify` ও `Secret scan` দুটোই সবুজ।

---

## ২. আপনার কাছ থেকে যে তথ্যগুলো দরকার (সবই নন-সিক্রেট)

নিচের ব্লকটা কপি করে যেখানে যা আছে লিখে পাঠিয়ে দিন (খালি থাকলে "জানি না" লিখুন):

```
১) সার্ভার কোনটা?            → VPS / cPanel / দুটোই?
২) পাবলিক ডোমেইন             → ex: learn.alolabs.net
৩) VPS-এ অ্যাপ ফোল্ডার        → ex: /home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION
৪) PM2 অ্যাপের নাম            → ex: learn-aloeducation
৫) অ্যাপের ইন্টারনাল পোর্ট    → ex: 3061
৬) চালানোর ইউজার              → ex: alamin
৭) SSH পোর্ট                  → ex: 22
৮) সার্ভার কি Tailscale-এ আছে? → হ্যাঁ/না
৯) MySQL ডাটাবেস নাম/হোস্ট     → ex: 127.0.0.1:3306/db_learn
১০) Node ভার্সন (VPS-এ)       → node -v
১১) Nginx/Caddy দিয়ে প্রোক্সি? → ex: Nginx → 127.0.0.1:3061
১২) PM2-এ এখন অ্যাপ চলছে কি?   → pm2 list (আউটপুট)
১৩) git remote pull করতে পারে? → সার্ভারে git pull কাজ করে?
১৪) sudo লাগবে কি?            → pm2 restart-এ sudo দরকার?
```

> ⚠️ **কোনো পাসওয়ার্ড, প্রাইভেট কী, API টোকেন চ্যাটে পাঠাবেন না।**
> সিক্রেট শুধু GitHub-এর Secrets পাতায় বসবে — কমান্ড আমি দেব, রান আপনি করবেন।

---

## ৩. ধাপে ধাপে: কী কী করতে হবে

### ধাপ A — Tailscale (এটা ছাড়া deploy কখনো শুরু হবে না)

1. Tailscale admin → **Settings → OAuth clients → Generate**
   - Scopes: `auth_keys` (write) — আর কিছু না
   - Tags: `tag:github-runner`
2. Tailscale **Access Controls**-এ যোগ করুন:
   ```json
   { "action": "accept", "src": ["tag:github-runner"], "dst": ["tag:server:22"] }
   ```
   (`tag:server` আপনার VPS-এর ট্যাগ; বাস্তব ট্যাগ নাম বসাবেন)
3. GitHub → Settings → Secrets → Actions-এ যোগ করুন:
   `TAILSCALE_OAUTH_CLIENT_ID`, `TAILSCALE_OAUTH_SECRET`

### ধাপ B — SSH অ্যাক্সেস

```bash
# লোকাল মেশিনে — ডেডিকেটেড deploy key (পাসফ্রেজ ছাড়া)
ssh-keygen -t ed25519 -C "gha-deploy-$(date +%F)" -f ~/.ssh/alo_deploy -N ""

# পাবলিক কী সার্ভারে বসান
ssh-copy-id -i ~/.ssh/alo_deploy.pub USER@HOST

# সার্ভারের ফিঙ্গারপ্রিন্ট নিন (VPS_SSH_HOST_KEY এর জন্য)
ssh-keyscan -p 22 -t ed25519 HOST
```

GitHub Secrets-এ যোগ করুন: `SERVER_HOST` (tailnet IP/নাম), `VPS_USER`,
`VPS_SSH_KEY` (প্রাইভেট কীটার **পুরো** কনটেন্ট), `VPS_SSH_HOST_KEY`
(`ssh-keyscan`-এর আউটপুট লাইন), `VPS_PORT`।

### ধাপ C — Repository Variables (নাম হুবহু মিলতে হবে)

| Variable | মান |
|---|---|
| `VPS_APP_DIR` | `/home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION` |
| `VPS_PM2_APP` | `learn-aloeducation` |
| `VPS_APP_PORT` | `3061` |
| `DEPLOY_URL` | `http://learn.alolabs.net` |
| `HEALTH_PATH` | `/api/health` |

> এই পাঁচটি মান **হার্ডকোড করা** `scripts/deploy-production.sh`-এর সাথে হুবহু
> মিলতে হবে, নাহলে স্ক্রিপ্ট নিজেই থেমে যাবে। সার্ভারে সত্যিই অন্য পথ/পোর্ট হলে
> আগে স্ক্রিপ্ট আপডেট করতে হবে — বলবেন, করে দেব।

### ধাপ D — Deployment গেট (নিরাপত্তার জন্য, একবারই)

1. GitHub → Settings → **Environments → production** → New environment
2. **Required reviewers** → নিজেকে যোগ করুন
3. `verify` ও `network-preflight` সবুজ হলে deploy জব অনুমোদনের জন্য থামবে

> এটা রাখলে "সাথে সাথে লাইভ" হবে না — অনুমোদন দিতে হবে।
> একেবারে অটো (অনুমোদন ছাড়া) চাইলে reviewer খালি রাখতে হবে; আমি সুপারিশ করি
> অন্তত প্রথম কয়েক রিলিজের জন্য reviewer রাখা।

### ধাপ E — সবশেষে চালু করুন

```bash
gh variable set VPS_DEPLOY_ENABLED --body true
```

এটাই আসল সুইচ। এর পরে `main`-এ যেকোনো merge → স্বয়ংক্রিয় ডিপ্লয়।

### ধাপ F — (ঐচ্ছিক) মাইগ্রেশন থাকলে

নতুন Prisma মাইগ্রেশন থাকলে deploy স্ক্রিপ্ট জোর করে দুটি ভ্যারিয়েবল দাবি করে:

```bash
SHA=<merge commit এর full SHA>
gh variable set VPS_RESTORE_TEST_SHA --body "$SHA"
gh variable set VPS_RESTORE_TEST_REFERENCE --body "restore-rehearsal-$(date +%F)"
gh variable set VPS_SCHEMA_PREFLIGHT_SHA --body "$SHA"
gh variable set VPS_SCHEMA_PREFLIGHT_REFERENCE --body "schema-review-$(date +%F)"
gh variable set VPS_MIGRATION_PLAN_SHA --body "$SHA"   # শুধু pending migration থাকলে
```

⚠️ এগুলো "আমি ব্যাকআপ রিস্টোর ও স্কিমা রিভিউ করেছি" — এই ঘোষণাটি সত্যি হতে হবে।
মাইগ্রেশন অটো-রিভার্ট হয় না; ভুল হলে ডেটা ফেরানো যায় না।

---

## ৪. প্রতিবার কীভাবে কাজ করবে (লক্ষ্য অর্জনের পর)

| আপনি যা বলবেন | আমি যা করব |
|---|---|
| "অমুক ফিচার যোগ করো" | শাখায় কোড + টেস্ট → commit → `gh pr create` |
| "merge করে দাও" বা আমি অনুমতি চাইব | `gh pr merge <n> --squash` → CI গ্রিন হলে অটো-ডিপ্লয় |
| "লাইভ হয়েছে?" | `gh run list` + `curl /api/health` দিয়ে `releaseSha` যাচাই |

সম্পূর্ণ অটো করতে চাইলে দুটি ঐচ্ছিক ধাপ:

```bash
# ১) CI পাস হলে auto-merge চালু (নিজের PR-এর জন্য)
gh pr merge <number> --auto --squash

# ২) main-এ সরাসরি push না করে শুধু PR দিয়ে কাজ — branch protection চালু রাখুন
```

---

## ৫. যা এখনো অটো হবে না (ইচ্ছাকৃতভাবে)

- **ডেটাবেস মাইগ্রেশন** — প্রতিটি pending মাইগ্রেশনের জন্য আলাদা SHA-অনুমোদন লাগে।
  চাইলে এই গেট শিথিল করা যায়, কিন্তু তখন ব্যাকআপ ছাড়া ডেটা ঝুঁকিতে পড়বে।
- **প্রথম ইনস্টল** — স্ক্রিপ্ট ধরে নেয় PM2-তে অ্যাপ আগে থেকেই চলছে
  (`pm2 list` খালি হলে deploy শুরুই হবে না)। প্রথমবার একটি ম্যানুয়াল bootstrap লাগবে।
- **Rollback** — কোড অটো-রোলব্যাক হয় (PM2 health ফেল করলে), ডেটাবেস নয়।

---

## ৬. পুরোনো পাথ/পোর্টের অসঙ্গতি — সমাধান হয়েছে

`deploy/app-deploy.sh`, `monitor.sh`, `health-check.sh`, `backup.sh` ও
`vps-bootstrap.sh` আগে পুরোনো `/home/aloedu/LEARNING-JOURNEY` ও পোর্ট `3017`
ধরে রাখত। এখন সবগুলো `scripts/deploy-production.sh`-এর সাথে একই মান
(`/home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION`, পোর্ট `3061`)
ব্যবহার করে এবং `tests/deploy-script-safety.test.mjs` + `tests/release-claims.test.mjs`
এটি পাহারা দেয়।

---

## ৭. ২০২৬-১১-২৬: আপনার সেটআপের পর যা পাওয়া গেল

### ✅ হয়েছে
Secrets বসেছে (`SERVER_HOST`, `VPS_HOST`, `VPS_PORT`, `VPS_SSH_KEY`,
`VPS_SSH_HOST_KEY`, `VPS_USER`, `TAILSCALE_OAUTH_CLIENT_ID/SECRET`) এবং
`VPS_DEPLOY_ENABLED=true`।

### ❌ এখনো যে ৪টি কারণে ডিপ্লয় হবে না

| # | সমস্যা | প্রমাণ | সমাধান |
|---|---|---|---|
| ১ | `Tailscale connect` ফেল | রান `45819078562` → `sudo failed with exit code 1` (৫ বার retry) | OAuth ক্লায়েন্টে `auth_keys:write` scope ও `tag:github-runner` ট্যাগ নেই, অথবা Tailscale ACL-এ `tag:github-runner → আপনার সার্ভার:22` নিয়ম নেই |
| ২ | `VPS_SSH_HOST_KEY` সম্ভবত ভুল ফরম্যাট | পরের ধাপেই ধরা পড়বে | `ssh-keyscan -t ed25519 <হোস্ট>` এর **পুরো লাইন** (`হোস্ট ssh-ed25519 AAAA...`) বসাতে হবে |
| ৩ | `VPS_PM2_APP` = `learn` | আপনার ভ্যারিয়েবল তালিকা | **`learn-aloeducation`** করতে হবে (স্ক্রিপ্ট হুবহু মেলায়) |
| ৪ | `VPS_RESTORE_TEST_SHA` / `VPS_SCHEMA_PREFLIGHT_SHA` পুরোনো | `285ae78…` (এখন `main` = `354e449…`) | প্রতিটি রিলিজের exact SHA বসাতে হবে, নাহলে স্ক্রিপ্ট থেমে যাবে |

### 🔧 এই PR-এ যা ঠিক করা হয়েছে
- `DEPLOY_URL` এখন `https://learn.aloeducation.com` (আপনার সেট করা মান) — আগে কোড `http://learn.alolabs.net` দাবি করত, তাই ডিপ্লয় কখনো শুরুই হতো না
- pending-migration allowlist-এ নতুন `20261125000000_super_admin_omni_selfheal` যোগ (আগে থাকলে "unknown suffix" তে আটকে যেত)
- `deploy/app-deploy.sh`, `monitor.sh`, `health-check.sh`, `backup.sh`, `vps-bootstrap.sh` — সব `/home/aloedu/LEARNING-JOURNEY:3017` থেকে `/home/alamin/alolabs-projects/...:3061`-এ একীভূত

### এখনই রান করার কমান্ড

```bash
gh variable set VPS_PM2_APP --body learn-aloeducation
```

Tailscale ঠিক করার পর যাচাই:

```bash
gh workflow run deploy.yml -f mode=preflight-only --ref main
gh run watch
```

`network-preflight` সবুজ হলে বুঝবেন নেটওয়ার্ক প্রস্তুত। তারপর:

```bash
# নতুন রিলিজের জন্য প্রতি রিলিজে
SHA=$(gh api repos/tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION/commits/main --jq .sha)
gh variable set VPS_RESTORE_TEST_SHA --body "$SHA"
gh variable set VPS_SCHEMA_PREFLIGHT_SHA --body "$SHA"
gh variable set VPS_RESTORE_TEST_REFERENCE --body "restore-$(date +%F)"
gh variable set VPS_SCHEMA_PREFLIGHT_REFERENCE --body "schema-$(date +%F)"
```

### সার্ভারে প্রথমবার (একবারই, ম্যানুয়াল)

স্ক্রিপ্ট ধরে নেয় PM2-তে অ্যাপ **আগে থেকেই চলছে** এবং `current` সিমলিংক আছে।
না থাকলে deploy শুরুতেই থেমে যাবে। সার্ভারে চালান (আউটপুট আমাকে পাঠান):

```bash
cd /home/alamin/alolabs-projects/ALO-LEARNING-JOURNEY-PRODUCTION
ls -la; ls -la shared/ 2>/dev/null; readlink -f current; pm2 list; ss -lntH | grep 3061; node -v
```
