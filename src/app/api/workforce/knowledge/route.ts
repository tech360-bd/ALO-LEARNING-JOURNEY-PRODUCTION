import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-auth';
import { retrieveKnowledge } from '@/lib/workforce/engine';

export async function GET(req: NextRequest) {
  try {
    const token = readBearerToken(req.headers.get('Authorization'));
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    const companyId = payload.companyId;
    if (!companyId) {
      return NextResponse.json({ error: 'No company associated' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const query = searchParams.get('query') || '';
    const departmentId = searchParams.get('departmentId') || undefined;
    const category = searchParams.get('category') || undefined;
    const parsedLimit = parseInt(searchParams.get('limit') || '20', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;

    const results = await retrieveKnowledge(
      query,
      departmentId,
      payload.role ? [payload.role] : undefined,
      limit,
      companyId,
      category
    );

    return NextResponse.json({ knowledge: results });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
