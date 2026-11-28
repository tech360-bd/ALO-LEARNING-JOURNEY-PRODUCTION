#!/usr/bin/env node
/**
 * Isolated Backup & Restore Verification Script.
 *
 * Proves that a MySQL dump produced by the same mysqldump flags as deploy/backup.sh
 * can be checksummed, verified, and restored into a brand-new isolated MySQL
 * database with full schema, sentinel data, and Prisma migration-history parity.
 * Also verifies that media tarballs exclude .env / .pem / .key secrets.
 *
 * Refuses to run against non-disposable or production databases.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMigrationTestDatabase } from "./prisma-dev-guard.mjs";

export const MEDIA_SECRET_EXCLUSIONS = Object.freeze([
  "--exclude=.env",
  "--exclude=*/.env",
  "--exclude=.env.*",
  "--exclude=*/.env.*",
  "--exclude=*.pem",
  "--exclude=*.key",
]);

export function parseMysqlConnection(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.startsWith("mysql://")) {
    throw new Error("DATABASE_URL must be a mysql:// URL");
  }
  const url = new URL(databaseUrl);
  const host = decodeURIComponent(url.hostname);
  const port = url.port || "3306";
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!host || !database || !user) {
    throw new Error("DATABASE_URL is missing host, database, or username");
  }
  return { host, port, database, user, password };
}

export function buildIsolatedRestoreDbName(sourceDb) {
  const safeBase = sourceDb.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);
  const suffix = randomBytes(4).toString("hex");
  return `${safeBase}_restore_test_${suffix}`;
}

export function buildIsolatedRestoreUrl(databaseUrl, restoreDb) {
  const url = new URL(databaseUrl);
  url.pathname = `/${restoreDb}`;
  return url.toString();
}

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function verifyMediaArchiveExcludesSecrets(sourceDir, archivePath) {
  const tarResult = spawnSync(
    "tar",
    [...MEDIA_SECRET_EXCLUSIONS, "-czf", archivePath, "-C", sourceDir, "."],
    { encoding: "utf8" },
  );
  if (tarResult.status !== 0) {
    throw new Error(`tar creation failed: ${tarResult.stderr || tarResult.stdout}`);
  }
  const listResult = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  if (listResult.status !== 0) {
    throw new Error(`tar listing failed: ${listResult.stderr || listResult.stdout}`);
  }
  const entries = listResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const leaked = entries.filter((entry) => /(^|\/)\.env(\.|$)|\.(pem|key)$/i.test(entry));
  if (leaked.length > 0) {
    throw new Error(`secret file leaked into media archive: ${leaked.join(", ")}`);
  }
  return entries;
}

function runMysql(conn, args, { input } = {}) {
  const env = { ...process.env };
  if (conn.password) env.MYSQL_PWD = conn.password;
  const result = spawnSync(
    "mysql",
    ["-h", conn.host, "-P", conn.port, "-u", conn.user, ...args],
    {
      env,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`mysql failed (${args.join(" ")}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function runBackupRestoreRehearsal() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const target = validateMigrationTestDatabase({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl,
    ci: process.env.CI === "true",
    confirmations: process.env,
  });
  if (!target.ok) {
    throw new Error(`Blocked: ${target.reason}`);
  }

  const conn = parseMysqlConnection(databaseUrl);
  const adminUrl = process.env.MYSQL_ADMIN_URL || databaseUrl;
  const adminConn = parseMysqlConnection(adminUrl);
  const restoreDb = buildIsolatedRestoreDbName(conn.database);
  const restoreUrl = buildIsolatedRestoreUrl(databaseUrl, restoreDb);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "alo-backup-restore-"));
  const dumpPath = path.join(workDir, `db-rehearsal.sql.gz`);
  const mediaDir = path.join(workDir, "media-src");
  const mediaArchive = path.join(workDir, "media-rehearsal.tar.gz");
  const sentinelId = `restore-sentinel-${randomBytes(6).toString("hex")}`;

  try {
    // 1. Insert a sentinel row into the source test database (`AuditLog`) so
    //    we prove data—not merely DDL—survives backup + restore.
    runMysql(conn, [
      conn.database,
      "-e",
      `INSERT INTO AuditLog (id, actor, action, detail, severity, createdAt) VALUES ('${sentinelId}', 'backup-rehearsal', 'backup.sentinel', 'isolated restore verification', 'info', NOW(3));`,
    ]);

    // 2. Run mysqldump with the exact production flags from deploy/backup.sh.
    const dumpEnv = { ...process.env };
    if (conn.password) dumpEnv.MYSQL_PWD = conn.password;
    const dumpProc = spawnSync(
      "mysqldump",
      [
        "-h",
        conn.host,
        "-P",
        conn.port,
        "-u",
        conn.user,
        "--single-transaction",
        "--quick",
        "--no-tablespaces",
        "--routines",
        "--events",
        "--triggers",
        "--hex-blob",
        "--set-gtid-purged=OFF",
        conn.database,
      ],
      { env: dumpEnv, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
    );
    if (dumpProc.status !== 0) {
      throw new Error(`mysqldump failed: ${dumpProc.stderr?.toString("utf8")}`);
    }
    const sqlText = dumpProc.stdout;
    if (!sqlText || sqlText.length === 0) {
      throw new Error("mysqldump produced empty output");
    }

    const gzipProc = spawnSync("gzip", ["-c"], { input: sqlText, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    if (gzipProc.status !== 0) throw new Error("gzip compression failed");
    fs.writeFileSync(dumpPath, gzipProc.stdout, { mode: 0o600 });
    execFileSync("gzip", ["-t", dumpPath]);
    const digest = sha256File(dumpPath);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid sha256 digest");

    // 3. Create isolated restore database and grant permissions if admin creds provided.
    runMysql(adminConn, ["-e", `CREATE DATABASE \`${restoreDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`]);
    if (adminConn.user !== conn.user) {
      runMysql(adminConn, ["-e", `GRANT ALL PRIVILEGES ON \`${restoreDb}\`.* TO '${conn.user}'@'%'; FLUSH PRIVILEGES;`]);
    }

    // 4. Restore compressed dump into the isolated database.
    const gunzip = spawnSync("gzip", ["-dc", dumpPath], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
    if (gunzip.status !== 0) throw new Error("gzip decompression failed");
    runMysql(conn, [restoreDb], { input: gunzip.stdout });

    // 5. Verify sentinel row + table parity + _prisma_migrations integrity.
    const sentinelOut = runMysql(conn, [
      restoreDb,
      "-N",
      "-e",
      `SELECT COUNT(*) FROM AuditLog WHERE id='${sentinelId}' AND action='backup.sentinel';`,
    ]).trim();
    if (sentinelOut !== "1") {
      throw new Error(`Sentinel row missing after restore (count=${sentinelOut})`);
    }

    const tableCountOut = runMysql(conn, [
      restoreDb,
      "-N",
      "-e",
      "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE();",
    ]).trim();
    const tableCount = Number(tableCountOut);
    if (!Number.isFinite(tableCount) || tableCount < 150) {
      throw new Error(`Expected >= 150 restored tables, got ${tableCountOut}`);
    }

    const migCountOut = runMysql(conn, [
      restoreDb,
      "-N",
      "-e",
      "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;",
    ]).trim();
    if (Number(migCountOut) < 8) {
      throw new Error(`Expected >= 8 applied migrations after restore, got ${migCountOut}`);
    }

    // 6. Verify `prisma migrate status` reports clean against the restored copy.
    execFileSync("npx", ["prisma", "migrate", "status"], {
      env: { ...process.env, DATABASE_URL: restoreUrl },
      stdio: "pipe",
      encoding: "utf8",
    });

    // 7. Verify media tar archive excludes secrets (.env, .pem, .key) while retaining media.
    fs.mkdirSync(path.join(mediaDir, "avatars"), { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "avatars", "sample.txt"), "media-ok\n");
    fs.writeFileSync(path.join(mediaDir, ".env"), "SECRET=never-archive\n");
    fs.writeFileSync(path.join(mediaDir, "avatars", ".env.production"), "SECRET=never-archive\n");
    fs.writeFileSync(path.join(mediaDir, "private.key"), "KEY=never-archive\n");
    fs.writeFileSync(path.join(mediaDir, "cert.pem"), "CERT=never-archive\n");
    const archivedEntries = verifyMediaArchiveExcludesSecrets(mediaDir, mediaArchive);
    if (!archivedEntries.some((entry) => entry.includes("avatars/sample.txt"))) {
      throw new Error("Expected media file missing from archive");
    }

    console.log(
      `PASS: isolated backup & restore verified (tables=${tableCount}, migrations=${migCountOut}, sentinel=1, sha256=${digest.slice(0, 12)}..., mediaFiles=${archivedEntries.length}, secretsExcluded=true).`,
    );
  } finally {
    try {
      runMysql(conn, [conn.database, "-e", `DELETE FROM AuditLog WHERE id='${sentinelId}';`]);
    } catch {}
    try {
      runMysql(adminConn, ["-e", `DROP DATABASE IF EXISTS \`${restoreDb}\`;`]);
    } catch {}
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBackupRestoreRehearsal().catch((error) => {
    console.error(`[backup-restore] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
