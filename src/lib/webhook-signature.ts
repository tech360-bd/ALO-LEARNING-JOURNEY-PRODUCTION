import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret } from './vault.ts';

const ENCRYPTED_SECRET_PREFIX = '1:';

export function createWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/** New rows use the existing AES-256-GCM vault format. Plain legacy secrets remain readable. */
export function storeWebhookSecret(secret: string): string {
  return encryptSecret(secret).ciphertext;
}

export function resolveWebhookSecret(stored: string): string {
  return stored.startsWith(ENCRYPTED_SECRET_PREFIX) ? decryptSecret(stored) : stored;
}

/** Preserve the existing lowercase-hex HMAC-SHA256 over JSON.stringify(payload). */
export function signWebhookPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signWebhookPayload(secret, payload), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
