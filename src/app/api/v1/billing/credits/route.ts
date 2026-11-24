/**
 * GET /api/v1/billing/credits
 * POST /api/v1/billing/credits/purchase (alias POST to /api/v1/billing/credits)
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, ok } from '@/lib/v1-middleware';
import { POST as purchase } from './purchase/route';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  const credits = await db.usageCredit.findMany({ where: { companyId: ctx.companyId } });
  return ok({ credits });
}

export async function POST(request: Request) {
  return purchase(request);
}
