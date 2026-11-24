/**
 * POST /api/v1/auth/refresh
 * Accept refresh token, validate hash, rotate (old→new), return new access token.
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { issueSessionToken } from '@/lib/auth';
import { createHash, randomBytes, randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (typeof body?.refreshToken !== 'string' || !body.refreshToken || body.refreshToken.length > 512) {
    return Response.json({ error: 'refreshToken required' }, { status: 400 });
  }

  const tokenHash = sha256(body.refreshToken);
  const stored = await db.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { include: { companyUsers: true } } },
  });

  if (!stored) return Response.json({ error: 'invalid refresh token' }, { status: 401 });
  if (stored.revokedAt) return Response.json({ error: 'token revoked' }, { status: 401 });
  if (stored.rotatedTo) return Response.json({ error: 'token already used (rotated)' }, { status: 401 });
  if (stored.expiresAt.getTime() < Date.now()) return Response.json({ error: 'token expired' }, { status: 401 });

  // Generate new refresh token
  const newRefreshToken = randomBytes(32).toString('hex');
  const newHash = sha256(newRefreshToken);
  const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const companyUser = stored.user.companyUsers.find(link => link.companyId === stored.companyId);
  if (!stored.user.isActive || !companyUser) return Response.json({ error: 'inactive membership' }, { status: 401 });
  const accessToken = await db.$transaction(async tx => {
    const successor = randomUUID();
    const used = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null, rotatedTo: null, expiresAt: { gt: new Date() } },
      data: { rotatedTo: successor },
    });
    if (used.count !== 1) return false;
    await tx.refreshToken.create({ data: {
      id: successor, userId: stored.userId, tokenHash: newHash, companyId: stored.companyId,
      expiresAt: newExpiresAt, userAgent: stored.userAgent, ipAddress: stored.ipAddress,
    } });
    await tx.userSession.deleteMany({ where: { id: stored.id, userId: stored.userId } });
    return issueSessionToken(tx, { userId: stored.userId, email: stored.user.email, role: companyUser.role, companyId: stored.companyId }, stored.userAgent, successor);
  });
  if (!accessToken) return Response.json({ error: 'refresh token no longer valid' }, { status: 401 });

  return Response.json({
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn: 7 * 24 * 60 * 60, // 7 days for access token
  });
}
