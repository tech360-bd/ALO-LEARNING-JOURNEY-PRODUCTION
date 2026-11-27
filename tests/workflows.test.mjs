import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lintDirectory, lintWorkflow, parseUses, collectUses, KNOWN_JOBS } from "../scripts/validate-workflows.mjs";

const ok = (name, workflow) => {
  const findings = lintWorkflow(name, workflow);
  assert.deepEqual(findings.filter((f) => f.level === "error"), [], `${name}: ${JSON.stringify(findings)}`);
};
const base = (over = {}) => ({
  name: "CI",
  on: { push: { branches: ["main"] } },
  jobs: { validate: { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] } },
  ...over,
});

test("the repository's real workflows pass", async () => {
  const report = await lintDirectory(".github/workflows");
  const errors = report.flatMap((entry) => entry.findings.filter((f) => f.level === "error"));
  assert.deepEqual(errors, []);
  assert.ok(report.length >= 3);
});

test("every required job name still exists in its file", async () => {
  const report = await lintDirectory(".github/workflows");
  const byFile = new Map(report.map((entry) => [entry.file, entry]));
  for (const [file, required] of Object.entries(KNOWN_JOBS)) {
    const entry = byFile.get(file);
    assert.ok(entry, `${file} missing`);
    const text = readFileSync(`.github/workflows/${file}`, "utf8");
    for (const job of required) {
      assert.match(text, new RegExp(`^ {2}${job}:`, "m"), `${file} must keep job ${job}`);
    }
  }
});

test("a missing required job is an error, not a silent pass", () => {
  const findings = lintWorkflow("deploy.yml", base({ jobs: { verify: { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] } } }));
  const messages = findings.filter((f) => f.level === "error").map((f) => f.message).join(" | ");
  assert.match(messages, /required job "deploy" is gone/);
});

test("a wrong action major is rejected", () => {
  const wf = base({ jobs: { validate: { "runs-on": "ubuntu-22.04", steps: [{ uses: "actions/setup-node@v2" }] } } });
  const messages = lintWorkflow("ci.yml", wf).map((f) => f.message).join(" | ");
  assert.match(messages, /pins actions\/setup-node to v5/);
});

test("an unreviewed moving ref is rejected", () => {
  const wf = base({
    jobs: {
      validate: { "runs-on": "ubuntu-22.04", steps: [{ uses: "some/action@main" }] },
      "security-scan": { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] },
    },
  });
  const messages = lintWorkflow("ci.yml", wf).map((f) => f.message).join(" | ");
  assert.match(messages, /not a full 40-character commit SHA or a reviewed major tag/);
});

test("a pinned SHA is accepted", () => {
  ok("ci.yml", base({
    jobs: {
      validate: { "runs-on": "ubuntu-22.04", steps: [{ uses: "tailscale/github-action@064b10558093f38325e838ddea35486bdc6b1d5c" }] },
      "security-scan": { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] },
    },
  }));
});

test("a workflow_dispatch input nothing reads is an error", () => {
  const wf = base({
    on: { workflow_dispatch: { inputs: { mode: { type: "choice", options: ["a", "b"] } } } },
  });
  const messages = lintWorkflow("deploy.yml", wf).map((f) => f.message).join(" | ");
  assert.match(messages, /input "mode" is declared but no condition or step reads it/);
});

test("a workflow_dispatch input that is read is accepted", () => {
  ok("deploy.yml", base({
    on: { workflow_dispatch: { inputs: { mode: { type: "choice", options: ["a", "b"] } } } },
    jobs: {
      verify: { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] },
      "network-preflight": { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] },
      deploy: { "runs-on": "ubuntu-22.04", if: "github.event_name == 'push' || inputs.mode == 'deploy'", steps: [{ run: "true" }] },
    },
  }));
});

test("a job without a runner and a step without uses/run are errors", () => {
  const wf = base({ jobs: { validate: { steps: [{ name: "nothing" }] } } });
  const messages = lintWorkflow("ci.yml", wf).map((f) => f.message).join(" | ");
  assert.match(messages, /neither runs-on nor a reusable/);
  assert.match(messages, /has neither uses nor run/);
});

test("a reusable workflow call needs no runner", () => {
  ok("deploy.yml", base({
    jobs: {
      verify: { uses: "./.github/workflows/ci.yml" },
      "network-preflight": { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] },
      deploy: { "runs-on": "ubuntu-22.04", steps: [{ run: "true" }] },
    },
  }));
});

test("a workflow without a name or triggers is an error", () => {
  const messages = lintWorkflow("other.yml", { jobs: { a: { "runs-on": "x", steps: [{ run: "true" }] } } })
    .map((f) => f.message)
    .join(" | ");
  assert.match(messages, /missing a top-level name/);
  assert.match(messages, /missing on: triggers/);
});

test("parseUses distinguishes local, SHA and tag references", () => {
  assert.equal(parseUses("./.github/workflows/ci.yml"), null);
  assert.equal(parseUses("docker://alpine:3"), null);
  assert.deepEqual(parseUses("actions/checkout@v7"), { repo: "actions/checkout", ref: "v7", pinned: false });
  assert.equal(parseUses("tailscale/github-action@064b10558093f38325e838ddea35486bdc6b1d5c").pinned, true);
});

test("collectUses sees reusable-workflow calls and steps", () => {
  const uses = collectUses(base({
    jobs: {
      verify: { uses: "./.github/workflows/ci.yml" },
      validate: { "runs-on": "x", steps: [{ uses: "actions/checkout@v7" }] },
    },
  })).map((entry) => entry.uses);
  assert.deepEqual(uses, ["./.github/workflows/ci.yml", "actions/checkout@v7"]);
});

test("the deploy workflow allows the manual modes it documents", () => {
  const text = readFileSync(".github/workflows/deploy.yml", "utf8");
  assert.match(text, /preflight-only/);
  assert.match(text, /inputs\.mode == 'deploy'/);
  assert.match(text, /inputs\.mode == 'deploy'/, "the mode input must gate the deploy job");
});

test("a merge with deployment switched off cannot produce a red preflight", async () => {
  // Regression: `network-preflight` used to fire on every push to main, so each
  // merge failed closed on the not-yet-configured Tailscale/SSH secrets even
  // though deploy was skipped (runs 45958367979, 45910557693, 45892763352).
  const yaml = await (await import("../scripts/validate-workflows.mjs")).loadYaml();
  const wf = yaml.load(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const preflight = wf.jobs["network-preflight"];
  const condition = String(preflight.if);
  assert.match(condition, /vars\.VPS_DEPLOY_ENABLED == 'true'/, "preflight must require the readiness switch");
  // A manual run is still allowed to test the network with deployment off.
  assert.match(condition, /github\.event_name == 'workflow_dispatch'/);
  // …and the deploy job must still require both the switch and (for manual runs) mode=deploy.
  assert.match(String(wf.jobs.deploy.if), /vars\.VPS_DEPLOY_ENABLED == 'true'/);
  assert.match(String(wf.jobs.deploy.if), /inputs\.mode == 'deploy'/);
});

test("the standalone smoke is generated credentials, never a literal", () => {
  const yamlSource = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(yamlSource, /randomBytes/, "the smoke password must be generated per run");
  assert.doesNotMatch(yamlSource, /SMOKE_ADMIN_PASSWORD: /, "no literal smoke password in the workflow");
  assert.match(yamlSource, /SMOKE_HEALTH_EXPECT=honest/);
  assert.match(yamlSource, /RELEASE_SHA="\$GITHUB_SHA"/);
});

test("the preflight skips (not fails) when the switch is on but credentials are absent", async () => {
  // Regression: VPS_DEPLOY_ENABLED was already 'true' while the Tailscale/SSH
  // secrets were unset, so every merge to main reported a deployment failure
  // that deployed nothing (runs 45958367979 … 45963030024).
  const yaml = await (await import("../scripts/validate-workflows.mjs")).loadYaml();
  const wf = yaml.load(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const steps = wf.jobs["network-preflight"].steps;
  const classify = steps.find((step) => step.id === "readiness");
  assert.ok(classify, "a readiness classification step must exist");
  assert.match(String(classify.run), /ready=false/, "it must be able to report not-ready");
  assert.match(String(classify.run), /GITHUB_STEP_SUMMARY/, "it must say what is missing in the job summary");

  // Every step that touches Tailscale or SSH must depend on that output…
  for (const name of [
    "Tailscale connect (ephemeral tagged runner)",
    "Configure SSH (pinned host key, key material only)",
  ]) {
    const step = steps.find((entry) => entry.name === name);
    assert.ok(step, `${name} missing`);
    assert.match(String(step.if), /steps\.readiness\.outputs\.ready == 'true'/, `${name} must be gated on readiness`);
  }
  // …and a human who asked for a deployment still gets a hard failure.
  assert.match(String(classify.run), /DISPATCH_MODE" = "deploy"/, "mode=deploy must fail loudly, never skip silently");
});

test("the readiness classifier runs before every step that reads its output", async () => {
  // The first version of the fix placed the classifier AFTER the fail-closed
  // guard, so the guard still ran (and still failed) before readiness was known:
  // run 45964504678 reproduced the red job exactly. Order is the contract.
  const yaml = await (await import("../scripts/validate-workflows.mjs")).loadYaml();
  const wf = yaml.load(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const steps = wf.jobs["network-preflight"].steps;
  const classifierIndex = steps.findIndex((step) => step.id === "readiness");
  assert.ok(classifierIndex >= 0, "no readiness step");
  const readers = steps
    .map((step, index) => ({ index, text: JSON.stringify(step.if ?? "") }))
    .filter((entry) => entry.text.includes("steps.readiness.outputs"));
  assert.ok(readers.length >= 4, "expected several steps gated on readiness");
  for (const reader of readers) {
    assert.ok(
      reader.index > classifierIndex,
      `step ${reader.index + 1} ("${steps[reader.index].name}") reads readiness before it is produced (classifier is step ${classifierIndex + 1})`,
    );
  }
});

test("the fail-closed malformed-credential guard cannot fire before readiness", async () => {
  const yaml = await (await import("../scripts/validate-workflows.mjs")).loadYaml();
  const wf = yaml.load(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const steps = wf.jobs["network-preflight"].steps;
  const guard = steps.find((step) => step.name === "Fail closed if networking secrets are missing");
  assert.ok(guard, "the malformed-credential guard is missing");
  assert.match(String(guard.if), /steps\.readiness\.outputs\.ready == 'true'/, "the guard must only reject malformed credentials");
  assert.match(String(guard.run), /tskey-/, "the guard must keep the auth-key-vs-OAuth-client check");
});
