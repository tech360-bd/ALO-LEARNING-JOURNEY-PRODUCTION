import { canManageTeam } from '@/lib/team-roles';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-auth';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = readBearerToken(req.headers.get('Authorization'));
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload || !payload.companyId) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    if (!canManageTeam(payload.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id } = await params;
    const existing = await db.webhook.findFirst({ where: { id, companyId: payload.companyId } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await db.webhook.delete({ where: { id, companyId: payload.companyId } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/settings/webhooks/[id]]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
