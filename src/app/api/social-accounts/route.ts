import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { encryptSecret } from '@/lib/vault';

const PLATFORMS = ['Facebook', 'Instagram', 'LinkedIn', 'X', 'YouTube', 'TikTok', 'Pinterest', 'Telegram'];

const PLATFORM_REQUIREMENTS: Record<string, { oauthUrl?: string; scopes: string[]; needsBusinessVerification: boolean; setupGuide: string[] }> = {
  Facebook: { oauthUrl: 'https://developers.facebook.com', scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'], needsBusinessVerification: true, setupGuide: ['Create a Facebook App in Meta Developer Portal', 'Add Facebook Login product', 'Configure OAuth redirect URI', 'Request required permissions', 'Submit for app review'] },
  Instagram: { oauthUrl: 'https://developers.facebook.com', scopes: ['instagram_basic', 'instagram_content_publish'], needsBusinessVerification: true, setupGuide: ['Connect Instagram to a Facebook Page', 'Use Facebook Graph API for Instagram', 'Request instagram_content_publish permission'] },
  LinkedIn: { oauthUrl: 'https://developer.linkedin.com', scopes: ['r_liteprofile', 'r_emailaddress', 'w_member_social'], needsBusinessVerification: false, setupGuide: ['Create LinkedIn App in Developer Portal', 'Set OAuth 2.0 redirect URL', 'Request marketing developer platform access'] },
  X: { oauthUrl: 'https://developer.twitter.com', scopes: ['tweet.read', 'tweet.write', 'users.read'], needsBusinessVerification: false, setupGuide: ['Create X Developer Account', 'Create a Project and App', 'Set up OAuth 2.0', 'Enable Elevated access for posting'] },
  YouTube: { oauthUrl: 'https://console.cloud.google.com', scopes: ['youtube.readonly', 'youtube.upload'], needsBusinessVerification: false, setupGuide: ['Create Google Cloud Project', 'Enable YouTube Data API v3', 'Configure OAuth consent screen', 'Create OAuth 2.0 credentials'] },
  TikTok: { oauthUrl: 'https://developers.tiktok.com', scopes: ['user.info.basic', 'video.publish'], needsBusinessVerification: true, setupGuide: ['Register as TikTok Developer', 'Create an app', 'Set up webhooks', 'Apply for video.publish scope'] },
  Pinterest: { oauthUrl: 'https://developers.pinterest.com', scopes: ['boards:read', 'pins:read', 'pins:write'], needsBusinessVerification: false, setupGuide: ['Create Pinterest Developer Account', 'Create an App', 'Get OAuth credentials'] },
  Telegram: { oauthUrl: 'https://my.telegram.org', scopes: [], needsBusinessVerification: false, setupGuide: ['Create a Telegram Bot via @BotFather', 'Get Bot API Token', 'Set webhook URL for bot'] },
};

function serializeAccount(account: {
  id: string;
  platform: string;
  accountName: string;
  accountHandle: string | null;
  accountId: string | null;
  avatarUrl: string | null;
  accessToken: string | null;
  scopes: string;
  status: string;
  lastSyncedAt: Date | null;
  connectedAt: Date;
  companyId: string;
}) {
  return {
    id: account.id,
    platform: account.platform,
    accountName: account.accountName,
    accountHandle: account.accountHandle,
    accountId: account.accountId,
    avatarUrl: account.avatarUrl,
    tokenConfigured: Boolean(account.accessToken),
    scopes: account.scopes,
    status: account.status,
    lastSyncedAt: account.lastSyncedAt,
    connectedAt: account.connectedAt,
    companyId: account.companyId,
  };
}

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    const accounts = await db.socialAccount.findMany({
      where: { companyId: payload.companyId },
      orderBy: { connectedAt: 'desc' },
    });

    const connectedPlatforms = accounts.map((a) => a.platform);
    const missingPlatforms = PLATFORMS.filter((p) => !connectedPlatforms.includes(p));

    return NextResponse.json({
      accounts: accounts.map(serializeAccount),
      platforms: PLATFORMS,
      connectedPlatforms,
      missingPlatforms,
      requirements: PLATFORM_REQUIREMENTS,
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as {
      platform?: unknown;
      accountName?: unknown;
      accountHandle?: unknown;
      accessToken?: unknown;
      scopes?: unknown;
    } | null;
    const platform = typeof body?.platform === 'string' ? body.platform.trim() : '';
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    const accountName = typeof body?.accountName === 'string' ? body.accountName.trim().slice(0, 120) : '';
    const accountHandle = typeof body?.accountHandle === 'string' ? body.accountHandle.trim().slice(0, 120) : undefined;
    const scopes = Array.isArray(body?.scopes)
      ? body.scopes.filter((s): s is string => typeof s === 'string').slice(0, 30)
      : [];

    if (!platform || !PLATFORMS.includes(platform)) {
      return NextResponse.json({ error: 'Supported platform is required' }, { status: 400 });
    }
    if (accessToken.length < 8) {
      return NextResponse.json({ error: 'Valid access token (min 8 chars) is required' }, { status: 400 });
    }

    const encrypted = encryptSecret(accessToken).ciphertext;

    const account = await db.socialAccount.create({
      data: {
        platform,
        accountName: accountName || `My ${platform}`,
        accountHandle,
        accessToken: encrypted,
        scopes: JSON.stringify(scopes),
        status: 'active',
        lastSyncedAt: new Date(),
        companyId: payload.companyId,
      },
    });

    return NextResponse.json({ account: serializeAccount(account) });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) {
      return NextResponse.json({ error: 'Account id is required' }, { status: 400 });
    }

    const existing = await db.socialAccount.findFirst({
      where: { id, companyId: payload.companyId },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Social account not found' }, { status: 404 });
    }

    await db.socialAccount.delete({ where: { id: existing.id } });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
