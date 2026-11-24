// Record a pending intent only. Client requests cannot settle payments or invoices.
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, forbidden, badRequest, ok, notFound } from '@/lib/v1-middleware';
import { emitEvent } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();

  if (!ctx.isSuperAdmin && ctx.role !== 'company_owner') return forbidden('company_owner role required');
  const body = await request.json().catch(() => null);
  if (!body || !Number.isFinite(body.amount) || body.amount <= 0 ||
      typeof body.provider !== 'string' || !body.provider.trim() || body.provider.length > 190 ||
      typeof body.method !== 'string' || !body.method.trim() || body.method.length > 190 ||
      (body.currency != null && (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency))) ||
      (body.invoiceId != null && typeof body.invoiceId !== 'string')) return badRequest('Invalid payment intent');
  if ((body.status ?? 'pending') !== 'pending' || body.providerPaymentId || body.failureReason) {
    return badRequest('Only a verified provider settlement can set a payment outcome or receipt');
  }

  let invoiceId: string | null = null;
  if (body.invoiceId) {
    const inv = await db.mosInvoice.findFirst({
      where: { id: body.invoiceId, companyId: ctx.companyId },
    });
    if (!inv) return notFound('invoice not found');
    invoiceId = inv.id;
  }

  // Reuse the existing unique primary key. No schema migration or settlement.
  const requestKey = invoiceId ?? request.headers.get('idempotency-key') ?? body.requestId;
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestKey)) return badRequest('A stable requestId is required');
  const id = createHash('sha256').update(JSON.stringify(['pending-payment', ctx.companyId, invoiceId ? 'invoice' : 'request', requestKey])).digest('hex');
  const insert = () => db.payment.create({
    data: {
      id,
      companyId: ctx.companyId,
      invoiceId,
      amount: Number(body.amount),
      currency: body.currency || 'USD',
      provider: String(body.provider),
      method: String(body.method),
      status: 'pending',
      createdBy: ctx.userId,
    },
  });

  let created;
  try { created = await insert(); }
  catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
    const previous = await db.payment.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!previous || previous.invoiceId !== invoiceId || previous.amount !== body.amount || previous.currency !== (body.currency || 'USD') ||
        previous.method !== body.method || previous.provider !== body.provider) return Response.json({ error: 'request_id_conflict' }, { status: 409 });
    return ok({ payment: previous });
  }

  await emitEvent({
    type: 'billing.payment_recorded',
    companyId: ctx.companyId,
    userId: ctx.userId,
    resource: 'payment',
    resourceId: created.id,
    title: 'Payment recorded',
    description: `Payment of ${created.amount} ${created.currency} via ${created.provider} (${created.status})`,
    metadata: {
      amount: created.amount,
      currency: created.currency,
      provider: created.provider,
      method: created.method,
      invoiceId: created.invoiceId,
      status: created.status,
    },
  });

  return ok({
    payment: {
      ...created,
      processedAt: created.processedAt?.toISOString() || null,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    },
  });
}
