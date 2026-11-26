import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Both avatar routes used to swallow every provider failure and still answer
 * 201 with a row that contains no portrait / no media:
 *
 *   POST /api/ai/avatar        -> `{ id, name, faceImageUrl: null, voiceId }`
 *   POST /api/ai/avatar-video  -> `{ contentId, videoStatus: 'rate_limited' }`
 *
 * A caller cannot tell those apart from success, which is exactly the kind of
 * fake success the zero-placeholder policy forbids. A provider refusal must
 * surface as an explicit 503 (nothing was produced) with the real reason.
 */

test("avatar creation fails loudly when no portrait was generated", async () => {
  const source = await read("src/app/api/ai/avatar/route.ts");
  assert.match(source, /if \(!faceImageUrl\)/);
  assert.match(source, /error: 'avatar_portrait_unavailable'/);
  assert.match(source, /status: 503/);
  // The provider error must be captured, not discarded.
  assert.doesNotMatch(source, /if \(result\.data\?\.\[0\]\?\.base64\) faceImageUrl[^\n]*\n\s*\} catch \{\}/);
  assert.match(source, /imageError = error instanceof Error/);
  // No provider keys in the response.
  assert.doesNotMatch(source, /apiKey|API_KEY/);
});

test("avatar video fails loudly when neither renderer nor speech produced media", async () => {
  const source = await read("src/app/api/ai/avatar-video/route.ts");
  assert.match(source, /if \(!videoTaskId && !audioUrl\)/);
  assert.match(source, /error: 'avatar_render_unavailable'/);
  assert.match(source, /status: 503/);
  // "rate_limited" was a catch-all label for every failure mode.
  assert.doesNotMatch(source, /videoStatus = 'rate_limited'/);
  assert.match(source, /videoError = error instanceof Error/);
  assert.match(source, /audioError = error instanceof Error/);
});

test("a successful render still records the content row and warnings", async () => {
  const source = await read("src/app/api/ai/avatar-video/route.ts");
  assert.match(source, /const content = await db\.content\.create/);
  assert.match(source, /videoWarning: videoError/);
  assert.match(source, /audioWarning: audioError/);
});

test("no route in src returns a 501 or an explicit not-implemented body", async () => {
  const { readdir } = await import("node:fs/promises");
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const source = await read(next);
        if (/status:\s*501\b/.test(source)) offenders.push(`${next}: 501`);
        if (/\bTODO\b|\bFIXME\b/.test(source)) offenders.push(`${next}: TODO/FIXME`);
      }
    }
  };
  await walk("src");
  assert.deepEqual(offenders, [], `unfinished handlers: ${offenders.join(", ")}`);
});

test("approving a mutation is gated by the owner session, not only the gateway", async () => {
  const source = await read("src/app/api/approvals/route.ts");
  assert.match(source, /import \{ requireOwner \} from "@\/lib\/auth"/);
  // Both the read and the write path must check.
  const guards = source.match(/const denied = await guard\(\);/g) ?? [];
  assert.equal(guards.length, 2, "GET and POST must both guard");
  assert.match(source, /if \(denied\) return denied;/);
  // The gateway allowlist must not hand this route a MarketingOS tenant token.
  const bearer = await read("src/lib/bearer-auth.ts");
  assert.doesNotMatch(bearer, /"\/api\/approvals"/);
});
