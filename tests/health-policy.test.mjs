import test from "node:test";
import assert from "node:assert/strict";
import { mysqlConfigurationDetail, mysqlConfigurationOk } from "../src/lib/health-policy.mjs";

/**
 * `/api/health` used to return 503 in every local and preview environment
 * because the MySQL check was critical even though `src/lib/db.ts` explicitly
 * supports a development-only JSON fallback. The public probe is what a
 * platform health check and the deploy preflight call, so a false 503 blocks
 * real work.
 */

test("production still refuses anything but MySQL", () => {
  const production = (databaseUrl) => mysqlConfigurationOk({ nodeEnv: "production", databaseUrl });
  assert.equal(production("mysql://u:p@127.0.0.1:3306/db_learn"), true);
  assert.equal(production("mysqls://u:p@host:3306/db"), true);
  assert.equal(production(undefined), false);
  assert.equal(production(""), false);
  assert.equal(production("file:./dev.db"), false);
  assert.equal(production("postgresql://u:p@host/db"), false);
});

test("outside production an unset DATABASE_URL is the documented fallback, not a failure", () => {
  for (const nodeEnv of ["development", "test", undefined]) {
    assert.equal(mysqlConfigurationOk({ nodeEnv, databaseUrl: undefined }), true);
    assert.equal(mysqlConfigurationOk({ nodeEnv, databaseUrl: "" }), true);
    assert.equal(mysqlConfigurationOk({ nodeEnv, databaseUrl: "file:./dev.db" }), true);
    assert.equal(mysqlConfigurationOk({ nodeEnv, databaseUrl: "mysql://u:p@127.0.0.1/db" }), true);
  }
});

test("details never leak credentials", () => {
  const cases = [
    { nodeEnv: "production", databaseUrl: "mysql://user:secret@127.0.0.1:3306/db" },
    { nodeEnv: "production", databaseUrl: undefined },
    { nodeEnv: "development", databaseUrl: "file:./dev.db" },
    { nodeEnv: "development", databaseUrl: undefined },
  ];
  for (const input of cases) {
    const detail = mysqlConfigurationDetail(input);
    assert.equal(typeof detail, "string");
    assert.doesNotMatch(detail, /secret|password/i);
    assert.doesNotMatch(detail, /@/);
  }
});
