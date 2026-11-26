# PR merge integrity audit — 2026-11-26

Scope: every pull request merged into `main` (#1–#19) in
`tech360-bd/ALO-LEARNING-JOURNEY-PRODUCTION`. Question asked: *were any files
submitted through a PR never actually landed on `main`?*

Method: each PR's file list (`gh pr view --json files`), the branch head blob and
the merge-commit blob were compared per path, then every path was re-checked
against the current `main` tree (`354e449`). A whole-history sweep
(`git log --all --diff-filter=ACDMR --name-only`, 1209 tracked files at HEAD)
was also run to find paths that once existed and are gone today.

## Result

- **19/19 merged PRs: 0 missing files, 0 content drift.** Every path in every PR
  is present at HEAD, and each blob at the branch head is byte-identical to the
  blob in the merge commit. Nothing was dropped by a merge, a conflict
  resolution, or a `.gitignore` rule.
- **No open PRs, no unmerged commits.** Every `arena/*`, `codex/*`, `fix/*` and
  `patch-1` remote branch tip is an ancestor of `origin/main` (fully merged).
  Working tree is clean, ignoring nothing that is needed.

## The one real gap (fixed here)

`src/app/robots.ts` was retired in `f520edb` ("robots.ts removed
(public/robots.txt)"), but the replacement `public/robots.txt` never carried
over the `Sitemap:` directive that the route handler emitted. Consequence:
`/robots.txt` advertises no sitemap, so `/sitemap.xml` (which `src/app/sitemap.ts`
does still generate) is not discoverable through the standard crawler entry
point.

Fix: `Sitemap: https://learn.alolabs.net/sitemap.xml` appended to
`public/robots.txt`, plus a regression test in `tests/release-claims.test.mjs`
that asserts the directive exists and points at the same host as the sitemap
route. The test fails if the line is removed.

## Deliberately absent paths (verified intentional, not restored)

| Path | Why it is gone |
| --- | --- |
| `.env.save` | Deleted in `1fdc1ae` as a contained secret leak; `**/.env.*` in `.gitignore`. Restoring it would re-leak credentials — rotate instead (see README security note). |
| `src/middleware.ts` | Superseded by `src/proxy.ts` (`02a4a1e`, Next.js 16 middleware→proxy migration). |
| `src/app/robots.ts` | Superseded by `public/robots.txt`; the gap in that replacement is the fix above. |
| `storage/backups/backup_1786236820070.{alo.bak,json}` | Untracked DB backups removed in `3086707`; `storage/backups/` is ignored. |
| `tsconfig.tsbuildinfo` | Build artefact, ignored. |

## CI context (not a file-integrity problem)

- PR #18's red CI was two integration checks hardcoding pre-#18 counts
  (141 models / 7 migrations vs the actual 150 / 8). PR #19 (`scripts/test-migrations.mjs`,
  `scripts/verify-prisma-history.mjs`) fixed the counts; its branch CI and
  main's CI run `45811522877` both pass. `scripts/verify-migrations.mjs`
  reports 150 models across eight additive migrations.
- `Deploy to VPS` still fails at `network-preflight → Tailscale connect`, a
  repository-secret/network configuration issue. `verify` and `Secret scan`
  succeed in those same runs; nothing is missing from the tree.
