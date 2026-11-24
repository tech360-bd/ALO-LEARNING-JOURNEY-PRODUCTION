import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';

// DELETE /api/settings/sessions/[id] — revoke a session
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    const { id: requested } = await params;
    const id = requested === 'current' ? payload.sid : requested;
    if (typeof id !== 'string' || !id) return NextResponse.json({ error: 'No revocable session' }, { status: 404 });
    const existing = await db.userSession.findFirst({ where: { id, userId: payload.userId } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await db.$transaction(async tx => {
      await tx.refreshToken.updateMany({ where: { id, userId: payload.userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'session_revoked' } });
      await tx.userSession.deleteMany({ where: { id, userId: payload.userId } });
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/settings/sessions/[id]]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
