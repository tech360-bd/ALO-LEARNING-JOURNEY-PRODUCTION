import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookSecret, resolveWebhookSecret, signWebhookPayload, storeWebhookSecret, verifyWebhookSignature } from '../src/lib/webhook-signature.ts';

const previousVaultKey = process.env.VAULT_MASTER_KEY;
process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

test('webhook secret is cryptographically random and AES-GCM encrypted at rest', () => {
  const secret = createWebhookSecret();
  assert.match(secret, /^[a-f0-9]{64}$/);
  const stored = storeWebhookSecret(secret);
  assert.notEqual(stored, secret);
  assert.equal(resolveWebhookSecret(stored), secret);
});

test('existing HMAC-SHA256 hex format verifies with the disclosed secret and rejects a wrong secret', () => {
  const secret = 'one-time-secret';
  const payload = JSON.stringify({ type: 'lead.created', companyId: 'company-test' });
  const signature = signWebhookPayload(secret, payload);
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.equal(verifyWebhookSignature(secret, payload, signature), true);
  assert.equal(verifyWebhookSignature('wrong-secret', payload, signature), false);
  assert.equal(verifyWebhookSignature(secret, payload, 'not-a-signature'), false);
});

test('legacy plaintext webhook secrets remain readable for existing rows', () => {
  assert.equal(resolveWebhookSecret('old-legacy-secret'), 'old-legacy-secret');
});

test.after(() => {
  if (previousVaultKey === undefined) delete process.env.VAULT_MASTER_KEY;
  else process.env.VAULT_MASTER_KEY = previousVaultKey;
});
