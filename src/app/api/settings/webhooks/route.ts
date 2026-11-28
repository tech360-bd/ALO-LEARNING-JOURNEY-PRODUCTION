import { canManageTeam } from '@/lib/team-roles';
import { publicUrl } from '@/lib/public-http';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-auth';
import { createWebhookSecret, storeWebhookSecret } from '@/lib/webhook-signature';

function parseEvents(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

// GET /api/settings/webhooks
export async function GET(req: NextRequest) {
  try {
    const token = readBearerToken(req.headers.get('Authorization'));
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload || !payload.companyId) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    const webhooks = await db.webhook.findMany({
      where: { companyId: payload.companyId },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(
      {
        webhooks: webhooks.map((w) => ({
          id: w.id,
          url: w.url,
          events: parseEvents(w.events),
          status: w.status,
          secretConfigured: Boolean(w.secret),
          createdAt: w.createdAt.toISOString(),
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    console.error('[GET /api/settings/webhooks] failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/settings/webhooks
export async function POST(req: NextRequest) {
  try {
    const token = readBearerToken(req.headers.get('Authorization'));
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload || !payload.companyId) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    if (!canManageTeam(payload.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const data = await req.json().catch(() => null);
    if (!data || typeof data !== 'object' || !data.url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }
    let validatedUrl: URL;
    try { validatedUrl = publicUrl(String(data.url), true); } catch { return NextResponse.json({ error: 'Webhook origin not approved' }, { status: 400 }); }

    if (
      data.events !== undefined &&
      (!Array.isArray(data.events) ||
        data.events.length > 50 ||
        data.events.some((e: unknown) => typeof e !== 'string' || e.trim().length === 0 || e.length > 120))
    ) {
      return NextResponse.json({ error: 'Invalid events array' }, { status: 400 });
    }
    const events: string[] = Array.isArray(data.events) ? data.events : [];

    const secret = createWebhookSecret();
    const webhook = await db.webhook.create({
      data: {
        url: validatedUrl.toString(),
        events: JSON.stringify(events),
        status: 'active',
        secret: storeWebhookSecret(secret),
        companyId: payload.companyId,
      },
    });
    return NextResponse.json({
      webhook: {
        id: webhook.id,
        url: webhook.url,
        events: parseEvents(webhook.events),
        status: webhook.status,
        secret,
        secretDisclosure: 'one_time',
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Avoid logging Prisma request objects that could contain the one-time secret.
    console.error('[POST /api/settings/webhooks] failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
