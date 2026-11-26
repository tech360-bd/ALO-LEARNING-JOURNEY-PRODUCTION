import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [monitor, seoView, avatarView, avatarRoute, briefRoute, aiSource, layout, styles, robots, sitemap] = await Promise.all([
  "deploy/monitor.sh",
  "src/components/alo/SeoView.tsx",
  "src/components/alo/HumanAvatarView.tsx",
  "src/app/api/avatar-video/route.ts",
  "src/app/api/content/brief/route.ts",
  "src/lib/ai.ts",
  "src/app/layout.tsx",
  "src/app/globals.css",
  "public/robots.txt",
  "src/app/sitemap.ts",
].map((file) => readFile(path.join(root, file), "utf8")));

test("monitor uses the reported MySQL app target and stays read-only", () => {
  assert.match(monitor, /\/home\/alamin\/alolabs-projects\/ALO-LEARNING-JOURNEY-PRODUCTION/);
  assert.match(monitor, /3061/);
  assert.match(monitor, /learn-aloeducation/);
  assert.match(monitor, /pm2 jlist/);
  assert.match(monitor, /no restart attempted/);
  assert.match(monitor, /No SQLite file\/database is expected or inspected/);
  assert.doesNotMatch(monitor, /\bsqlite3\s/);
  assert.doesNotMatch(monitor, /\b(?:mysql|mariadb)\s+[^\n]*(?:-e|--execute)/i);
  assert.doesNotMatch(monitor, /\bpm2\s+(?:start|restart|reload|delete|stop)\b/);
});

test("SEO brief UI and audit records do not claim independent scoring or publish readiness", () => {
  assert.doesNotMatch(seoView, /85\s*\+?\s*[^\n]{0,80}publish-ready/i);
  assert.match(seoView, /Not independently scored · human review required/);
  assert.match(briefRoute, /no independent SEO, fact, safety, or quality review was run/);
  assert.match(briefRoute, /publishReady: false/);
  assert.doesNotMatch(aiSource, /validateContentPackage|withSelfCorrection/);
});

test("avatar generation and UI report lip-sync as unintegrated rather than verified", () => {
  assert.match(avatarRoute, /const lipSyncUsed = false/);
  assert.match(avatarRoute, /const lipSyncReason = "not_integrated"/);
  assert.doesNotMatch(avatarRoute, /\bmaybeLipSync\s*\(/);
  assert.doesNotMatch(avatarView, /Lip-synced/);
  assert.match(avatarView, /Lip-sync flag unverified/);
  assert.match(avatarView, /Lip-sync not integrated/);
});

test("font loading is self-hosted and does not fetch Google Fonts during builds", () => {
  assert.doesNotMatch(layout, /next\/font\/google|fonts\.googleapis\.com/);
  assert.match(styles, /url\("\/fonts\/HindSiliguri-Regular\.ttf"\)/);
  assert.match(layout, /icon: "\/logo\.svg"/);
});

test("the crawler entry points survive without a robots.ts route handler", () => {
  // src/app/robots.ts was retired in favour of public/robots.txt; the sitemap
  // reference it used to emit must still be advertised to crawlers.
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(sitemap, /sitemap\(\): MetadataRoute\.Sitemap/);
  const sitemapHost = sitemap.match(/https:\/\/[a-z0-9.-]+/)?.[0];
  const robotsSitemap = robots.match(/^Sitemap: (\S+)$/m)?.[1];
  assert.ok(robotsSitemap, "public/robots.txt must advertise a Sitemap");
  if (sitemapHost) {
    assert.ok(
      robotsSitemap.startsWith(sitemapHost),
      `robots.txt Sitemap (${robotsSitemap}) must point at the sitemap host (${sitemapHost})`,
    );
  }
});
