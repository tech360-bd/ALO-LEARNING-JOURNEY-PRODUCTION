import { enrollmentSecret, matchingTotpStep } from '@/lib/totp';
import { decryptSecret } from '@/lib/vault';
import { rateLimiter } from '@/lib/security';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyPassword, issueSessionToken, hashPassword, passwordNeedsUpgrade } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const { email, password, code } = (await req.json().catch(() => null)) ?? {};
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    const user = await db.user.findUnique({ where: { email }, include: { mfaSecret: true } });
    if (!user || !user.isActive) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    if (user.mfaSecret?.isEnabled) {
      const challenge = () => NextResponse.json({ error: 'Enter a fresh six-digit authenticator code.', mfaRequired: true }, { status: 401 });
      if (!code) return challenge();
      if (!rateLimiter(`mos-mfa:${user.id}`, { maxRequests: 5 }).allowed) {
        return NextResponse.json({ error: 'Too many code attempts. Try again in one minute.' }, { status: 429 });
      }
      const step = matchingTotpStep(enrollmentSecret(decryptSecret(user.mfaSecret.secretCipher)), code);
      if (step === null) return challenge();
      const usedAt = new Date(step * 1000);
      const used = await db.mfaSecret.updateMany({
        where: { userId: user.id, isEnabled: true, secretCipher: user.mfaSecret.secretCipher,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: usedAt } }] },
        data: { lastUsedAt: usedAt },
      });
      if (used.count !== 1) return challenge();
    }

    // Transparent password upgrade: re-hash with bcrypt if legacy
    if (passwordNeedsUpgrade(user.passwordHash)) {
      const newHash = await hashPassword(password);
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });
    }

    const companyUser = await db.companyUser.findFirst({
      where: { userId: user.id },
      include: { company: true },
    });

    const token = await db.$transaction(async tx => {
      const token = await issueSessionToken(tx, {
        userId: user.id,
        email: user.email,
        role: companyUser?.role || 'viewer',
        companyId: companyUser?.companyId || '',
      }, req.headers.get('user-agent'));

      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      await tx.mosAuditLog.create({
        data: {
          action: 'user.login',
          resource: 'auth',
          details: `${user.name} logged in`,
          userId: user.id,
          companyId: companyUser?.companyId,
        },
      });

      return token;
    });

    return NextResponse.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: companyUser?.role || 'viewer',
        companyId: companyUser?.companyId || '',
        companyName: companyUser?.company.name || '',
        plan: companyUser?.company.plan || 'free',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
