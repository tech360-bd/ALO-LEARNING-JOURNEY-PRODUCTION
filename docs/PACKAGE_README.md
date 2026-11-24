# ALO Learning Journey — repository guide

This guide describes the current `tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION` checkout. It does not describe a downloadable package or a separate MarketingOS checkout.

## Requirements and installation

- Node.js 22.x (see `.node-version`)
- npm
- MySQL 8 for local API/database workflows
- Network access to the Prisma engine distribution during `npm ci` / client generation

```bash
npm ci
```

`npm ci` uses the committed `package-lock.json`; its `postinstall` runs `prisma generate`. Do not replace this with `npm install` when validating a clean checkout.

For local database work, provision a fresh, disposable MySQL database and follow the guarded setup in the [root README](../README.md#local-development). Never point local development or destructive migration checks at production.

## Common commands

```bash
npm run dev
npm test
npm run lint
npm run typecheck
npm run verify:migrations
npm run build
```

CI runs the canonical verification workflow in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). The static migration verifier does not prove compatibility with production data or migration history.

## Current documentation

- [Project overview and development setup](../README.md)
- [Deployment requirements and release gates](../DEPLOYMENT.md)
- [Migration recovery and restored-copy rehearsal](../MIGRATION-RECOVERY-PLAN.md)
- [Security policy and incident response](../SECURITY.md)
- [Photo-to-video behavior and limits](./PHOTO_TO_VIDEO.md)
- [Long Video Studio: chunked rendering and limits](./LONG-VIDEO-STUDIO.md)
- [Repository audit reports](../audit/README.md)

The repository's release state is recorded in [`deploy/RELEASE_MANIFEST.txt`](../deploy/RELEASE_MANIFEST.txt). That file is repository evidence, not proof that a public release was shipped. No package archive, patch, or audit release is implied by this document.

Repository: <https://github.com/tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION>
