import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publicAddress, publicUrl } from '../src/lib/public-http.ts';
import { enrollmentSecret, computeTotp } from '../src/lib/totp.ts';
import { encryptSecret, decryptSecret } from '../src/lib/vault.ts';

test('outbound policy requires public IPv4, HTTPS names, and explicit webhook origins', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.0.1','192.168.1.1','::1','::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('1.1.1.1'), true);
  for (const url of ['file:///test','http://example.org','https://example.org:444','https://127.0.0.1','https://u@example.org']) assert.throws(() => publicUrl(url));
  process.env.MOS_WEBHOOK_ALLOWED_ORIGINS = 'https://hooks.example.test';
  assert.throws(() => publicUrl('https://other.example.test', true));
  assert.equal(publicUrl('https://hooks.example.test/receive', true).pathname, '/receive');
  delete process.env.MOS_WEBHOOK_ALLOWED_ORIGINS;
});

test('old and current MFA enrollment formats survive vault encryption/decryption', () => {
  process.env.VAULT_MASTER_KEY = randomBytes(32).toString('base64');
  for (const plain of [Buffer.from('12345678901234567890').toString('base64'), 'b32:GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ']) {
    const { ciphertext } = encryptSecret(plain);
    assert.equal(computeTotp(enrollmentSecret(decryptSecret(ciphertext)),59),'287082');
  }
  delete process.env.VAULT_MASTER_KEY;
});

test('unused editor/highlighter chains are absent from the root runtime manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  for (const name of ['@mdxeditor/editor', 'react-syntax-highlighter']) assert.equal(pkg.dependencies[name],undefined);
});
