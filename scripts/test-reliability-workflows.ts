// Disposable-MySQL HTTP/persistence checks for reliability-sensitive routes.
// Run only after migrations have been applied by CI/test setup.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireTestDatabase } from './require-test-database.mjs';

async function main() {
  requireTestDatabase();
  const suffix = randomUUID();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    JWT_SECRET: randomBytes(32).toString('hex'),
    VAULT_MASTER_KEY: randomBytes(32).toString('base64'),
    CRON_SECRET: randomBytes(32).toString('hex'),
    MOS_WEBHOOK_ALLOWED_ORIGINS: 'https://hooks.example.test',
    POSTIZ_BASE_URL: 'https://postiz.invalid',
    POSTIZ_API_KEY: 'ci-only-not-a-real-credential',
    POSTIZ_WORKSPACE_ID: 'ci-workspace',
  });

  const { db } = await import('../src/lib/db');
  const register = await import('../src/app/api/auth/register/route');
  const feedImport = await import('../src/app/api/feeds/import/route');
  const webhookRoutes = await import('../src/app/api/settings/webhooks/route');
  const scraper = await import('../src/app/api/scraper/route');
  const cron = await import('../src/app/api/cron/social-publish/route');
  const { claimScheduledContent, finalizeClaim } = await import('../src/lib/social-publish-claims');
  const { decryptSecret } = await import('../src/lib/vault');
  const { signWebhookPayload, verifyWebhookSignature } = await import('../src/lib/webhook-signature');
  const req = (url: string, body: object, token?: string) => new NextRequest(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const cronRequest = () => new NextRequest('http://localhost/api/cron/social-publish', {
    method: 'GET', headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  let restoreFetch = globalThis.fetch;

  try {
    const registration = await register.POST(req('http://localhost/api/auth/register', {
      email: `reliability-${suffix}@example.test`, name: `Reliability ${suffix}`, password: randomBytes(16).toString('hex'),
      companyName: `Reliability ${suffix}`,
    }) as NextRequest);
    assert.equal(registration.status, 200);
    const account = await registration.json();
    const token = account.token as string;
    const companyId = account.user.companyId as string;

    // Feed route response and persisted state: first import, retry, and a
    // deterministic concurrent race (no sleeps; actual MySQL unique PK serializes it).
    const source = await db.feedSource.create({ data: {
      name: 'Reliability test source', url: `https://news.example.test/${suffix}`, companyId,
    } });
    const feedItem = (name: string) => db.feedItem.create({ data: {
      sourceId: source.id, companyId, title: name, link: `https://news.example.test/item/${name}-${suffix}`,
      publishedAt: new Date(),
    } });
    const firstItem = await feedItem('first');
    const firstResponse = await feedImport.POST(req('http://localhost/api/feeds/import', { itemId: firstItem.id }, token));
    assert.equal(firstResponse.status, 201);
    const created = await firstResponse.json();
    const persisted = await db.content.findUniqueOrThrow({ where: { id: created.data.contentId } });
    assert.equal(persisted.companyId, companyId);
    assert.equal(persisted.status, 'draft');
    const marked = await db.feedItem.findUniqueOrThrow({ where: { id: firstItem.id } });
    assert.equal(marked.isRead, true);
    assert.equal(marked.isStarred, true);
    assert.equal((await feedImport.POST(req('http://localhost/api/feeds/import', { itemId: firstItem.id }, token))).status, 409);
    assert.equal(await db.content.count({ where: { id: created.data.contentId } }), 1);

    const concurrentItem = await feedItem('concurrent');
    const imports = await Promise.all([
      feedImport.POST(req('http://localhost/api/feeds/import', { itemId: concurrentItem.id }, token)),
      feedImport.POST(req('http://localhost/api/feeds/import', { itemId: concurrentItem.id }, token)),
    ]);
    assert.deepEqual(imports.map((response) => response.status).sort(), [201, 409]);
    assert.equal(await db.content.count({ where: { companyId, mediaUrl: concurrentItem.link } }), 1);
    const concurrentMarked = await db.feedItem.findUniqueOrThrow({ where: { id: concurrentItem.id } });
    assert.equal(concurrentMarked.isRead && concurrentMarked.isStarred, true);

    // Webhook API reveals a new secret only at creation; stored value is vault
    // ciphertext and the existing HMAC hex format verifies against the response.
    const createWebhook = await webhookRoutes.POST(req('http://localhost/api/settings/webhooks', {
      url: 'https://hooks.example.test/receiver', events: ['reliability.test'],
    }, token));
    assert.equal(createWebhook.status, 200);
    const createdWebhook = await createWebhook.json();
    const disclosedSecret = createdWebhook.webhook.secret as string;
    assert.match(disclosedSecret, /^[a-f0-9]{64}$/);
    assert.equal(createdWebhook.webhook.secretDisclosure, 'one_time');
    const storedWebhook = await db.webhook.findUniqueOrThrow({ where: { id: createdWebhook.webhook.id } });
    assert.notEqual(storedWebhook.secret, disclosedSecret);
    assert.equal(decryptSecret(storedWebhook.secret!), disclosedSecret);
    const webhookList = await webhookRoutes.GET(new NextRequest('http://localhost/api/settings/webhooks', {
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.equal(webhookList.status, 200);
    const listJson = JSON.stringify(await webhookList.json());
    assert.equal(listJson.includes(disclosedSecret), false);
    const payload = JSON.stringify({ type: 'reliability.test', companyId });
    const signature = signWebhookPayload(disclosedSecret, payload);
    assert.equal(verifyWebhookSignature(disclosedSecret, payload, signature), true);
    assert.equal(verifyWebhookSignature('wrong', payload, signature), false);

    // Scraper rejects unsupported schemes before attempting any outbound request.
    const httpScrape = await scraper.POST(req('http://localhost/api/scraper', { url: 'http://example.test' }, token));
    assert.equal(httpScrape.status, 400);
    const localScrape = await scraper.POST(req('http://localhost/api/scraper', { url: 'https://127.0.0.1/private' }, token));
    assert.equal(localScrape.status, 400);

    // Two simultaneous cron workers: the first holds the provider response at a
    // barrier; the second must observe the active lease and never call Postiz.
    const scheduled = await db.content.create({ data: {
      title: 'Concurrent publish test', type: 'social', status: 'scheduled', platform: 'linkedin',
      body: 'CI only', engagement: '{}', companyId, scheduledAt: new Date(Date.now() - 120_000),
    } });
    let providerCalls = 0;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    globalThis.fetch = async () => {
      providerCalls++;
      enteredResolve();
      await release;
      return new Response(JSON.stringify({ id: `post-${suffix}`, platformResults: [] }), { status: 201 });
    };
    const firstWorker = cron.GET(cronRequest());
    await entered;
    const secondWorkerResponse = await cron.GET(cronRequest());
    assert.equal(providerCalls, 1);
    assert.equal((await secondWorkerResponse.json()).busy, 1);
    releaseResolve();
    const firstWorkerResponse = await firstWorker;
    assert.equal(firstWorkerResponse.status, 200);
    const published = await db.content.findUniqueOrThrow({ where: { id: scheduled.id } });
    assert.equal(published.status, 'published');
    assert.equal(JSON.parse(published.engagement).postizPostId, `post-${suffix}`);

    // Simulate transport acceptance followed by lost response. Outcome stays
    // unknown and a later tick must not dispatch it again.
    const ambiguous = await db.content.create({ data: {
      title: 'Ambiguous publish test', type: 'social', status: 'scheduled', platform: 'linkedin',
      body: 'CI only', engagement: '{}', companyId, scheduledAt: new Date(Date.now() - 120_000),
    } });
    let acceptedButLostCalls = 0;
    globalThis.fetch = async () => {
      acceptedButLostCalls++;
      throw new DOMException('simulated lost provider response', 'TimeoutError');
    };
    await cron.GET(cronRequest());
    const uncertain = await db.content.findUniqueOrThrow({ where: { id: ambiguous.id } });
    assert.equal(JSON.parse(uncertain.engagement).publishingState, 'unknown');
    await cron.GET(cronRequest());
    assert.equal(acceptedButLostCalls, 1);

    // Expired pre-send claim can be replaced; the old token cannot finalize.
    const leasePost = await db.content.create({ data: {
      title: 'Lease replacement test', type: 'social', status: 'scheduled', platform: 'linkedin', engagement: '{}',
      companyId, scheduledAt: new Date(Date.now() - 120_000), publishClaimToken: 'old-worker',
      publishLeaseUntil: new Date(Date.now() - 1),
    } });
    const snapshot = await db.content.findUniqueOrThrow({ where: { id: leasePost.id } });
    const replacement = await claimScheduledContent(db, snapshot, new Date());
    assert.equal(replacement.kind, 'claimed');
    if (replacement.kind === 'claimed') {
      assert.notEqual(replacement.claim.token, 'old-worker');
      assert.equal(await finalizeClaim(db, { ...replacement.claim, token: 'old-worker' }, replacement.claim.claimedEngagement, { status: 'published' }), false);
    }

    console.log('PASS: reliability route responses, persisted feed/webhook/content state, concurrent publish claim, and ambiguous-outcome protection');
  } finally {
    globalThis.fetch = restoreFetch;
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
