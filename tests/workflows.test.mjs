import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
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
  // The job must publish its verdict for the deploy job to consume…
  assert.equal(String(wf.jobs["network-preflight"].outputs?.ready ?? "").includes("steps.readiness.outputs.ready"), true);
  // …and a green-but-skipped preflight must never authorise a deployment.
  assert.match(String(wf.jobs.deploy.if), /needs\.network-preflight\.outputs\.ready == 'true'/);
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

test("an unusable credential pair is a configuration gap, not a red merge", async () => {
  // Run 45967580663: client id 17 chars, secret 17 chars — present but dummy.
  // Nothing in the codebase can fix that, so the run must be neutral (skipped)
  // and only a human asking for mode=deploy may turn it into a failure.
  const yaml = await (await import("../scripts/validate-workflows.mjs")).loadYaml();
  const wf = yaml.load(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const steps = wf.jobs["network-preflight"].steps;
  const classify = steps.find((step) => step.id === "readiness");
  assert.match(String(classify.run), /placeholder_oauth_pair/, "placeholder pairs must be named as such");
  assert.match(String(classify.run), /reason=/, "the reason must be published as an output");
  // The only hard failure on the automatic path is a human's mode=deploy.
  const hardFailures = steps.filter((step) => /mode=deploy/.test(String(step.run ?? "")) && /exit 1/.test(String(step.run ?? "")));
  assert.equal(hardFailures.length, 1);
  // No step may fail the job merely because the credentials are absent.
  const failClosed = steps.find((step) => step.name === "Fail closed if networking secrets are missing");
  assert.match(String(failClosed.if), /steps\.readiness\.outputs\.ready == 'true'/);
});

test("the readiness classifier, executed as written, classifies all five states", async () => {
  // Extracts the real shell body from deploy.yml and runs it. This is the check
  // that would have caught run 45969514987: the pair was a placeholder, every
  // variable was filled, `missing` was empty, and the classifier said ready=true
  // while the guard rejected the same pair three steps later.
  const yaml = await (await import("../scripts/validate-workflows.mjs")).loadYaml();
  const wf = yaml.load(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const body = wf.jobs["network-preflight"].steps.find((step) => step.id === "readiness").run;
  const bodyPath = path.join(mkdtempSync(path.join(tmpdir(), "alo-classify-")), "classify.sh");
  writeFileSync(bodyPath, body);

  const real = { TS_CLIENT_ID: `k${"A".repeat(18)}CNTRL`, TS_CLIENT_SECRET: "x".repeat(44) };
  const placeholder = { TS_CLIENT_ID: "abcdefghijklmnopq", TS_CLIENT_SECRET: "abcdefghijklmnopq" };
  const host = { SERVER_HOST: "100.64.0.5", VPS_USER: "alamin", VPS_SSH_KEY: "key", VPS_SSH_HOST_KEY: "hostkey" };

  const runCase = (env) => {
    const out = mkdtempSync(path.join(tmpdir(), "alo-out-"));
    const result = spawnSync("bash", [bodyPath], {
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: env.GITHUB_EVENT_NAME ?? "push",
        DISPATCH_MODE: env.DISPATCH_MODE ?? "",
        TS_CLIENT_ID: env.TS_CLIENT_ID ?? "",
        TS_CLIENT_SECRET: env.TS_CLIENT_SECRET ?? "",
        TS_AUTH_KEY: "",
        SERVER_HOST: env.SERVER_HOST ?? "",
        VPS_USER: env.VPS_USER ?? "",
        VPS_SSH_KEY: env.VPS_SSH_KEY ?? "",
        VPS_SSH_HOST_KEY: env.VPS_SSH_HOST_KEY ?? "",
        GITHUB_OUTPUT: path.join(out, "out"),
        GITHUB_ENV: path.join(out, "env"),
        GITHUB_STEP_SUMMARY: path.join(out, "summary"),
      },
      encoding: "utf8",
    });
    const outputs = readFileSync(path.join(out, "out"), "utf8");
    const ready = /^ready=(.*)$/m.exec(outputs)?.[1];
    const reason = /^reason=(.*)$/m.exec(outputs)?.[1];
    return { status: result.status, ready, reason };
  };

  // 1) today's repository: the pair exists but is a placeholder
  const placeholders = runCase({ ...placeholder, ...host });
  assert.equal(placeholders.status, 0, "a placeholder pair must not fail the job");
  assert.equal(placeholders.ready, "false");
  assert.equal(placeholders.reason, "placeholder_oauth_pair");

  // 2) nothing configured at all
  const missing = runCase({});
  assert.equal(missing.status, 0);
  assert.equal(missing.ready, "false");
  assert.equal(missing.reason, "missing_secrets");

  // 3) a usable pair: the network steps may run
  const usable = runCase({ ...real, ...host });
  assert.equal(usable.status, 0);
  assert.equal(usable.ready, "true");

  // 4) a human asking for a deployment with a placeholder pair must fail loudly
  const manual = runCase({ ...placeholder, ...host, GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_MODE: "deploy" });
  assert.equal(manual.status, 1);
  assert.equal(manual.ready, "false");

  // 5) …and succeed when the pair is real
  const manualReal = runCase({ ...real, ...host, GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_MODE: "deploy" });
  assert.equal(manualReal.status, 0);
  assert.equal(manualReal.ready, "true");
});

test("the skip annotation carries the reason, not a literal placeholder", () => {
  // Run 45970909472 printed "notice: {reason}: — ..." because `{reason}` outside
  // `${...}` is literal text. The annotation is the only thing a human sees, so
  // it must contain the shell variable, never the braces.
  const source = readFileSync(".github/workflows/deploy.yml", "utf8");
  assert.doesNotMatch(source, /::notice[^\n]*\{reason\}/, "unexpanded {reason} in an annotation");
  assert.match(source, /\$reason/, "the reason must be interpolated by the shell");
});
