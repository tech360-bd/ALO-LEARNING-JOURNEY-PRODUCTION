import { validateMigrationTestDatabase } from './prisma-dev-guard.mjs';

export function requireTestDatabase() {
  const target = validateMigrationTestDatabase({ nodeEnv: process.env.NODE_ENV, databaseUrl: process.env.DATABASE_URL,
    ci: process.env.CI === 'true', confirmations: process.env });
  if (!target.ok) throw new Error(`Blocked: ${target.reason}`);
}
