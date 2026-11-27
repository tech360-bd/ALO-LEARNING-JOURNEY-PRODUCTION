import test from "node:test";
import assert from "node:assert/strict";
import { assessLicence, parseRepoUrl, reviewLink } from "../src/lib/link-review.ts";

/** The page probe is normally the SSRF-guarded browser; tests pass a stub so the
 *  licence/risk rules can be exercised without the network (loopback is blocked
 *  by the real guard, and that block is asserted separately). */
const reachable = async () => ({ ok: true, status: 200, error: null });
const checkRepo = (url, fetchJson) => reviewLink(url, { fetchJson, browse: reachable });

/**
 * The link-review verdict is what an approval is based on, so every rule is
 * pinned: a wrong "adopt" here is a licence problem in production, and an
 * "adopt" that came from the model instead of a rule would be worse.
 */

test("a repository URL is parsed, sub-paths and .git included", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/BerriAI/litellm"), {
    host: "github.com", owner: "BerriAI", repo: "litellm", url: "https://github.com/BerriAI/litellm",
  });
  assert.equal(parseRepoUrl("https://github.com/LibreChat-AI/LibreChat/tree/main/docker").repo, "LibreChat");
  assert.equal(parseRepoUrl("https://github.com/mei-gen/InfiniteTalk.git").repo, "InfiniteTalk");
  assert.equal(parseRepoUrl("https://gitlab.com/a/b").host, "gitlab.com");
});

test("non-repository or crafted URLs are not mistaken for repos", () => {
  for (const bad of [
    "",
    "not a url",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://github.com/onlyowner",
    "https://github.com/../etc",
    "https://github.com/a/b%00c",
  ]) {
    assert.equal(parseRepoUrl(bad), null, bad);
  }
});

test("permissive licences are low risk, copyleft is medium, AGPL is high", () => {
  assert.equal(assessLicence("MIT", "MIT License").adoptionRisk, "low");
  assert.equal(assessLicence("Apache-2.0", "Apache License 2.0").adoptionRisk, "low");

  const mpl = assessLicence("MPL-2.0", "Mozilla Public License 2.0");
  assert.equal(mpl.copyleft, true);
  assert.equal(mpl.adoptionRisk, "medium");

  const agpl = assessLicence("AGPL-3.0", "GNU Affero General Public License v3.0");
  assert.equal(agpl.adoptionRisk, "high");
  assert.ok(agpl.knownTraps.includes("agpl"));
});

test("NOASSERTION and a missing licence are high risk, not 'probably fine'", () => {
  // GitHub reports NOASSERTION for the bespoke licences of directus, nocobase,
  // activepieces and open-webui. Treating that as permissive would be the mistake.
  const unclassified = assessLicence("NOASSERTION", "Other");
  assert.equal(unclassified.custom, true);
  assert.equal(unclassified.adoptionRisk, "high");

  const missing = assessLicence(null, null);
  assert.equal(missing.custom, true);
  assert.equal(missing.adoptionRisk, "high");
});

test("the known 'free but not open source' traps are named", () => {
  assert.ok(assessLicence("NOASSERTION", "Open WebUI License").knownTraps.includes("open webui license"));
  assert.ok(assessLicence("NOASSERTION", "Business Source License 1.1").knownTraps.includes("business source license"));
  assert.ok(assessLicence("NOASSERTION", "Elastic License 2.0").knownTraps.includes("elastic license"));
});

function ghFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    return {
      ok,
      status,
      json: async () => payload,
    };
  };
  return { fn, calls };
}

test("a maintained permissive repository is 'adopt', with next steps that still require a PR", async () => {
  const { fn, calls } = ghFetch({
    description: "A tiny helper",
    stargazers_count: 1200,
    archived: false,
    pushed_at: new Date().toISOString(),
    size: 500,
    language: "TypeScript",
    license: { spdx_id: "MIT", name: "MIT License" },
    topics: ["ai"],
  });
  const review = await checkRepo("https://github.com/example/tiny", fn);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.github\.com\/repos\/example\/tiny/);
  assert.equal(review.verdict, "adopt");
  assert.equal(review.licence.spdx, "MIT");
  assert.deepEqual(review.riskFlags, []);
  assert.ok(review.nextSteps.some((s) => /pull request/i.test(s)));
  assert.ok(review.nextSteps.some((s) => /commit SHA/i.test(s)));
  assert.ok(review.nextSteps.some((s) => /install scripts/i.test(s)), "must warn against running its scripts");
});

test("an archived or stale repository cannot be a clean 'adopt'", async () => {
  const archived = await checkRepo("https://github.com/example/old",
    ghFetch({ archived: true, license: { spdx_id: "MIT", name: "MIT License" }, pushed_at: new Date().toISOString() }).fn);
  assert.equal(archived.verdict, "review-manually");
  assert.ok(archived.riskFlags.includes("repository_archived"));

  const stale = await checkRepo("https://github.com/example/stale",
    ghFetch({ archived: false, license: { spdx_id: "MIT", name: "MIT License" }, pushed_at: "2019-01-01T00:00:00Z" }).fn);
  assert.equal(stale.verdict, "adopt-with-changes");
  assert.ok(stale.riskFlags.some((f) => f.startsWith("no_commits_for_")));
});

test("a copyleft repository is adoptable with care and says why", async () => {
  const gpl = await checkRepo("https://github.com/example/gpl",
    ghFetch({ archived: false, license: { spdx_id: "GPL-3.0", name: "GNU General Public License v3.0" }, pushed_at: new Date().toISOString() }).fn);
  assert.equal(gpl.verdict, "adopt-with-changes");
  assert.ok(gpl.riskFlags.includes("copyleft_obligations"));
});

test("AGPL is never 'adopt', and the summary says it is not permissive", async () => {
  const agplReview = await checkRepo("https://github.com/example/agpl",
    ghFetch({ archived: false, license: { spdx_id: "AGPL-3.0", name: "GNU Affero General Public License v3.0" }, pushed_at: new Date().toISOString() }).fn);
  assert.equal(agplReview.verdict, "review-manually");
  assert.match(agplReview.summary, /not a permissive licence/i);
});

test("the GitHub API failing still yields a verdict, never a crash", async () => {
  const failed = await checkRepo("https://github.com/example/x", async () => { throw new Error("network down"); });
  assert.equal(failed.verdict, "review-manually");
  assert.ok(failed.riskFlags.includes("github_api_unreachable"));
  assert.match(failed.summary, /no licence could be read/i);
});

test("a non-repository link is rejected outright", async () => {
  // A well-formed URL to a non-repository host is rejected by the URL-shape rule
  // before any fetch happens (the page probe is stubbed here only so the test
  // never depends on the network).
  const notRepo = await checkRepo("https://example.com/some/page");
  assert.equal(notRepo.verdict, "reject");
  assert.match(notRepo.summary, /Only GitHub and GitLab links can be reviewed/);

  // A URL that is not shaped like a repo at all is rejected even earlier.
  const notEvenASegmentPair = await reviewLink("https://github.com/onlyowner");
  assert.equal(notEvenASegmentPair.verdict, "reject");
  assert.match(notEvenASegmentPair.summary, /Not a repository link/);
});

test("reviewing a link never executes anything from it", async () => {
  // The module's contract: read-only HTTP through the SSRF-guarded browser plus
  // the public GitHub API. No child_process, no install, no clone.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/lib/link-review.ts", import.meta.url), "utf8");
  for (const forbidden of ["child_process", "execSync", "exec(", "spawn(", "spawnSync"]) {
    assert.ok(!source.includes(forbidden), `link-review must not be able to ${forbidden}`);
  }
  // No install/clone call anywhere in code. The words appear only inside the
  // documentation header and the operator-facing warnings, so comment lines are
  // excluded from this check rather than the check being dropped.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(code, /["'`]\s*(npm|pnpm|yarn)\s+(i|install|ci)/);
  assert.doesNotMatch(code, /\bgit\s+clone\b/);
});
