# Official Documentation & Upstream References

Verified on `2026-11-28` against the installed repository packages and upstream GitHub releases.

## 1. Installed Stack & Official Docs

| Component | Installed / Configured Version | Official Documentation & Upstream Source |
|---|---|---|
| **Next.js (App Router, `proxy.ts`, standalone)** | `next@16.4.6` (`^16.4.5`) | https://nextjs.org/docs/app · https://github.com/vercel/next.js |
| **React / React DOM** | `react@19.0.0` | https://react.dev |
| **Prisma ORM & Client (MySQL)** | `prisma@6.19.3`, `@prisma/client@6.19.3` | https://www.prisma.io/docs/orm · https://github.com/prisma/orm |
| **NextAuth** | `next-auth@4.24.15` | https://next-auth.js.org |
| **Playwright E2E** | `@playwright/test@1.65.1` | https://playwright.dev/docs/intro · https://github.com/microsoft/playwright |
| **Node.js** | `v22.22.3` (`.node-version`: 22) | https://nodejs.org/docs/latest-v22.x/api/ |
| **Docker & Compose** | Multi-stage Node 22 standalone (`Dockerfile`, `docker-compose.yml`) | https://docs.docker.com/compose/ |
| **GitHub Actions Environments & OIDC** | `.github/workflows/{ci,deploy}.yml` | https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment |
| **Tailscale GitHub Action & Workload Identity Federation** | `tailscale/github-action@064b10558093f38325e838ddea35486bdc6b1d5c` (`v4.4.0`, released `2026-10-29`) | https://github.com/tailscale/github-action/releases/tag/v4.4.0 · https://tailscale.com/kb/1584/workload-identity-federation |

## 2. Deployment & Security Configuration Notes (Verified Against `tailscale/github-action@v4.4.0`)

1. **Tailscale Authentication (`deploy.yml`)**:
   - Currently wired for ephemeral tagged OAuth client credentials (`TAILSCALE_OAUTH_CLIENT_ID`, `TAILSCALE_OAUTH_SECRET`, `vars.TAILSCALE_TAGS`, `version: '1.104.4'`).
   - Also supports **Tailscale Workload Identity Federation (OIDC)** in `tailscale/github-action@v4.4.0` using `permissions: { id-token: write }`, `oauth-client-id`, `audience`, and `tags` (requires Tailscale `>= 1.90.1` and a federated identity configured with `auth_keys:write` scope and `tagOwners`).
   - Plain single-use auth keys (`tskey-*`) are deprecated and explicitly rejected by `.github/workflows/deploy.yml`.

2. **GitHub `production` Environment Protection**:
   - `deploy.yml` verifies `GET /repos/{owner}/{repo}/environments/production` has at least one required reviewer before attempting any VPS SSH deploy.
   - Repository state observed on `2026-11-28`: `environments` count = `0`, and repository `actions/variables` query returned HTTP `403` for the sandbox GitHub token. Deployment remains intentionally gated and blocked until an administrator configures the `production` environment, required reviewers, Tailscale OAuth/WIF credentials, and SSH host key secrets (`SERVER_HOST` / `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_SSH_HOST_KEY`, `VPS_DEPLOY_ENABLED=true`).
