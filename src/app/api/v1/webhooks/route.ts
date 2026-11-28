/**
 * GET  /api/v1/webhooks   — list webhook endpoints for tenant
 * POST /api/v1/webhooks   — create a new webhook endpoint
 *
 * Webhooks fire on events that match the `events` filter (or all events if
 * empty). The HMAC-SHA256 signature in the `X-MarketingOS-Signature` header
 * lets the receiver verify authenticity.
 *
 * Body for POST:
 *   { "url": "https://example.com/webhooks/marketingos",
 *     "events": ["call.originated","call.ended","voicemail.created"] }   // [] = all
 *     "status": "active"|"disabled", "secret": "..." }                    // optional
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, forbidden, badRequest } from '@/lib/v1-middleware';
import { maskSecret } from '@/lib/vault';
import { emitEvent } from '@/lib/events';
import { publicUrl } from '@/lib/public-http';
import { createWebhookSecret, resolveWebhookSecret, storeWebhookSecret } from '@/lib/webhook-signature';

export const dynamic = 'force-dynamic';

function parseEvents(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

function maskStoredSecret(stored: string): string {
  try {
    return maskSecret(resolveWebhookSecret(stored));
  } catch {
    return '****';
  }
}

export async function GET(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();

  const hooks = await db.webhook.findMany({
    where: { companyId: ctx.companyId },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(
    {
      ok: true,
      data: {
        webhooks: hooks.map((h) => ({
          id: h.id,
          url: h.url,
          events: parseEvents(h.events),
          status: h.status,
          secretConfigured: Boolean(h.secret),
          secretMasked: h.secret ? maskStoredSecret(h.secret) : null,
          createdAt: h.createdAt.toISOString(),
          updatedAt: h.updatedAt.toISOString(),
        })),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  if (!ctx.isSuperAdmin && !['company_owner', 'admin', 'manager'].includes(ctx.role)) {
    return forbidden('manager role required');
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !body.url) return badRequest('url is required');

  let validatedUrl: URL;
  try {
    validatedUrl = publicUrl(String(body.url), true);
  } catch {
    return badRequest('Webhook origin not approved');
  }

  const status = body.status === undefined ? 'active' : String(body.status);
  if (status !== 'active' && status !== 'disabled') {
    return badRequest('status must be active or disabled');
  }

  if (
    body.events !== undefined &&
    (!Array.isArray(body.events) ||
      body.events.length > 50 ||
      body.events.some((e: unknown) => typeof e !== 'string' || e.trim().length === 0 || e.length > 120))
  ) {
    return badRequest('events must be an array of non-empty strings');
  }
  const events: string[] = Array.isArray(body.events) ? body.events : [];

  let secret: string;
  if (body.secret !== undefined) {
    if (typeof body.secret !== 'string' || body.secret.length < 16 || body.secret.length > 256) {
      return badRequest('secret must be a string between 16 and 256 characters');
    }
    secret = body.secret;
  } else {
    secret = createWebhookSecret();
  }

  const encryptedSecret = storeWebhookSecret(secret);
  const url = validatedUrl.toString();

  const created = await db.webhook.create({
    data: {
      url,
      events: JSON.stringify(events),
      status,
      secret: encryptedSecret,
      companyId: ctx.companyId,
    },
  });

  await emitEvent({
    type: 'webhook.created',
    companyId: ctx.companyId,
    userId: ctx.userId,
    resource: 'webhook',
    resourceId: created.id,
    title: 'Webhook created',
    description: `Webhook endpoint registered: ${validatedUrl.origin}`,
    metadata: {
      url,
      events,
      status: created.status,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      data: {
        webhook: {
          id: created.id,
          url: created.url,
          events: parseEvents(created.events),
          status: created.status,
          secretMasked: maskSecret(secret),
          // Return the secret ONLY at creation time so the client can copy it
          secretOneTime: secret,
          secretDisclosure: 'one_time',
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
        },
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
