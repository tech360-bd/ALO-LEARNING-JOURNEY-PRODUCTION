import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESCRIPTION, TOPICS, validate } from "../scripts/apply-repo-metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const exists = (file) => readFile(path.join(root, file)).then(() => true, () => false);

test("repository metadata is a valid GitHub payload", () => {
  assert.deepEqual(validate({ description: DESCRIPTION, topics: TOPICS }), []);
  assert.ok(TOPICS.length <= 20, "GitHub allows at most 20 topics");
  assert.equal(new Set(TOPICS).size, TOPICS.length, "topics must be unique");
  assert.ok(DESCRIPTION.length <= 350);
  for (const topic of TOPICS) {
    assert.match(topic, /^[a-z0-9][a-z0-9-]{0,49}$/, `${topic} is not a valid GitHub topic slug`);
  }
});

test("the evaluated topic is present", () => {
  assert.ok(TOPICS.includes("jarvis-ai"));
});

test("every topic is backed by code in this repository", async () => {
  // Topics are discovery metadata; claiming a capability the code does not have
  // is exactly the kind of unverified claim this repo's audits reject.
  const evidence = {
    "jarvis-ai": ["src/lib/super-admin/runs.ts", "src/lib/super-admin/chat.ts"],
    "ai-agent": ["src/lib/agent-runtime.ts", "src/lib/agent-loop.ts"],
    "agent-os": ["src/lib/agentos/skill-validator.ts", "src/lib/agentos/payment-guard.ts"],
    "agent-orchestration": ["src/lib/omni/router.ts"],
    "ai-assistant": ["src/app/super-admin/page.tsx"],
    bengali: ["src/lib/voice-engine.ts"],
    bangla: ["src/lib/asr-engine.ts"],
    llm: ["src/lib/external-ai.ts"],
    "ai-routing": ["src/lib/omni/catalog.ts", "src/lib/ai-chain.ts"],
    "self-healing": ["src/lib/self-heal/detector.ts", "src/lib/self-heal/fixer.ts"],
    "openai-alternative": ["src/lib/omni/catalog.ts"],
    "text-to-speech": ["src/lib/voice-engine.ts"],
    "speech-recognition": ["src/lib/asr-engine.ts"],
    "voice-assistant": ["src/components/alo/VoiceStudioView.tsx"],
    ffmpeg: ["scripts/verify-media-pipeline.mjs", "src/lib/local-audio.ts"],
    whisper: ["src/lib/asr-engine.ts"],
    nextjs: ["next.config.ts"],
    typescript: ["tsconfig.json"],
    prisma: ["prisma/schema.prisma"],
    mysql: ["prisma/migrations/migration_lock.toml"],
  };
  for (const [topic, files] of Object.entries(evidence)) {
    assert.ok(TOPICS.includes(topic), `${topic} has evidence but is not advertised`);
    for (const file of files) {
      assert.ok(await exists(file), `${topic} claims ${file}, which does not exist`);
    }
  }
  // Nothing may be advertised without evidence.
  const unsupported = TOPICS.filter((topic) => !(topic in evidence));
  assert.deepEqual(unsupported, [], `advertised without code evidence: ${unsupported.join(", ")}`);
});

test("the bundler, ORM and language topics match the actual manifests", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.ok(pkg.dependencies.next, "nextjs topic requires a Next.js dependency");
  assert.ok(pkg.devDependencies.typescript, "typescript topic requires a TypeScript dev dependency");
  assert.ok(pkg.dependencies["@prisma/client"], "prisma topic requires @prisma/client");
  assert.ok(pkg.dependencies["@prisma/client"].length > 0);
  const schema = await read("prisma/schema.prisma");
  assert.match(schema, /provider\s*=\s*"mysql"/, "mysql topic requires a MySQL datasource");
});

test("withheld topics are genuinely absent from the code", async () => {
  // MCP was considered and dropped: no server, client, or transport exists here.
  assert.ok(!TOPICS.includes("mcp"));
  const hits = [];
  for (const dir of ["src", "scripts"]) {
    const { readdir } = await import("node:fs/promises");
    const walk = async (current) => {
      for (const entry of await readdir(path.join(root, current), { withFileTypes: true })) {
        const next = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(next);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name) && entry.name !== "apply-repo-metadata.mjs") {
          if (/\bmodelcontextprotocol\b|\bMcpServer\b/.test(await read(next))) hits.push(next);
        }
      }
    };
    await walk(dir);
  }
  assert.deepEqual(hits, [], `MCP implementation found, add the topic back: ${hits.join(", ")}`);
});

test("topics and description are written independently, and a description 403 is not fatal", async () => {
  // A token scoped for topics often lacks classic `administration`, so
  // `PATCH /repos/:owner/:repo` returns 403. That used to abort the script after
  // the topics were already written. Topics must survive, the description must
  // be reported, and the exit path must not treat this as total failure.
  const { apply } = await import("../scripts/apply-repo-metadata.mjs");
  const calls = [];
  const warnings = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${String(url).replace("https://api.github.com", "")}`);
    if (method === "PUT" && String(url).endsWith("/topics")) {
      return new Response(JSON.stringify({ names: ["jarvis-ai", "ai-agent"] }), { status: 200 });
    }
    if (method === "PATCH") {
      return new Response(JSON.stringify({ message: "Resource not accessible by integration", status: 403 }), { status: 403 });
    }
    if (method === "GET" && String(url).endsWith("/topics")) {
      return new Response(JSON.stringify({ names: ["jarvis-ai", "ai-agent"] }), { status: 200 });
    }
    return new Response(JSON.stringify({ description: null }), { status: 200 });
  };
  try {
    const result = await apply({
      repo: "owner/name",
      description: "test description",
      topics: ["jarvis-ai", "ai-agent"],
      token: "test-token",
      log: () => {},
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.topics.ok, true);
    assert.equal(result.description.ok, false);
    assert.equal(result.fullyApplied, false);
    assert.deepEqual(result.final.topics, ["jarvis-ai", "ai-agent"]);
    assert.ok(warnings.some((w) => /administration/.test(w)), "the operator is told which scope is missing");
    // Both writes were attempted, and the description failure did not skip it.
    assert.ok(calls.includes("PUT /repos/owner/name/topics"));
    assert.ok(calls.includes("PATCH /repos/owner/name"));
  } finally {
    globalThis.fetch = original;
  }
});
