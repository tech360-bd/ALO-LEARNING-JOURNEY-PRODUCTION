/**
 * MFA Setup — generate TOTP secret + QR code.
 * Uses a minimal TOTP implementation (RFC 6238) without external deps.
 */
import { rateLimiter } from '@/lib/security';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, badRequest, ok } from '@/lib/v1-middleware';
import { encryptSecret } from '@/lib/vault';
import QRCode from 'qrcode';
import { buildTotpUri, generateTotpSecret } from '@/lib/totp';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  const limit = rateLimiter(`mos-mfa-setup:${ctx.userId}`, { maxRequests: 5 });
  if (!limit.allowed) return Response.json({ error: 'Too many attempts' }, { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } });

  // Check if MFA already enabled
  const existing = await db.mfaSecret.findUnique({ where: { userId: ctx.userId } });
  if (existing?.isEnabled) {
    return badRequest('MFA already enabled. Disable first to re-setup.');
  }

  const secret = generateTotpSecret();
  const enc = encryptSecret('b32:' + secret);
  const uri = buildTotpUri({ issuer: 'ALO Labs MarketingOS', accountName: ctx.email, secret });

  // Save the secret (not yet enabled — verified in /verify step)
  const fields = { secretCipher: enc.ciphertext, secretKeyVersion: enc.keyVersion };
  if (existing) {
    const result = await db.mfaSecret.updateMany({ where: { userId: ctx.userId, isEnabled: false, secretCipher: existing.secretCipher }, data: fields });
    if (!result.count) return badRequest('Enrollment changed; reload before retrying.');
  } else {
    await db.mfaSecret.create({ data: { userId: ctx.userId, ...fields, isEnabled: false } });
  }

  const response = ok({
    secret, // returned once so user can manually enter if QR scan fails
    otpauth_uri: uri,
    qr_code_data_url: await QRCode.toDataURL(uri),
    next_step: 'POST /api/v1/auth/mfa/verify with a 6-digit TOTP code from your authenticator app',
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
