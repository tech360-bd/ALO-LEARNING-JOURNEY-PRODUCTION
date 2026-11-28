import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildIsolatedRestoreDbName,
  buildIsolatedRestoreUrl,
  parseMysqlConnection,
  sha256File,
  verifyMediaArchiveExcludesSecrets,
  runBackupRestoreRehearsal,
} from "../scripts/test-backup-restore.mjs";

test("backup/restore rehearsal refuses production NODE_ENV and production DB names", async () => {
  const prevEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "mysql://user:pass@127.0.0.1:3306/db_learn";
    await assert.rejects(() => runBackupRestoreRehearsal(), /Blocked:/);

    process.env.NODE_ENV = "test";
    process.env.CI = "false";
    process.env.DATABASE_URL = "mysql://user:pass@127.0.0.1:3306/db_learn";
    await assert.rejects(() => runBackupRestoreRehearsal(), /Blocked:/);

    process.env.DATABASE_URL = "mysql://user:pass@100.85.239.114:3306/db_test";
    await assert.rejects(() => runBackupRestoreRehearsal(), /Blocked:.*local database/);
  } finally {
    process.env = prevEnv;
  }
});

test("isolated restore database name and URL isolate from the source database", () => {
  const restoreDb = buildIsolatedRestoreDbName("ci");
  assert.match(restoreDb, /^ci_restore_test_[0-9a-f]{8}$/);
  assert.notEqual(restoreDb, "ci");
  assert.notEqual(restoreDb, "db_learn");

  const url = buildIsolatedRestoreUrl("mysql://ci:secret@127.0.0.1:3306/ci", restoreDb);
  const parsed = parseMysqlConnection(url);
  assert.equal(parsed.database, restoreDb);
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, "3306");
});

test("media archive verification excludes .env, .pem, and .key secrets while keeping media", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alo-media-archive-test-"));
  const archive = path.join(dir, "media.tar.gz");
  try {
    const src = path.join(dir, "src");
    fs.mkdirSync(path.join(src, "avatars"), { recursive: true });
    fs.mkdirSync(path.join(src, "generated"), { recursive: true });
    fs.writeFileSync(path.join(src, "avatars", "portrait.png"), "png");
    fs.writeFileSync(path.join(src, "generated", "clip.mp4"), "mp4");
    fs.writeFileSync(path.join(src, ".env"), "NEXTAUTH_SECRET=bad");
    fs.writeFileSync(path.join(src, "avatars", ".env.local"), "SECRET=bad");
    fs.writeFileSync(path.join(src, "tls.key"), "KEY");
    fs.writeFileSync(path.join(src, "cert.pem"), "CERT");

    const entries = verifyMediaArchiveExcludesSecrets(src, archive);
    assert.ok(entries.some((e) => e.endsWith("avatars/portrait.png")));
    assert.ok(entries.some((e) => e.endsWith("generated/clip.mp4")));
    assert.equal(entries.some((e) => e.includes(".env") || e.endsWith(".key") || e.endsWith(".pem")), false);
    assert.match(sha256File(archive), /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
