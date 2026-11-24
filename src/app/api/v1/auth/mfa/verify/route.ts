/**
 * MFA Verify — verify TOTP code + enable MFA.
 */
import { rateLimiter } from '@/lib/security';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, badRequest, ok } from '@/lib/v1-middleware';
import { decryptSecret } from '@/lib/vault';
import { enrollmentSecret, matchingTotpStep } from '@/lib/totp';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  const limit = rateLimiter(`mos-mfa-verify:${ctx.userId}`, { maxRequests: 5 });
  if (!limit.allowed) return Response.json({ error: 'Too many attempts' }, { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } });

  const body = await request.json().catch(() => null);
  if (!body?.code || !/^\d{6}$/.test(body.code)) {
    return badRequest('code must be a 6-digit string');
  }

  const mfaRow = await db.mfaSecret.findUnique({ where: { userId: ctx.userId } });
  if (!mfaRow) return badRequest('No MFA setup found. Call /api/v1/auth/mfa/setup first.');

  const secret = enrollmentSecret(decryptSecret(mfaRow.secretCipher));
  const step = matchingTotpStep(secret, body.code);
  if (step === null) {
    return badRequest('Invalid TOTP code');
  }

  const updated = await db.mfaSecret.updateMany({
    where: { userId: ctx.userId, isEnabled: false, secretCipher: mfaRow.secretCipher },
    data: { isEnabled: true, enabledAt: new Date(), lastUsedAt: new Date(step * 1000) },
  });

  if (!updated.count) return badRequest('Enrollment changed; reload before retrying.');
  return ok({ enabled: true, message: 'MFA enabled. Future logins will require the TOTP code.' });
}
