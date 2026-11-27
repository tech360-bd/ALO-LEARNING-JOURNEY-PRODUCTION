// Static checks for .github/workflows — the failures that cost real deploys.
//
// Each rule below exists because a run failed on it, not because it reads well:
//   * a required job name the repository does not have (a gate that can never pass);
//   * a `uses:` pointing at a ref that does not exist / a moving branch;
//   * a `workflow_dispatch` input no `if:` reads (a button that does nothing);
//   * a job with no runner, or a step with neither `uses` nor `run`.
//
// Pure functions over a parsed workflow object, so the tests can feed in
// deliberately broken workflows and assert the exact message.
//
// Usage:  node scripts/validate-workflows.mjs [dir]
// Exit:   0 = all workflows valid, 1 = at least one blocking finding.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The only job names this repository's gates may depend on. */
export const KNOWN_JOBS = Object.freeze({
  "ci.yml": ["validate", "security-scan"],
  "deploy.yml": ["verify", "network-preflight", "deploy"],
  "datadog-synthetics.yml": ["build"],
});

/** Actions whose major tag is checked against what the action really publishes. */
export const PINNED_ACTIONS = Object.freeze({
  "actions/checkout": { major: 7 },
  "actions/setup-node": { major: 5 },
});

const SEMVER_TAG = /^v(\d+)(?:\.\d+){0,2}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The repository has no YAML dependency of its own; js-yaml ships inside eslint.
 * A missing parser is an error, never a silent pass.
 */
export async function loadYaml() {
  try {
    const mod = await import("js-yaml");
    return mod.default ?? mod;
  } catch {
    const nested = path.join(process.cwd(), "node_modules", "@eslint", "eslintrc", "node_modules", "js-yaml", "index.js");
    const mod = await import(nested);
    return mod.default ?? mod;
  }
}

/** Every `uses: owner/repo@ref` in a workflow, with the job it belongs to. */
export function collectUses(workflow) {
  const found = [];
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    if (typeof job?.uses === "string") found.push({ jobId, uses: job.uses });
    (job?.steps ?? []).forEach((step, index) => {
      if (typeof step?.uses === "string") found.push({ jobId, stepIndex: index, uses: step.uses });
    });
  }
  return found;
}

/** `owner/repo@<40 hex or vN>` -> { repo, ref, pinned }; null for local/docker refs. */
export function parseUses(uses) {
  if (typeof uses !== "string" || uses.startsWith("./") || uses.startsWith("docker://")) return null;
  const at = uses.lastIndexOf("@");
  if (at <= 0) return null;
  const repo = uses.slice(0, at);
  const ref = uses.slice(at + 1);
  return { repo, ref, pinned: FULL_SHA.test(ref) };
}

/** Rules that need no network. Returns [{ level: "error" | "warn", message }]. */
export function lintWorkflow(fileName, workflow, { knownJobs = KNOWN_JOBS, requiresJobNames = true } = {}) {
  const findings = [];
  const push = (level, message) => findings.push({ level, message });

  if (!workflow || typeof workflow !== "object") {
    push("error", "YAML did not parse into a mapping");
    return findings;
  }
  if (typeof workflow.name !== "string" || !workflow.name.trim()) {
    push("error", "missing a top-level name (a workflow without one shows up as its file path)");
  }
  // `on:` is parsed as boolean true by YAML 1.1 parsers.
  const triggers = workflow.on ?? workflow.true;
  if (!triggers || typeof triggers !== "object" || Object.keys(triggers).length === 0) {
    push("error", "missing on: triggers");
  }
  if (workflow.permissions && workflow.permissions !== "read-all") {
    const write = Object.entries(workflow.permissions).filter(([, value]) => value === "write");
    if (write.length) push("warn", "workflow-level write permission(s): " + write.map(([key]) => key).join(", "));
  }
  if (!workflow.jobs || Object.keys(workflow.jobs).length === 0) {
    push("error", "no jobs");
    return findings;
  }

  // 1) job-name contract: a required check that does not exist can never pass.
  if (requiresJobNames && knownJobs[fileName]) {
    const declared = Object.keys(workflow.jobs);
    for (const required of knownJobs[fileName]) {
      if (!declared.includes(required)) {
        push("error", 'required job "' + required + '" is gone; a gate names it (declared: ' + declared.join(", ") + ")");
      }
    }
    for (const jobId of declared) {
      if (!knownJobs[fileName].includes(jobId)) {
        push("warn", 'undeclared job "' + jobId + '" - add it to KNOWN_JOBS once a gate depends on it');
      }
    }
  }

  // 2) action pins: a wrong major tag fails before any of our code runs.
  const seen = new Map();
  for (const { jobId, stepIndex, uses } of collectUses(workflow)) {
    const parsed = parseUses(uses);
    if (!parsed) continue;
    const where = stepIndex === undefined ? 'job "' + jobId + '"' : 'job "' + jobId + '" step ' + (stepIndex + 1);
    if (!parsed.pinned) {
      const known = PINNED_ACTIONS[parsed.repo];
      if (parsed.ref === "master" || parsed.ref === "main") {
        // A branch ref is not a version at all: it moves on every upstream push
        // and can change the code under a green build.
        push("error", where + " uses " + uses + " - not a full 40-character commit SHA or a reviewed major tag");
      } else if (known && parsed.ref !== "v" + known.major) {
        push("error", where + " uses " + uses + " - this repository pins " + parsed.repo + " to v" + known.major);
      } else if (SEMVER_TAG.test(parsed.ref) || parsed.ref === "master" || parsed.ref === "main") {
        push("warn", where + " uses " + uses + " (a moving ref); prefer a full commit SHA");
      } else {
        push("error", where + " uses " + uses + " - not a full 40-character commit SHA or a reviewed major tag");
      }
    }
    const key = parsed.repo + "@" + parsed.ref;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) push("warn", key + " is used " + count + " times - keep them on the same pin");
  }

  // 3) workflow_dispatch inputs nothing reads: a mode selector that no-ops.
  const dispatch = triggers && typeof triggers === "object" ? triggers.workflow_dispatch : undefined;
  const inputs = dispatch && typeof dispatch === "object" ? Object.keys(dispatch.inputs ?? {}) : [];
  if (inputs.length) {
    const text = JSON.stringify(workflow);
    for (const input of inputs) {
      if (!text.includes("inputs." + input)) {
        push("error", 'workflow_dispatch input "' + input + '" is declared but no condition or step reads it');
      }
    }
  }

  // 4) structure: every job has a runner, every step does something.
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!job || typeof job !== "object") {
      push("error", 'job "' + jobId + '" is not a mapping');
      continue;
    }
    const callable = typeof job.uses === "string";
    const hasRunner = typeof job["runs-on"] === "string" || Array.isArray(job["runs-on"]);
    if (!callable && !hasRunner) {
      push("error", 'job "' + jobId + '" has neither runs-on nor a reusable uses: workflow');
    }
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (typeof step !== "object" || step === null) {
        push("error", 'job "' + jobId + '" step ' + (index + 1) + " is not a mapping");
        continue;
      }
      if (!step.uses && !step.run) {
        push("error", 'job "' + jobId + '" step ' + (index + 1) + " has neither uses nor run");
      }
      if (step.uses && step.run) {
        push("warn", 'job "' + jobId + '" step ' + (index + 1) + " sets both uses and run");
      }
    }
  }

  return findings;
}

/** Reads a directory of workflow files and lints each one. */
export async function lintDirectory(dir) {
  const yaml = await loadYaml();
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  const report = [];
  for (const fileName of files) {
    const source = readFileSync(path.join(dir, fileName), "utf8");
    let parsed;
    try {
      parsed = yaml.load(source);
    } catch (error) {
      report.push({ file: fileName, findings: [{ level: "error", message: "YAML parse error: " + String(error.message).split("\n")[0] }] });
      continue;
    }
    report.push({ file: fileName, findings: lintWorkflow(fileName, parsed) });
  }
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const dir = process.argv[2] ?? ".github/workflows";
  const report = await lintDirectory(dir);
  let errors = 0;
  for (const { file, findings } of report) {
    for (const finding of findings) {
      if (finding.level === "error") errors += 1;
      const line = (finding.level === "error" ? "::error file=" : "::warning file=") + dir + "/" + file + "::" + file + ": " + finding.message;
      (finding.level === "error" ? console.error : console.log)(line);
    }
  }
  const filesWithErrors = report.filter((entry) => entry.findings.some((finding) => finding.level === "error")).length;
  console.log(report.length + " workflow file(s) checked; " + errors + " error(s) in " + filesWithErrors + " file(s).");
  process.exitCode = errors ? 1 : 0;
}
