import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployScript = await readFile(path.join(root, "scripts/deploy-production.sh"), "utf8");
const workflow = await readFile(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const datadogWorkflow = await readFile(path.join(root, ".github/workflows/datadog-synthetics.yml"), "utf8");

test("production deploy is pinned to the operator-provided path, PM2 name, and port", () => {
  assert.match(deployScript, /APP_DIR="\$\{APP_DIR:-\/home\/alamin\/alolabs-projects\/ALO-LEARNING-JOURNEY-PRODUCTION\}"/);
  assert.match(deployScript, /APP_DIR" = "\/home\/alamin\/alolabs-projects\/ALO-LEARNING-JOURNEY-PRODUCTION"/);
  // The live process is named `learn` (id 39) and matches ecosystem.learn.config.cjs.
  assert.match(deployScript, /PM2_APP_NAME="\$\{PM2_APP_NAME:-learn\}"/);
  assert.match(deployScript, /PM2_APP_NAME" == "learn"/);
  assert.doesNotMatch(deployScript, /learn-aloeducation/);
  assert.match(deployScript, /APP_PORT" == "3061"/);
  assert.match(workflow, /VPS_APP_DIR must be \/home\/alamin\/alolabs-projects\/ALO-LEARNING-JOURNEY-PRODUCTION/);
  assert.match(workflow, /VPS_PM2_APP must be learn /);
  assert.match(workflow, /VPS_APP_PORT must be 3061/);
});

test("every deploy helper script targets the live process name and canonical domain", async () => {
  const { readFile } = await import("node:fs/promises");
  const helpers = ["deploy/app-deploy.sh", "deploy/monitor.sh", "deploy/health-check.sh", "deploy/vps-bootstrap.sh", "deploy/backup.sh"];
  for (const helper of helpers) {
    const source = await readFile(path.join(root, helper), "utf8");
    assert.doesNotMatch(source, /learn-aloeducation/, `${helper} still pins the retired PM2 name`);
    assert.doesNotMatch(source, /app-deploy\.sh[\s\S]*3017/, `${helper} still pins port 3017`);
    assert.doesNotMatch(source, /\/home\/aloedu\/LEARNING-JOURNEY/, `${helper} still pins the retired app path`);
  }
  for (const helper of ["deploy/app-deploy.sh", "deploy/monitor.sh", "deploy/health-check.sh", "deploy/vps-bootstrap.sh"]) {
    const source = await readFile(path.join(root, helper), "utf8");
    assert.match(source, /learn-aloeducation|PM2_APP_NAME:-learn|PM2 process name must be learn|PM2 app must be learn/, `${helper} must accept the live name`);
  }
  const health = await readFile(path.join(root, "deploy/health-check.sh"), "utf8");
  const bootstrap = await readFile(path.join(root, "deploy/vps-bootstrap.sh"), "utf8");
  assert.match(health, /PUBLIC_BASE_URL:-https:\/\/learn\.alolabs\.net/);
  assert.match(bootstrap, /PUBLIC_BASE_URL:-https:\/\/learn\.alolabs\.net/);
  assert.doesNotMatch(health, /PUBLIC_BASE_URL:-https:\/\/learn\.aloeducation\.com/);
});

test("both the workflow and direct script require the exact readiness switch", () => {
  assert.match(deployScript, /\[\[ "\$\{VPS_DEPLOY_ENABLED:-\}" == "true" \]\] \|\| fail/);
  assert.match(deployScript, /VPS_DEPLOY_ENABLED must be exactly true/);
  assert.match(workflow, /vars\.VPS_DEPLOY_ENABLED == 'true'/);
  assert.match(workflow, /VPS_DEPLOY_ENABLED: \$\{\{ vars\.VPS_DEPLOY_ENABLED \}\}/);
  assert.ok(workflow.includes("VPS_DEPLOY_ENABLED='$VPS_DEPLOY_ENABLED' EXPECTED_SHA="));
});

test("deployment requires restore and schema evidence tied to the exact release", () => {
  assert.match(deployScript, /RESTORE_TEST_SHA" = "\$EXPECTED_SHA/);
  assert.match(deployScript, /SCHEMA_PREFLIGHT_SHA" = "\$EXPECTED_SHA/);
  assert.match(deployScript, /RESTORE_TEST_REFERENCE/);
  assert.match(deployScript, /SCHEMA_PREFLIGHT_REFERENCE/);
  assert.match(workflow, /VPS_RESTORE_TEST_SHA/);
  assert.match(workflow, /VPS_SCHEMA_PREFLIGHT_SHA/);
});

test("build, database/media backup, migration checks, and atomic switch are ordered", () => {
  const build = deployScript.indexOf("npm run build");
  const dump = deployScript.indexOf("if ! mysqldump ");
  const mediaBackup = deployScript.indexOf("MEDIA_PATHS=()");
  const status = deployScript.indexOf("npx prisma migrate status");
  const migrate = deployScript.indexOf("npx prisma migrate deploy");
  const pointerSwitch = deployScript.indexOf('ln -s "$RELEASE_DIR" "$CURRENT_TMP"');
  assert.ok(build >= 0 && dump > build && mediaBackup > dump);
  assert.ok(status > mediaBackup && migrate > status && pointerSwitch > migrate);
  assert.match(deployScript, /sha256sum "\$BACKUP_FILE"/);
  assert.match(deployScript, /sha256sum "\$MEDIA_BACKUP"/);
});

test("runtime-written public media is copied without overwriting and backed up before migration", () => {
  assert.match(deployScript, /preserve_public_media\(\)/);
  assert.match(deployScript, /different file already exists at destination/);
  assert.match(deployScript, /MEDIA_PATHS/);
  assert.match(deployScript, /media backup creation failed/);
  assert.match(deployScript, /preserve_tree_no_clobber "\$source" "\$target" "public media \$name"/);
  assert.match(deployScript, /\$purpose preservation failed/);
});

test("existing release directories are never overwritten or deleted", () => {
  const guard = deployScript.indexOf('[ ! -e "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ]');
  const materialize = deployScript.indexOf('mkdir "$RELEASE_DIR"');
  assert.ok(guard >= 0 && materialize > guard);
  assert.match(deployScript.slice(guard, materialize), /refusing to overwrite or delete it/);
});

test("deployment never starts an absent PM2 process and retains a known-good rollback target", () => {
  assert.match(deployScript, /pm2_process_is_online \|\| fail "PM2 process .*will not assume it can be started"/);
  assert.doesNotMatch(deployScript, /pm2\s+(?:start|startOrReload)\b/);
  assert.match(deployScript, /PREV_TARGET/);
  assert.match(deployScript, /restoring current -> previously healthy release/);
  assert.match(deployScript, /database is not reverted/);
});

test("pending migration suffix is allowlisted and exact-SHA approved", () => {
  assert.match(deployScript, /MIGRATION_PLAN_APPROVED_SHA" = "\$EXPECTED_SHA/);
  // Every shipped migration must be reachable as the tail of an allowlisted
  // pending suffix, otherwise a real release stalls on "unknown suffix".
  assert.match(deployScript, /EXPECTED_SUPER_ADMIN_ONLY="20261125000000_super_admin_omni_selfheal"/);
  assert.match(deployScript, /EXPECTED_SOCIAL_CLAIMS_THROUGH_SUPER_ADMIN/);
  assert.match(deployScript, /P3009\|P3018\|P3006\|P3005/);
  assert.match(deployScript, /pending migrations are not a known ordered suffix/);
  assert.match(deployScript, /migrate deploy is skipped/);
});

test("deployment verifies exact migration checksums and requires the baseline already reconciled", () => {
  const historyRead = deployScript.indexOf("SELECT migration_name, checksum");
  const historyVerify = deployScript.indexOf("verify-prisma-history.mjs", historyRead);
  const migrationStatus = deployScript.indexOf("npx prisma migrate status", historyVerify);
  assert.ok(historyRead >= 0 && historyVerify > historyRead && migrationStatus > historyVerify);
  assert.match(deployScript, /initial baseline must already be reconciled and recorded/);
  assert.match(deployScript, /after the reconciled baseline/);
  assert.doesNotMatch(deployScript, /EXPECTED_ALL=/);
});

test("public HTTPS health verification requires the exact released SHA", () => {
  assert.ok(workflow.includes('DEPLOY_URL: ${{ vars.DEPLOY_URL }}'));
  assert.ok(workflow.includes('HEALTH_PATH: ${{ vars.HEALTH_PATH }}'));
  assert.ok(workflow.includes('"https://learn.alolabs.net"|"http://learn.alolabs.net"'));
  assert.ok(workflow.includes('base="https://${DEPLOY_URL#*://}"; base="${base%/}"'));
  assert.doesNotMatch(workflow, /DEPLOY_URL" = "https:\/\/learn\.aloeducation\.com"/);
  assert.ok(workflow.includes('[ "$HEALTH_PATH" = "/api/health" ]'));
  assert.ok(workflow.includes('"$base$HEALTH_PATH"'));
  assert.match(workflow, /served_sha.*\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /Public health\/release verification failed/);
  assert.match(workflow, /LIVE VERIFIED: \$base reports release \$served_sha/);
  assert.doesNotMatch(workflow, /SITE_URL:-learn\.alolabs\.net/);
});

test("production deployment fails closed if human-review protection cannot be verified", () => {
  assert.match(workflow, /Cannot verify production environment protection rules/);
  assert.match(workflow, /refusing to deploy/);
});

test("third-party Datadog tests are disabled by default and require an explicit opt-in", () => {
  assert.match(datadogWorkflow, /vars\.DATADOG_SYNTHETICS_ENABLED == 'true'/);
  assert.match(datadogWorkflow, /secrets\.DD_API_KEY/);
  assert.match(datadogWorkflow, /secrets\.DD_APP_KEY/);
  assert.match(datadogWorkflow, /required repository secrets are missing/);
});

test('manual deployment is restricted to main as well as the environment gate', () => {
  assert.match(workflow, /if: \$\{\{ github\.ref == 'refs\/heads\/main' && vars\.VPS_DEPLOY_ENABLED == 'true'/);
});

test('both SSH jobs pin the configured SSH port, independent of the app listener', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = path.join(root, 'scripts/write-pinned-host.sh');
  const run = (port) => spawnSync('bash', [script], { encoding: 'utf8', env: {
    SERVER_HOST: 'test.ts.net', SERVER_PORT: port, VPS_SSH_HOST_KEY: 'alias ssh-ed25519 TEST_ONLY',
  } });
  assert.equal(run('').stdout.trim(), 'test.ts.net ssh-ed25519 TEST_ONLY');
  assert.equal(run('2222').stdout.trim(), '[test.ts.net]:2222 ssh-ed25519 TEST_ONLY');
  assert.notEqual(run('70000').status, 0);
  assert.equal(workflow.match(/bash scripts\/write-pinned-host\.sh/g)?.length, 2);
});

test("tailnet tags are optional so a policy without the tag still joins", () => {
  // 'requested tags [tag:github-runner] are invalid or not permitted' means the
  // tag is absent from the tailnet policy; the join must not hard-require it.
  assert.ok(workflow.includes("tags: ${{ vars.TAILSCALE_TAGS }}"));
  // The hand-rolled `tailscale up` retry loop (and its TAG_ARGS assembly) was
  // removed in favour of the pinned action; the variable is still the only
  // source of the tag, so no tailnet policy is hard-coded.
  assert.doesNotMatch(workflow, /--advertise-tags=/);
  assert.doesNotMatch(workflow, /tags: tag:github-runner/);
  assert.match(workflow, /tagOwners/);
});

test("the tailnet join prefers the OAuth client and asserts membership afterwards", () => {
  // Live evidence (deploy run 45888174326, 2026-11-26): the join failed with
  // "invalid key: API key ksxrFpUF8g11CNTRL not valid" while the code was
  // already correct. Tailscale deprecated plain auth keys, and an ephemeral key
  // that is not REUSABLE is consumed by the first successful run. The pinned
  // action therefore gets the OAuth pair (which it exchanges for an ephemeral
  // auth key itself) and `tags` is always supplied, so the action never reaches
  // its "tags is required when using an OAuth client" branch.
  assert.ok(workflow.includes("oauth-client-id: ${{ secrets.TAILSCALE_OAUTH_CLIENT_ID }}"));
  assert.ok(workflow.includes("oauth-secret: ${{ secrets.TAILSCALE_OAUTH_SECRET }}"));
  // A tag is never hard-coded: a tailnet without that tag in tagOwners refuses
  // the join, so the tag still comes from a repository variable.
  assert.ok(workflow.includes("tags: ${{ vars.TAILSCALE_TAGS }}"));
  assert.doesNotMatch(workflow, /tags: tag:github-runner/);
  // No `authkey` input at all: in live run 45889640056 passing one alongside the
  // OAuth pair made the action warn about the deprecated key and install no
  // binaries (tailscale-binary=MISSING), so the runner could never join.
  assert.doesNotMatch(workflow, /^\s*authkey: \$\{\{/m);
  // The pair must exist and must not be a placeholder or an auth key.
  assert.match(workflow, /if \[ -z "\$TS_CLIENT_ID" \] \|\| \[ -z "\$TS_CLIENT_SECRET" \]; then/);
  assert.match(workflow, /tskey-\*\) echo "::error title=Tailnet/);
  assert.match(workflow, /\$\{#TS_CLIENT_ID\}" -lt 10/);
  // Both jobs assert the result of the action's join, and name the real cause.
  assert.match(workflow, /Assert the runner joined the tailnet/);
  assert.equal(workflow.match(/name: Assert the runner joined the tailnet/g)?.length, 2);
  assert.match(workflow, /invalid key/);
  assert.match(workflow, /tagOwners/);
  // The explicit `tailscale up` retry loop was removed: it duplicated the
  // action's join and produced a second, misleading error.
  assert.doesNotMatch(workflow, /tailscale up --hostname/);
});

test("the read-only preflight fails fast and publishes network evidence", () => {
  // The 10-minute job limit was exhausted by retries, hiding whichever layer
  // actually failed (TCP vs host key vs SSH key).
  assert.match(workflow, /PREFLIGHT_ATTEMPTS: '4'/);
  assert.match(workflow, /PREFLIGHT_TCP_TIMEOUT: '5'/);
  assert.match(workflow, /timeout-minutes: 4/);
  assert.match(workflow, /name: Network evidence \(annotations, safe to fail\)/);
  assert.match(workflow, /title=Network::/);
  assert.match(workflow, /tailscale ping -c 1 --timeout=5s/);
});
