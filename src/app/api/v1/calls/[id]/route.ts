/**
 * GET /api/v1/calls/[id] — call detail with events
 * PATCH /api/v1/calls/[id] — update call notes/outcome within tenant boundary
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, notFound, badRequest, ok } from '@/lib/v1-middleware';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  const { id } = await params;

  const call = await db.call.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { events: { orderBy: { timestamp: 'asc' } } },
  });
  if (!call) return notFound('call not found');

  return ok(call);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return badRequest('invalid JSON payload');
  }
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 10_000) : undefined;
  if (notes === undefined) {
    return badRequest('notes field is required');
  }

  const existing = await db.call.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!existing) return notFound('call not found');

  const updated = await db.call.update({
    where: { id: existing.id },
    data: { summary: notes },
  });

  return ok(updated);
}
