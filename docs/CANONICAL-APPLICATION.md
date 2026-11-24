# Canonical application

Build and deploy **the root application** (`package.json`, `src/app`, `prisma/schema.prisma`). Its five page routes serve the ALO administration console (`/`), administrator login, public contact form, MarketingOS landing page, and tenant dashboard. See [route inventory](ROUTE-INVENTORY.md) for the API paths and explicit methods. A route declaration is not a production acceptance test.

The supported root toolchain is Node 22, npm with `package-lock.json`, Next.js standalone output and Prisma/MySQL. `marketingos/` is a historical source tree, excluded from the root TypeScript build, not the deploy target. **Do not use the historical SQLite/Bun CRM runbook or its database commands on the root application.** The dev JSON store is not a production fallback.

For onboarding and the two independent authentication boundaries see [README](../README.md). For production see [DEPLOYMENT](../DEPLOYMENT.md) and the [migration recovery plan](../MIGRATION-RECOVERY-PLAN.md). Repository configuration does not establish what is running on the VPS.
