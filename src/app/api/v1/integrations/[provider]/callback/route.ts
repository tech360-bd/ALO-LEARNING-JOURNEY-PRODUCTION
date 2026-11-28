/**
 * GET /api/v1/integrations/{provider}/callback
 *
 * OAuth Authorization Code callback. The provider sends the user back
 * here with `?code=<authorization_code>&state=<state_token>` (and
 * optionally `&error=...` if the user denied consent).
 *
 * Security:
 *   - Atomically claims OAuthState (`consumed: false -> true`, unexpired)
 *     BEFORE calling the provider's token endpoint, preventing replay races.
 *   - Enforces timeout, redirect: 'error', and bounded reads on token exchange.
 *   - Uses NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_APP_URL for browser redirects so
 *     reverse-proxied internal origins (e.g. 127.0.0.1:3061) never leak.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getProvider, resolveOAuthClientId, resolveOAuthClientSecret, getCallbackUrl } from '@/lib/providers';
import { validateStateToken } from '@/lib/pkce';
import { encryptSecret, maskSecret } from '@/lib/vault';
import { emitEvent } from '@/lib/events';
import { validateShopifyShopDomain } from '@/lib/provider-http';
import { readLimitedStream } from '@/lib/read-limited-stream.mjs';

export const dynamic = 'force-dynamic';

function buildCallbackRedirect(request: NextRequest, relativeTarget: string): NextResponse {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim();
  let origin: string | null = null;
  if (configured) {
    try {
      origin = new URL(configured).origin;
    } catch {
      origin = null;
    }
  }
  const targetUrl = origin ? new URL(relativeTarget, origin) : new URL(relativeTarget, request.url);
  const res = NextResponse.redirect(targetUrl);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: providerSlug } = await params;
  const redirectBase = '/dashboard?view=integrations';
  const safeProvider = encodeURIComponent(providerSlug);
  const provider = getProvider(providerSlug);
  if (!provider) {
    return buildCallbackRedirect(request, `${redirectBase}&error=unknown_provider`);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');

  // User denied consent on the provider's page
  if (error) {
    return buildCallbackRedirect(
      request,
      `${redirectBase}&provider=${safeProvider}&error=${encodeURIComponent(error)}&desc=${encodeURIComponent((errorDesc || '').slice(0, 200))}`
    );
  }
  if (!code || !state) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=missing_params`);
  }

  // Find the OAuthState row by state token (and verify it's valid)
  const oauthState = await db.oAuthState.findUnique({ where: { state } });
  if (!oauthState || oauthState.provider !== providerSlug) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=invalid_state`);
  }
  if (oauthState.consumed) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=state_consumed`);
  }
  if (oauthState.expiresAt.getTime() < Date.now()) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=state_expired`);
  }

  if (!validateStateToken(oauthState.state, state)) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=state_mismatch`);
  }

  // Resolve OAuth client credentials
  const clientId = resolveOAuthClientId(provider);
  const clientSecret = resolveOAuthClientSecret(provider);
  if (!clientId || !clientSecret) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=client_not_configured`);
  }

  // Atomically claim the single-use OAuthState BEFORE hitting the external token endpoint
  const claimed = await db.oAuthState.updateMany({
    where: {
      id: oauthState.id,
      consumed: false,
      expiresAt: { gt: new Date() },
    },
    data: { consumed: true },
  });
  if (claimed.count !== 1) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=state_consumed`);
  }

  let tokenUrl = provider.tokenUrl!;
  if (tokenUrl.includes('{shop}')) {
    const rawShop = url.searchParams.get('shop') || '';
    try {
      const validShop = validateShopifyShopDomain(rawShop);
      tokenUrl = tokenUrl.replace('{shop}', validShop);
    } catch {
      return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=invalid_shop`);
    }
  }

  // Exchange code → tokens (server-to-server; PKCE verifier only sent here)
  let tokenRes: Response;
  try {
    tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oauthState.redirectUri || getCallbackUrl(providerSlug),
        client_id: clientId,
        client_secret: clientSecret,
        ...(provider.supportsPkce ? { code_verifier: oauthState.codeVerifier } : {}),
      }),
    });
  } catch (err) {
    console.error(`[integrations:${providerSlug}] token exchange network error`, err instanceof Error ? err.message : String(err));
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=token_exchange`);
  }

  const rawTokenBody = await readLimitedStream(tokenRes.body, 256 * 1024).catch(() => Buffer.alloc(0));
  if (!tokenRes.ok) {
    const detail = rawTokenBody.toString('utf8');
    console.error(`[integrations:${providerSlug}] token exchange failed`, tokenRes.status, detail.slice(0, 200));
    await db.integrationLog.create({
      data: {
        integration: { connect: { companyId_provider: { companyId: oauthState.companyId, provider: providerSlug } } },
        action: 'callback',
        outcome: 'failure',
        message: `token_exchange_failed: HTTP ${tokenRes.status}`,
        actorUserId: oauthState.userId,
        source: 'api',
      },
    }).catch(() => undefined);
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=token_exchange`);
  }

  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(rawTokenBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=token_exchange`);
  }
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined;
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
  const grantedScopes: string[] = typeof tokens.scope === 'string'
    ? tokens.scope.split(/[\s,]+/).filter(Boolean)
    : provider.scopes;

  if (!accessToken) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=no_access_token`);
  }

  // Encrypt + persist secrets
  const integration = await db.integration.findFirst({
    where: { companyId: oauthState.companyId, provider: providerSlug },
  });
  if (!integration) {
    return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&error=integration_not_found`);
  }

  const accessEncrypted = encryptSecret(accessToken);
  await db.integrationSecret.upsert({
    where: { integrationId_kind: { integrationId: integration.id, kind: 'access_token' } },
    update: { ciphertext: accessEncrypted.ciphertext, keyVersion: accessEncrypted.keyVersion, maskedValue: maskSecret(accessToken), rotatedAt: new Date() },
    create: { integrationId: integration.id, kind: 'access_token', ...accessEncrypted, maskedValue: maskSecret(accessToken) },
  });

  if (refreshToken) {
    const refreshEncrypted = encryptSecret(refreshToken);
    await db.integrationSecret.upsert({
      where: { integrationId_kind: { integrationId: integration.id, kind: 'refresh_token' } },
      update: { ciphertext: refreshEncrypted.ciphertext, keyVersion: refreshEncrypted.keyVersion, maskedValue: maskSecret(refreshToken), rotatedAt: new Date() },
      create: { integrationId: integration.id, kind: 'refresh_token', ...refreshEncrypted, maskedValue: maskSecret(refreshToken) },
    });
  }

  // Mark integration connected (OAuthState was already atomically claimed above)
  await db.$transaction([
    db.integration.update({
      where: { id: integration.id },
      data: {
        status: 'connected',
        authMethod: 'oauth',
        grantedScopes: JSON.stringify(grantedScopes),
        tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        refreshSupported: !!refreshToken,
        currentStateId: null,
        lastValidatedAt: new Date(),
        updatedBy: oauthState.userId,
      },
    }),
    db.integrationLog.create({
      data: {
        integrationId: integration.id,
        action: 'callback',
        outcome: 'success',
        message: `oauth completed; scopes=${grantedScopes.length}`,
        actorUserId: oauthState.userId,
        source: 'api',
      },
    }),
  ]);

  // Fire event so notifications, audit log, and webhooks fire
  await emitEvent({
    type: 'integration.connected',
    companyId: oauthState.companyId,
    userId: oauthState.userId,
    resource: 'integration',
    resourceId: integration.id,
    metadata: { provider: providerSlug, scopes: grantedScopes },
  });

  return buildCallbackRedirect(request, `${redirectBase}&provider=${safeProvider}&status=connected`);
}
