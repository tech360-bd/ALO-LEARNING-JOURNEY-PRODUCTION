/*
 * POST /api/v1/admin/ai-models/providers/{providerId}/discover-models
 *
 * Provider model discovery is super-admin-only and all outbound requests use
 * provider-http: HTTPS/public DNS by default, DNS-pinned sockets, bounded JSON,
 * no redirects, and an abort timeout. The sole private exception is the
 * documented exact local Ollama endpoint at http://localhost:11434.
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, forbidden, ok, notFound, badRequest } from '@/lib/v1-middleware';
import { decryptSecret } from '@/lib/vault';
import { withResilience } from '@/lib/circuit-breaker';
import { requestProviderJson } from '@/lib/provider-http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();
  if (!ctx.isSuperAdmin) return forbidden('super_admin role required');

  const { providerId } = await params;
  const provider = await db.aiModelProvider.findUnique({ where: { id: providerId } });
  if (!provider) return notFound('provider not found');

  const doImport = new URL(request.url).searchParams.get('import') === 'true';
  let apiKey: string | null = null;
  if (provider.secretCipher) {
    try { apiKey = decryptSecret(provider.secretCipher); } catch { /* never expose vault errors */ }
  } else if (provider.apiKeyEnvName) {
    apiKey = process.env[provider.apiKeyEnvName] || null;
  }
  if (!apiKey && !provider.apiKeyOptional) return badRequest(`no API key configured for ${provider.slug} — set one first`);

  let discovered: Array<{ modelId: string; displayName: string; contextWindow?: number; capabilities?: string[] }>;
  try {
    discovered = await withResilience(
      provider.id,
      provider.slug,
      () => discoverModels(provider.slug, provider.baseUrl || '', apiKey),
      { timeoutMs: 15_000, retryAttempts: 0 },
    );
  } catch {
    // Do not echo the provider URL, response body, or any credential in errors.
    return Response.json({ ok: false, error: 'discovery_failed', message: 'Provider request failed or was blocked by outbound policy.' }, { status: 502 });
  }

  if (doImport) {
    let imported = 0;
    let skipped = 0;
    for (const model of discovered) {
      const existing = await db.aiModelEntry.findUnique({ where: { providerId_modelId: { providerId, modelId: model.modelId } } });
      if (existing) { skipped++; continue; }
      await db.aiModelEntry.create({
        data: {
          providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          contextWindow: model.contextWindow || 8192,
          capabilities: JSON.stringify(model.capabilities || ['chat']),
          isEnabled: true,
        },
      });
      imported++;
    }
    return ok({ provider: provider.slug, discovered: discovered.length, imported, skipped, models: discovered });
  }

  return ok({
    provider: provider.slug,
    discovered: discovered.length,
    models: discovered,
    import_hint: `POST /api/v1/admin/ai-models/providers/${providerId}/discover-models?import=true to add all to the registry`,
  });
}

async function requestModels(url: string, apiKey: string | null, allowLocalOllama = false) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return requestProviderJson(url, { headers, timeoutMs: 12_000, allowLocalOllama });
}

function baseEndpoint(baseUrl: string, suffix: string): string {
  if (!baseUrl) throw new Error('Provider base URL is required');
  return `${baseUrl.replace(/\/$/, '')}${suffix}`;
}

async function discoverModels(slug: string, baseUrl: string, apiKey: string | null): Promise<Array<{ modelId: string; displayName: string; contextWindow?: number; capabilities?: string[] }>> {
  const localOllama = slug === 'ollama' && /^http:\/\/(?:localhost|127\.0\.0\.1):11434(?:\/|$)/i.test(baseUrl);
  const get = (suffix: string) => requestModels(baseEndpoint(baseUrl, suffix), apiKey, localOllama);

  if (slug === 'ollama' || slug === 'ollama-cloud') {
    let result = await get('/v1/models').catch(() => null);
    const data = result?.data as any;
    if (result && result.status >= 200 && result.status < 300 && Array.isArray(data?.data)) {
      return data.data.map((model: any) => ({ modelId: model.id, displayName: model.id, contextWindow: model.context_length || 8192, capabilities: ['chat'] }));
    }
    result = await get('/api/tags').catch(() => null);
    const legacy = result?.data as any;
    if (result && result.status >= 200 && result.status < 300 && Array.isArray(legacy?.models)) {
      return legacy.models.map((model: any) => ({ modelId: model.name, displayName: model.name, contextWindow: 8192, capabilities: ['chat'] }));
    }
    throw new Error('Ollama model listing failed');
  }

  if (['groq', 'openrouter', 'mistral', 'opencode'].includes(slug)) {
    const result = await get('/models');
    const data = result.data as any;
    if (result.status < 200 || result.status >= 300 || !Array.isArray(data?.data)) throw new Error('Provider model listing failed');
    return data.data.map((model: any) => ({
      modelId: model.id, displayName: model.id,
      contextWindow: model.context_length || model.context_window || 8192,
      capabilities: model.capabilities || ['chat'],
    }));
  }

  if (slug === 'gemini') {
    if (!apiKey) throw new Error('Gemini API key is required');
    const url = baseEndpoint(baseUrl, '/models');
    const result = await requestProviderJson(url, { headers: { Accept: 'application/json', 'x-goog-api-key': apiKey }, timeoutMs: 12_000 });
    const data = result.data as any;
    if (result.status < 200 || result.status >= 300 || !Array.isArray(data?.models)) throw new Error('Gemini model listing failed');
    return data.models.filter((model: any) => model.supportedGenerationMethods?.includes('generateContent')).map((model: any) => ({
      modelId: String(model.name || '').replace(/^models\//, ''), displayName: model.displayName || model.name,
      contextWindow: model.inputTokenLimit || 8192, capabilities: ['chat'],
    }));
  }

  if (slug === 'cloudflare') {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId || !apiKey) throw new Error('Cloudflare discovery credentials are missing');
    const result = await requestProviderJson(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, timeoutMs: 12_000,
    });
    const data = result.data as any;
    if (result.status < 200 || result.status >= 300 || !Array.isArray(data?.result)) throw new Error('Cloudflare model listing failed');
    return data.result.map((model: any) => ({ modelId: model.id, displayName: model.name || model.id, contextWindow: 8192, capabilities: ['chat'] }));
  }

  if (slug === 'huggingface') {
    return [
      { modelId: 'meta-llama/Llama-3.3-70B-Instruct', displayName: 'Llama 3.3 70B Instruct' },
      { modelId: 'mistralai/Mistral-7B-Instruct-v0.3', displayName: 'Mistral 7B Instruct v0.3' },
    ];
  }

  if (slug === 'zai') {
    const result = await get('/models');
    const data = result.data as any;
    if (result.status < 200 || result.status >= 300 || !Array.isArray(data?.data)) throw new Error('Provider model listing failed');
    return data.data.map((model: any) => ({ modelId: model.id, displayName: model.id, contextWindow: 128000, capabilities: ['chat'] }));
  }

  // Generic OpenAI-compatible discovery fallback.
  const result = await get('/models');
  const data = result.data as any;
  if (result.status < 200 || result.status >= 300 || !Array.isArray(data?.data)) throw new Error('Provider model listing failed');
  return data.data.map((model: any) => ({ modelId: model.id, displayName: model.id, contextWindow: model.context_length || 8192, capabilities: ['chat'] }));
}
