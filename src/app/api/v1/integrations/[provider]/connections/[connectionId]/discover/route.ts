/**
 * Resource Discovery — POST /api/v1/integrations/{provider}/connections/{connection_id}/discover
 *
 * Calls the provider's discovery API server-to-server using the encrypted
 * access token or manual credentials from the vault via `requestProviderJson`
 * (HTTPS/public DNS only, DNS-pinned sockets, no redirects, bounded response,
 * timeout). Returns only non-secret resources the user is authorized to access.
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, notFound, badRequest, ok } from '@/lib/v1-middleware';
import { decryptSecret } from '@/lib/vault';
import { getProvider } from '@/lib/providers';
import {
  requestProviderJson,
  validateMailchimpServerPrefix,
  validateShopifyShopDomain,
  validateWordpressSiteUrl,
} from '@/lib/provider-http';

export const dynamic = 'force-dynamic';

type IntegrationRecord = {
  id: string;
  provider: string;
  companyId: string;
  secrets: Array<{ kind: string; ciphertext: string }>;
};

type DiscoveredItem = {
  id: string;
  name?: string | null;
  type?: string;
  permission?: string | null;
  metadata?: Record<string, unknown>;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string; connectionId: string }> }
) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();

  const { provider: providerSlug, connectionId } = await params;
  const integration = await db.integration.findFirst({
    where: { id: connectionId, companyId: ctx.companyId, provider: providerSlug },
    include: { secrets: true },
  });
  if (!integration) return notFound('integration not found');
  if (integration.status !== 'connected') {
    return badRequest(`integration is ${integration.status}; complete OAuth or submit credentials first`);
  }

  const provider = getProvider(integration.provider);
  if (!provider) return notFound(`unknown provider: ${integration.provider}`);

  const accessTokenRow = integration.secrets.find((s) => s.kind === 'access_token');
  const accessToken = accessTokenRow ? decryptSecret(accessTokenRow.ciphertext) : null;

  let discovered: Record<string, unknown>;
  try {
    discovered = await runDiscovery(provider.discoverer, integration, accessToken);
  } catch (err) {
    const safeMsg = err instanceof Error && /HTTPS|public DNS|non-public|redirects|domain|prefix|site_url|HTTP \d+/i.test(err.message)
      ? err.message
      : 'Provider discovery request failed';
    await db.integrationLog.create({
      data: {
        integrationId: integration.id,
        action: 'discover',
        outcome: 'failure',
        message: safeMsg,
        actorUserId: ctx.userId,
        source: 'api',
      },
    });
    return Response.json(
      { ok: false, error: 'discovery_failed', message: safeMsg },
      { status: 502 }
    );
  }

  for (const [type, items] of Object.entries(discovered)) {
    if (!Array.isArray(items)) continue;
    for (const rawItem of items) {
      const item = rawItem as DiscoveredItem;
      if (!item || item.id === undefined || item.id === null) continue;
      const resourceId = String(item.id);
      const name = item.name || null;
      const permission = item.permission || null;
      const metadata = JSON.stringify(item.metadata || {});
      const existing = await db.integrationResource.findUnique({
        where: { integrationId_type_resourceId: { integrationId: integration.id, type, resourceId } },
      });
      if (existing) {
        await db.integrationResource.update({
          where: { id: existing.id },
          data: { name, permission, metadata, status: 'valid' },
        });
      } else {
        await db.integrationResource.create({
          data: { integrationId: integration.id, type, resourceId, name, permission, metadata, status: 'valid', selected: false },
        });
      }
    }
  }

  await db.integrationLog.create({
    data: {
      integrationId: integration.id,
      action: 'discover',
      outcome: 'success',
      message: `discovered ${Object.values(discovered).reduce<number>((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)} resources`,
      actorUserId: ctx.userId,
      source: 'api',
    },
  });

  return ok({ provider: integration.provider, resources: discovered });
}

async function providerGetJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await requestProviderJson(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`provider HTTP ${res.status}`);
  }
  return (res.data ?? {}) as Record<string, unknown>;
}

async function runDiscovery(
  discoverer: string,
  integration: IntegrationRecord,
  accessToken: string | null
): Promise<Record<string, unknown>> {
  switch (discoverer) {
    case 'google_search_console':
    case 'google_youtube':
    case 'google_ga4':
    case 'google_gtm':
    case 'google_ads':
    case 'google_business':
      return discoverGoogle(accessToken);
    case 'meta_pages':
    case 'meta_ad_accounts':
    case 'meta_pixels':
    case 'meta_whatsapp':
      return discoverMeta(accessToken);
    case 'linkedin_organizations':
      return discoverLinkedin(accessToken);
    case 'x_account':
      return discoverX(accessToken);
    case 'tiktok_account':
      return discoverTiktok(accessToken);
    case 'pinterest_boards':
      return discoverPinterest(accessToken);
    case 'wordpress_site':
      return discoverWordPress(integration);
    case 'shopify_store':
      return discoverShopify(integration, accessToken);
    case 'stripe_account':
      return discoverStripe(accessToken);
    case 'hubspot_account':
      return discoverHubspot(accessToken);
    case 'mailchimp_audiences':
      return discoverMailchimp(integration);
    case 'sendgrid_sender_identities':
      return discoverSendgrid(integration);
    default:
      return { error: `no discoverer implemented for "${discoverer}"` };
  }
}

async function discoverGoogle(accessToken: string | null): Promise<Record<string, unknown>> {
  if (!accessToken) return { error: 'no access token — connect via OAuth first' };
  const [searchConsole, youtube, ga4, gtm] = await Promise.allSettled([
    discoverGoogleSearchConsole(accessToken),
    discoverYouTube(accessToken),
    discoverGA4(accessToken),
    discoverGTM(accessToken),
  ]);
  return {
    search_console_sites: settled(searchConsole),
    youtube_channels: settled(youtube),
    ga4_properties: settled(ga4),
    gtm_containers: settled(gtm),
  };
}

function settled<T>(p: PromiseSettledResult<T>): T | { error: string } {
  return p.status === 'fulfilled'
    ? p.value
    : { error: p.reason instanceof Error ? p.reason.message : 'request failed' };
}

async function discoverGoogleSearchConsole(token: string) {
  const data = await providerGetJson('https://www.googleapis.com/webmasters/v3/sites', {
    Authorization: `Bearer ${token}`,
  });
  const siteEntry = Array.isArray(data.siteEntry) ? data.siteEntry : [];
  return siteEntry.map((s: Record<string, unknown>) => ({
    id: String(s.siteUrl || ''),
    name: String(s.siteUrl || ''),
    permission: typeof s.permissionLevel === 'string' ? s.permissionLevel : null,
    type: 'search_console_site',
    metadata: { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel },
  }));
}

async function discoverYouTube(token: string) {
  const data = await providerGetJson('https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true', {
    Authorization: `Bearer ${token}`,
  });
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((c: Record<string, any>) => ({
    id: String(c.id || ''),
    name: c.snippet?.title,
    type: 'youtube_channel',
    permission: 'owner',
    metadata: { country: c.snippet?.country, uploadsPlaylist: c.contentDetails?.relatedPlaylists?.uploads },
  }));
}

async function discoverGA4(token: string) {
  const data = await providerGetJson('https://analyticsadmin.googleapis.com/v1beta/properties?show_deleted=false', {
    Authorization: `Bearer ${token}`,
  });
  const props = Array.isArray(data.properties) ? data.properties : [];
  return props.map((p: Record<string, any>) => ({
    id: String(p.name || '').replace('properties/', ''),
    name: p.displayName,
    type: 'ga4_property',
    permission: 'reader',
    metadata: { industry: p.industryCategory, timeZone: p.timeZone, currencyCode: p.currencyCode },
  }));
}

async function discoverGTM(token: string) {
  const data = await providerGetJson('https://tagmanager.googleapis.com/tagmanager/v2/accounts', {
    Authorization: `Bearer ${token}`,
  });
  const accounts = Array.isArray(data.account) ? data.account : [];
  const out: DiscoveredItem[] = [];
  for (const a of accounts as Array<Record<string, any>>) {
    const accountId = encodeURIComponent(String(a.accountId || ''));
    if (!accountId) continue;
    const cs = await providerGetJson(`https://tagmanager.googleapis.com/tagmanager/v2/accounts/${accountId}/containers`, {
      Authorization: `Bearer ${token}`,
    }).catch(() => null);
    const containers = Array.isArray(cs?.container) ? cs.container : [];
    for (const c of containers as Array<Record<string, any>>) {
      out.push({
        id: `${a.accountId}-${c.publicId}`,
        name: `${a.name} / ${c.name}`,
        type: 'gtm_container',
        permission: a.tagManagerId ? 'owner' : 'user',
        metadata: { publicId: c.publicId, usageContext: c.usageContext },
      });
    }
  }
  return out;
}

async function discoverMeta(accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const [pages, adAccounts] = await Promise.allSettled([
    providerGetJson('https://graph.facebook.com/v19.0/me/accounts?fields=id,name,category,access_token', {
      Authorization: `Bearer ${accessToken}`,
    }),
    providerGetJson('https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id,currency', {
      Authorization: `Bearer ${accessToken}`,
    }),
  ]);
  const pagesList = pages.status === 'fulfilled' && Array.isArray(pages.value.data) ? (pages.value.data as Array<Record<string, any>>) : [];
  const adsList = adAccounts.status === 'fulfilled' && Array.isArray(adAccounts.value.data) ? (adAccounts.value.data as Array<Record<string, any>>) : [];

  const instagramAccounts: Array<Record<string, any>> = [];
  const pixels: Array<{ id: string; name: string; page_id: string }> = [];
  await Promise.all(
    pagesList.map(async (page) => {
      const pageId = encodeURIComponent(String(page.id || ''));
      const pageToken = typeof page.access_token === 'string' && page.access_token ? page.access_token : accessToken;
      const igRes = await providerGetJson(
        `https://graph.facebook.com/v19.0/${pageId}?fields=connected_instagram_account{username,name,followers_count}`,
        { Authorization: `Bearer ${pageToken}` }
      ).catch(() => null);
      if (igRes?.connected_instagram_account && typeof igRes.connected_instagram_account === 'object') {
        instagramAccounts.push({ ...(igRes.connected_instagram_account as Record<string, any>), page_id: String(page.id) });
      }
      const pxRes = await providerGetJson(
        `https://graph.facebook.com/v19.0/${pageId}/adaccounts?fields=pixels`,
        { Authorization: `Bearer ${pageToken}` }
      ).catch(() => null);
      const pxAccounts = Array.isArray(pxRes?.data) ? (pxRes.data as Array<Record<string, any>>) : [];
      for (const acct of pxAccounts) {
        const pxData = Array.isArray(acct.pixels?.data) ? (acct.pixels.data as Array<Record<string, any>>) : [];
        for (const px of pxData) {
          pixels.push({ id: String(px.id || ''), name: String(px.name || ''), page_id: String(page.id) });
        }
      }
    })
  );

  return {
    facebook_pages: pagesList.map((p) => ({
      id: String(p.id || ''),
      name: p.name,
      type: 'fb_page',
      permission: p.category || 'page',
      metadata: { category: p.category },
    })),
    instagram_accounts: instagramAccounts.map((ig) => ({
      id: String(ig.id || ''),
      name: ig.username || ig.name,
      type: 'ig_account',
      permission: 'admin',
      metadata: { followers: ig.followers_count, page_id: ig.page_id },
    })),
    ad_accounts: adsList.map((a) => ({
      id: String(a.id || ''),
      name: a.name,
      type: 'ad_account',
      permission: 'advertiser',
      metadata: { accountId: a.account_id, currency: a.currency },
    })),
    pixels: pixels.map((p) => ({
      id: p.id,
      name: p.name,
      type: 'pixel',
      permission: 'reader',
      metadata: { page_id: p.page_id },
    })),
  };
}

async function discoverLinkedin(accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const res = await requestProviderJson(
    'https://api.linkedin.com/v2/organizations?q=organizationRoleAssignments&role=ADMINISTRATOR&state=ACTIVE',
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, timeoutMs: 12_000 }
  );
  if (res.status < 200 || res.status >= 300) return { error: `linkedin HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    linkedin_organizations: (Array.isArray(data.elements) ? data.elements : []).map((o: any) => ({
      id: o.id || o['organization~']?.id,
      name: o['organization~']?.localizedName || o['organization~']?.name?.localized?.en_US,
      type: 'linkedin_page',
      permission: 'ADMINISTRATOR',
    })),
  };
}

async function discoverX(accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const res = await requestProviderJson('https://api.twitter.com/2/users/me', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `x HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    x_accounts: [
      {
        id: data.data?.id,
        name: data.data?.name,
        type: 'x_account',
        permission: 'owner',
        metadata: { username: data.data?.username },
      },
    ],
  };
}

async function discoverTiktok(accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const res = await requestProviderJson('https://open.tiktokapis.com/v2/user/info/', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `tiktok HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    tiktok_accounts: [
      {
        id: data.data?.user?.open_id,
        name: data.data?.user?.display_name || data.data?.user?.username,
        type: 'tiktok_account',
        permission: 'owner',
      },
    ],
  };
}

async function discoverPinterest(accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const res = await requestProviderJson('https://api.pinterest.com/v5/boards?page_size=50', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `pinterest HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    pinterest_boards: (Array.isArray(data.items) ? data.items : []).map((b: any) => ({
      id: b.id,
      name: b.name,
      type: 'pinterest_board',
      permission: 'owner',
    })),
  };
}

async function discoverWordPress(integration: IntegrationRecord) {
  const siteUrlRow = await db.integrationResource.findFirst({
    where: { integrationId: integration.id, type: 'manual_field', resourceId: 'site_url' },
  });
  const usernameRow = await db.integrationResource.findFirst({
    where: { integrationId: integration.id, type: 'manual_field', resourceId: 'username' },
  });
  const secretRow = integration.secrets.find((s) => s.kind === 'application_password');
  if (!siteUrlRow?.name || !usernameRow?.name || !secretRow) {
    return { error: 'wordpress credentials incomplete' };
  }

  const siteUrl = validateWordpressSiteUrl(siteUrlRow.name);
  const username = usernameRow.name;
  const appPassword = decryptSecret(secretRow.ciphertext).replace(/\s/g, '');
  const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');

  const res = await requestProviderJson(`${siteUrl}/wp-json/wp/v2/users/me`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `wordpress HTTP ${res.status}` };
  const user = (res.data ?? {}) as Record<string, any>;
  return {
    wordpress_sites: [
      {
        id: siteUrl,
        name: siteUrl,
        type: 'wp_site',
        permission: user.roles?.[0] || 'user',
        metadata: { currentUserId: user.id, username: user.slug, roles: user.roles },
      },
    ],
  };
}

async function discoverShopify(integration: IntegrationRecord, accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const shopRow = await db.integrationResource.findFirst({
    where: { integrationId: integration.id, type: 'manual_field', resourceId: 'shop' },
  });
  if (!shopRow?.name) return { error: 'shop domain missing' };
  const shopDomain = validateShopifyShopDomain(shopRow.name);
  const res = await requestProviderJson(`https://${shopDomain}/admin/api/2024-10/shop.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `shopify HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    shopify_stores: [
      {
        id: data.shop?.id?.toString(),
        name: data.shop?.name,
        type: 'shopify_store',
        permission: 'owner',
        metadata: { domain: data.shop?.domain, currency: data.shop?.currency, country: data.shop?.country },
      },
    ],
  };
}

async function discoverStripe(accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const res = await requestProviderJson('https://api.stripe.com/v1/accounts', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `stripe HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    stripe_accounts: (Array.isArray(data.data) ? data.data : []).map((a: any) => ({
      id: a.id,
      name: a.business_profile?.name || a.id,
      type: 'stripe_account',
      permission: a.payouts_enabled ? 'owner' : 'reader',
      metadata: { country: a.country, defaultCurrency: a.default_currency },
    })),
  };
}

async function discoverHubspot(accessToken: string | null) {
  if (!accessToken) return { error: 'no access token' };
  const res = await requestProviderJson(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `hubspot HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    hubspot_accounts: [
      {
        id: data.user_id?.toString() || data.hub_id?.toString(),
        name: data.user,
        type: 'hubspot_account',
        permission: 'owner',
        metadata: { hubId: data.hub_id, scopes: data.scopes },
      },
    ],
  };
}

async function discoverMailchimp(integration: IntegrationRecord) {
  const apiKeyRow = integration.secrets.find((s) => s.kind === 'api_key');
  const dcRow = await db.integrationResource.findFirst({
    where: { integrationId: integration.id, type: 'manual_field', resourceId: 'server_prefix' },
  });
  if (!apiKeyRow || !dcRow?.name) return { error: 'mailchimp credentials incomplete' };
  const apiKey = decryptSecret(apiKeyRow.ciphertext);
  const dc = validateMailchimpServerPrefix(dcRow.name);
  const res = await requestProviderJson(`https://${dc}.api.mailchimp.com/3.0/lists`, {
    headers: { Authorization: `Basic ${Buffer.from(`any:${apiKey}`).toString('base64')}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `mailchimp HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    mailchimp_audiences: (Array.isArray(data.lists) ? data.lists : []).map((l: any) => ({
      id: l.id,
      name: l.name,
      type: 'mailchimp_audience',
      permission: 'owner',
      metadata: { memberCount: l.stats?.member_count },
    })),
  };
}

async function discoverSendgrid(integration: IntegrationRecord) {
  const apiKeyRow = integration.secrets.find((s) => s.kind === 'api_key');
  if (!apiKeyRow) return { error: 'sendgrid api key missing' };
  const apiKey = decryptSecret(apiKeyRow.ciphertext);
  const res = await requestProviderJson('https://api.sendgrid.com/v3/senders?limit=50', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (res.status < 200 || res.status >= 300) return { error: `sendgrid HTTP ${res.status}` };
  const data = (res.data ?? {}) as Record<string, any>;
  return {
    sendgrid_sender_identities: (Array.isArray(data.senders) ? data.senders : []).map((s: any) => ({
      id: s.id?.toString(),
      name: s.nickname || s.from?.email,
      type: 'sendgrid_sender',
      permission: 'owner',
      metadata: { email: s.from?.email, verified: s.verified },
    })),
  };
}
