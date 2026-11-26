#!/usr/bin/env node
/**
 * Apply the repository's GitHub topics and description.
 *
 * Discovery metadata only: this script talks to the GitHub REST API and never
 * touches the application, the database, or the deploy pipeline. Run it with a
 * token that has `administration` on the repository:
 *
 *   GH_TOKEN=... node scripts/apply-repo-metadata.mjs --dry-run
 *   GH_TOKEN=... node scripts/apply-repo-metadata.mjs
 *
 * Only the names below are sent, so unrelated topics that already exist are
 * kept. GitHub allows 20 topics per repository; the list is validated here to
 * fail early instead of half-applying.
 */

export const DESCRIPTION =
  "Bengali-first AI learning and workforce platform: Super Admin command center, omni-routed free-tier AI, local Bangla voice (TTS/ASR), photo-to-video studio, CRM, and self-healing operations.";

export const TOPICS = [
  // The topic the repository was evaluated against.
  "jarvis-ai",
  // What the product actually is.
  "ai-agent",
  "agent-os",
  "agent-orchestration",
  "ai-assistant",
  "bengali",
  "bangla",
  // How the agent layer is built.
  "llm",
  "ai-routing",
  "self-healing",
  "openai-alternative",
  // Voice + media pipeline.
  "text-to-speech",
  "speech-recognition",
  "voice-assistant",
  "ffmpeg",
  "whisper",
  // Application stack.
  "nextjs",
  "typescript",
  "prisma",
  "mysql",
];

const MAX_TOPICS = 20;
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

export function validate({ description, topics }) {
  const problems = [];
  if (typeof description !== "string" || description.trim().length === 0) problems.push("description is empty");
  if (description.length > 350) problems.push(`description is ${description.length} characters (max 350)`);
  if (!Array.isArray(topics)) problems.push("topics must be an array");
  else {
    if (topics.length > MAX_TOPICS) problems.push(`${topics.length} topics exceed GitHub's limit of ${MAX_TOPICS}`);
    for (const topic of topics) {
      if (!TOPIC_PATTERN.test(topic)) problems.push(`invalid topic: ${topic}`);
    }
    const duplicates = topics.filter((topic, index) => topics.indexOf(topic) !== index);
    if (duplicates.length) problems.push(`duplicate topics: ${duplicates.join(", ")}`);
  }
  return problems;
}

function parseArgs(argv) {
  const flags = { dryRun: false, repo: process.env.GITHUB_REPOSITORY || "tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--repo") flags.repo = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") flags.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return flags;
}

async function api(path, { method = "GET", body, token, accept = "application/vnd.github+json" } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function apply({ repo, description, topics, token, log = console.log, warn = console.warn }) {
  const current = await api(`/repos/${repo}/topics`, { token, accept: "application/vnd.github.mercy-preview+json" });
  const before = current?.names ?? [];
  const merged = [...new Set([...before, ...topics])];
  const problems = validate({ description, topics: merged });
  if (problems.length) throw new Error(`refusing to apply:\n- ${problems.join("\n- ")}`);

  log(`repository: ${repo}`);
  log(`existing topics (${before.length}): ${before.join(", ") || "<none>"}`);
  log(`adding         (${topics.length}): ${topics.join(", ")}`);
  log(`result         (${merged.length}): ${merged.join(", ")}`);
  log(`description: ${description}`);

  // The two writes need different token scopes: `/topics` needs the newer
  // topic permission, while `PATCH /repos/{owner}/{repo}` needs classic
  // "administration". A token that can set topics often cannot set the
  // description, and a failed description used to abort the script *after* the
  // topics had already been written. Each write is therefore independent, and
  // the exit code reflects only the failures that actually happened.
  const results = { topics: { ok: false, value: before, error: null }, description: { ok: false, value: null, error: null } };

  try {
    const applied = await api(`/repos/${repo}/topics`, {
      method: "PUT",
      body: { names: merged },
      token,
      accept: "application/vnd.github.mercy-preview+json",
    });
    results.topics = { ok: true, value: applied?.names ?? merged, error: null };
    log(`topics applied (${results.topics.value.length})`);
  } catch (error) {
    results.topics.error = error.message;
    warn(`topics not applied: ${firstLine(error.message)}`);
  }

  try {
    const patched = await api(`/repos/${repo}`, { method: "PATCH", body: { description }, token });
    results.description = { ok: true, value: patched?.description ?? description, error: null };
    log(`description applied`);
  } catch (error) {
    results.description.error = error.message;
    if (isPermissionError(error.message)) {
      warn(
        "description NOT applied: this token lacks permission for PATCH /repos/{owner}/{repo} " +
          "(classic tokens need the `administration` scope; fine-grained tokens need " +
          "Repository permissions → Administration: Read and write).",
      );
      warn(`Set it by hand: GitHub → Settings → General → Description, or rerun with a token that has the scope.`);
    } else {
      warn(`description not applied: ${firstLine(error.message)}`);
    }
  }

  // Describe what is actually true now, not what was requested.
  let now = { description: null, topics: [] };
  try {
    const after = await api(`/repos/${repo}`, { token });
    const topicState = await api(`/repos/${repo}/topics`, { token, accept: "application/vnd.github.mercy-preview+json" });
    now = { description: after?.description ?? null, topics: topicState?.names ?? [] };
  } catch {
    // Reporting is best-effort; the write results above are authoritative.
  }

  return {
    ...results,
    final: now,
    fullyApplied: results.topics.ok && results.description.ok,
    descriptionMissing: !results.topics.ok,
  };
}

function firstLine(message) {
  return String(message ?? "").split("\n")[0].slice(0, 200);
}

function isPermissionError(message) {
  return /403|not accessible|Resource not accessible|Must have admin/i.test(String(message ?? ""));
}

const isMain = process.argv[1] && process.argv[1].endsWith("apply-repo-metadata.mjs");
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log("usage: node scripts/apply-repo-metadata.mjs [--dry-run] [--repo owner/name]");
    process.exit(0);
  }
  const problems = validate({ description: DESCRIPTION, topics: TOPICS });
  if (problems.length) {
    console.error(`refusing to run:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  if (flags.dryRun || !process.env.GH_TOKEN) {
    if (!flags.dryRun) console.error("GH_TOKEN is unset — showing the plan only (same as --dry-run).");
    console.log(`repository: ${flags.repo}`);
    console.log(`topics (${TOPICS.length}/${MAX_TOPICS}): ${TOPICS.join(", ")}`);
    console.log(`description: ${DESCRIPTION}`);
    process.exit(0);
  }
  try {
    const result = await apply({ repo: flags.repo, description: DESCRIPTION, topics: TOPICS, token: process.env.GH_TOKEN });
    console.log("\napplied:");
    console.log(`  topics      (${result.topics.ok ? "ok" : "FAILED"}, ${result.final.topics.length}): ${result.final.topics.join(", ")}`);
    console.log(`  description (${result.description.ok ? "ok" : "FAILED"}): ${result.final.description ?? "<unchanged>"}`);
    if (!result.fullyApplied) {
      console.log("\nThe repository is in a usable state, but the run was partial. Fix the failing write above and rerun (topics are merged, so it is safe to repeat).");
      // Only a total failure is a non-zero exit: a topics-only success is not an
      // error the operator must abort a pipeline for.
      if (!result.topics.ok && !result.description.ok) process.exit(1);
    }
  } catch (error) {
    console.error(`failed: ${error.message}`);
    process.exit(1);
  }
}
