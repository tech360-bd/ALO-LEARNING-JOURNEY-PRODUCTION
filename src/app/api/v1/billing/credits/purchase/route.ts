import { getSessionContext, unauthorized, forbidden, notConfigured } from '@/lib/v1-middleware';

export const dynamic = 'force-dynamic';

// There is no trusted settlement callback or unique receipt ledger yet. A
// client-supplied amount (even from an owner) is not evidence of payment.
export async function POST(request: Request) {
  const ctx = await getSessionContext(request);
  if (!ctx.authenticated) return unauthorized();
  if (!ctx.isSuperAdmin && ctx.role !== 'company_owner') return forbidden('company_owner role required');
  return notConfigured('credit_purchase', 'Verified payment settlement is unavailable. No credits were added.');
}
