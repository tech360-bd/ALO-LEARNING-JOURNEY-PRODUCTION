import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-auth';
import { getMemories } from '@/lib/workforce/engine';

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
    const employeeId = searchParams.get('employeeId');
    const type = searchParams.get('type') || undefined;
    const parsedLimit = parseInt(searchParams.get('limit') || '20', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    // Verify employee belongs to caller's tenant BEFORE reading any memory.
    const emp = await db.employee.findFirst({
      where: {
        companyId,
        OR: [
          { id: employeeId },
          { employeeId },
        ],
      },
      select: { id: true },
    });

    if (!emp) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const memories = await getMemories(emp.id, type, limit, companyId);
    return NextResponse.json({ memories });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
