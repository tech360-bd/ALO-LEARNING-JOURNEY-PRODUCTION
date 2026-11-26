import test from "node:test";
import assert from "node:assert/strict";
import { OMNI_CATALOG, getCatalogEntry, catalogSummary } from "../src/lib/omni/catalog.ts";

test("catalog has built-in callable providers", () => {
  for (const id of ["groq", "llm7", "opencode", "openrouter", "omniroute", "local-ollama"]) {
    const entry = getCatalogEntry(id);
    assert.ok(entry, `missing catalog entry: ${id}`);
    assert.equal(entry.callable, true, `${id} should be callable`);
    assert.ok(entry.freeTierNote.length > 0, `${id} missing free-tier note`);
    assert.ok(entry.docsUrl.startsWith("http"), `${id} missing docs URL`);
  }
});

test("catalog-only providers are documented but never callable", () => {
  const catalogOnly = OMNI_CATALOG.filter((e) => e.tier === "catalog-only");
  assert.ok(catalogOnly.length >= 10, "expected a meaningful catalog of free-tier providers");
  for (const e of catalogOnly) {
    assert.equal(e.callable, false, `${e.id} must not be callable without owner opt-in`);
  }
});

test("openrouter note documents 300+ free models", () => {
  const openrouter = getCatalogEntry("openrouter");
  assert.ok(openrouter.freeModelCountHint >= 300, "OpenRouter should hint 300+ free models");
});

test("no provider entry carries an API key literal", () => {
  for (const e of OMNI_CATALOG) {
    // Only env var NAMES are allowed — never secret values.
    assert.ok(!e.apiKeyEnv || /^[A-Z0-9_]+$/.test(e.apiKeyEnv), `bad apiKeyEnv on ${e.id}`);
  }
});

test("catalogSummary aggregates honestly", () => {
  const s = catalogSummary();
  assert.equal(s.totalEntries, OMNI_CATALOG.length);
  assert.equal(s.callableNow + s.catalogOnly, s.totalEntries);
  assert.ok(s.freeModelHints > 0);
  assert.match(s.note, /verif/i, "summary must tell the owner to verify current free-tier terms");
});

test("every kind is one of the supported kinds", () => {
  const kinds = new Set(["chat", "embedding", "image", "tts", "stt", "search", "vision"]);
  for (const e of OMNI_CATALOG) {
    assert.ok(kinds.has(e.kind), `unknown kind ${e.kind} on ${e.id}`);
    assert.ok(["builtin", "gateway", "catalog-only"].includes(e.tier), `unknown tier on ${e.id}`);
  }
});
