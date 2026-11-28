/** MarketingOS provider failover. Hosted models require owner opt-in; a
 * free-tier label is not a price guarantee. The final rule-based provider
 * produces deterministic output, not model inference. */
import { getPrivateLocalBaseUrl } from '@/lib/local-models';
import { createApprovedZai } from '@/lib/approved-zai';
import { requestProviderJson } from '@/lib/provider-http';

import { isExternalAiAllowed } from '@/lib/agentos/payment-guard';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChainCallOptions {
  /** Soft cap to keep free-tier responses bounded. */
  maxTokens?: number;
  /** Temperature for sampling; 0 = deterministic. */
  temperature?: number;
  /** Caller-supplied identifier for the model name (e.g. "groq:llama-3.3-70b"). */
  preferredModel?: string;
  /** Optional provider slug to try first within the remote/registry chain (e.g. "groq"). */
  preferredProvider?: string;
}

export interface ChainCallResult {
  text: string;
  /** Which provider actually served the request. */
  provider: 'zai' | 'groq' | 'gemini' | 'openrouter-free' | 'ollama' | 'rule-based';
  /** Model id from the provider (for audit log). */
  model: string;
  /** How many providers were tried before success. */
  attempts: number;
  /** Round-trip latency in ms. */
  durationMs: number;
  /** Total prompt tokens consumed (if reported). */
  promptTokens?: number;
  /** Total completion tokens consumed (if reported). */
  completionTokens?: number;
  /** Whether the rule-based fallback was used (no LLM call). */
  fallback: boolean;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.4;

function extractPreferredModel(preferredModel: string | undefined, prefix: string): string | null {
  if (!preferredModel?.startsWith(prefix)) return null;
  const model = preferredModel.slice(prefix.length).trim();
  return model.length > 0 ? model : null;
}

function resolvePreferredProvider(options: ChainCallOptions): string | null {
  if (options.preferredProvider?.trim()) return options.preferredProvider.trim();
  const colonIdx = options.preferredModel?.indexOf(':') ?? -1;
  if (colonIdx > 0) {
    return options.preferredModel!.slice(0, colonIdx).trim() || null;
  }
  return null;
}

/**
 * Ask the local Ollama server. Returns null (never throws) when it cannot
 * answer, so callers can decide whether to continue down a chain.
 */
async function tryOllama(
  messages: ChatMessage[],
  options: ChainCallOptions,
  maxTokens: number,
  temperature: number,
  modelOverride?: string,
): Promise<{ text: string; model: string; promptTokens?: number; completionTokens?: number } | null> {
  try {
    const ollamaUrl = getPrivateLocalBaseUrl('OLLAMA_BASE_URL', 'http://localhost:11434').href.replace(/\/$/, '');
    const model = modelOverride
      ?? extractPreferredModel(options.preferredModel, 'ollama:')
      ?? (process.env.OLLAMA_CHAT_MODEL || process.env.OLLAMA_MODEL || 'llama3.2');
    const r = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST', signal: AbortSignal.timeout(30000), redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, options: { temperature, num_predict: maxTokens } }),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    const text = data?.message?.content || '';
    if (!text) return null;
    return { text, model, promptTokens: data?.prompt_eval_count, completionTokens: data?.eval_count };
  } catch {
    return null;
  }
}

/**
 * Run a chat completion through the free-model chain.
 *
 * If `ruleBasedFallback` is omitted, the chain ends in a deterministic
 * echo of the last user message — this guarantees the agent ALWAYS has
 * a response, even if every LLM provider is down or rate-limited.
 */
export async function chainChat(
  messages: ChatMessage[],
  options: ChainCallOptions = {},
  ruleBasedFallback?: (messages: ChatMessage[]) => string
): Promise<ChainCallResult> {
  const start = Date.now();
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  const attempts: Array<{ provider: ChainCallResult['provider']; ok: boolean; error?: string }> = [];

  // ── 0. LOCAL FIRST ──────────────────────────────────────────────────────
  // The policy on this deployment is "self-hosted, $0, data stays on the box",
  // so Ollama answers before any remote provider is contacted. This is not a
  // preference among equals: a remote call costs money, sends student text to a
  // third party and fails when the network does. `ALO_PROVIDER_ORDER=remote-first`
  // restores the old behaviour for an operator who wants it, and is the only way
  // to reorder this.
  const localFirst = (process.env.ALO_PROVIDER_ORDER ?? 'local-first') !== 'remote-first';
  if (localFirst) {
    const local = await tryOllama(messages, options, maxTokens, temperature);
    if (local) {
      attempts.push({ provider: 'ollama', ok: true });
      return makeResult(local.text, 'ollama', local.model, attempts.length, start, {
        promptTokens: local.promptTokens,
        completionTokens: local.completionTokens,
      });
    }
    attempts.push({ provider: 'ollama', ok: false, error: 'local model unavailable' });
  }

  // 1. Registry-driven path — if the Super Admin has configured providers
  //    in the AiModelProvider table, try those first (in priority order, with
  //    any pinned preferred provider lifted to the front).
  try {
    const registryResult = await tryRegistryProviders(messages, options, maxTokens, temperature, start, attempts);
    if (registryResult) return registryResult;
  } catch (e: any) {
    // Registry read failure — fall through to env-var path
    attempts.push({ provider: 'rule-based', ok: false, error: `registry_error: ${e?.message?.slice(0, 80) || 'unknown'}` });
  }

  // Env-var provider helpers (Z.AI, Groq, Gemini, OpenRouter). If a preferred
  // provider is pinned, move it to the front without duplicating it.
  const tryZaiEnv = async (): Promise<ChainCallResult | null> => {
    try {
      attempts.push({ provider: 'zai', ok: true });
      const zai = await loadZai();
      if (zai) {
        const r = await zai.chat.completions.create({
          messages,
          max_tokens: maxTokens,
          temperature,
        });
        const text = (r as any)?.choices?.[0]?.message?.content || '';
        if (text) {
          return makeResult(text, 'zai', (r as any)?.model || 'glm-4.6', attempts.length, start, {
            promptTokens: (r as any)?.usage?.prompt_tokens,
            completionTokens: (r as any)?.usage?.completion_tokens,
          });
        }
      }
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = 'empty response';
    } catch (e: any) {
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = e?.message?.slice(0, 120) || 'zai failed';
    }
    return null;
  };

  const tryGroqEnv = async (): Promise<ChainCallResult | null> => {
    if (!isExternalAiAllowed() || !process.env.GROQ_API_KEY) return null;
    try {
      attempts.push({ provider: 'groq', ok: true });
      const requestedModel = extractPreferredModel(options.preferredModel, 'groq:') ?? 'llama-3.3-70b-versatile';
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(30000), redirect: 'error',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: requestedModel,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
      });
      if (r.ok) {
        const data: any = await r.json();
        const text = data?.choices?.[0]?.message?.content || '';
        if (text) {
          return makeResult(text, 'groq', data?.model || requestedModel, attempts.length, start, {
            promptTokens: data?.usage?.prompt_tokens,
            completionTokens: data?.usage?.completion_tokens,
          });
        }
      }
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = `HTTP ${r.status}`;
    } catch (e: any) {
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = e?.message?.slice(0, 120) || 'groq failed';
    }
    return null;
  };

  const tryGeminiEnv = async (): Promise<ChainCallResult | null> => {
    if (!isExternalAiAllowed() || !(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_KEY)) return null;
    try {
      attempts.push({ provider: 'gemini', ok: true });
      const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_KEY || '';
      const model = extractPreferredModel(options.preferredModel, 'gemini:') ?? 'gemini-1.5-flash';
      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST', signal: AbortSignal.timeout(30000), redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens, temperature } }),
        }
      );
      if (r.ok) {
        const data: any = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
        if (text) {
          return makeResult(text, 'gemini', model, attempts.length, start, {
            promptTokens: data?.usageMetadata?.promptTokenCount,
            completionTokens: data?.usageMetadata?.candidatesTokenCount,
          });
        }
      }
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = `HTTP ${r.status}`;
    } catch (e: any) {
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = e?.message?.slice(0, 120) || 'gemini failed';
    }
    return null;
  };

  const tryOpenRouterEnv = async (): Promise<ChainCallResult | null> => {
    if (!isExternalAiAllowed() || !process.env.OPENROUTER_API_KEY) return null;
    try {
      attempts.push({ provider: 'openrouter-free', ok: true });
      const model = extractPreferredModel(options.preferredModel, 'openrouter:')
        ?? 'meta-llama/llama-3.3-70b-instruct:free';
      if (!model.endsWith(':free')) throw new Error('OpenRouter model must use a free variant');
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(30000), redirect: 'error',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://learn.alolabs.net',
          'X-Title': 'ALO Labs',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      });
      if (r.ok) {
        const data: any = await r.json();
        const text = data?.choices?.[0]?.message?.content || '';
        if (text) {
          return makeResult(text, 'openrouter-free', model, attempts.length, start, {
            promptTokens: data?.usage?.prompt_tokens,
            completionTokens: data?.usage?.completion_tokens,
          });
        }
      }
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = `HTTP ${r.status}`;
    } catch (e: any) {
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = e?.message?.slice(0, 120) || 'openrouter failed';
    }
    return null;
  };

  const envOrder: Array<{ id: string; aliases: string[]; run: () => Promise<ChainCallResult | null> }> = [
    { id: 'zai', aliases: ['zai'], run: tryZaiEnv },
    { id: 'groq', aliases: ['groq'], run: tryGroqEnv },
    { id: 'gemini', aliases: ['gemini'], run: tryGeminiEnv },
    { id: 'openrouter-free', aliases: ['openrouter-free', 'openrouter'], run: tryOpenRouterEnv },
  ];
  const preferred = resolvePreferredProvider(options);
  if (preferred) {
    envOrder.sort((a, b) => {
      const aMatch = a.aliases.includes(preferred) ? 0 : 1;
      const bMatch = b.aliases.includes(preferred) ? 0 : 1;
      return aMatch - bMatch;
    });
  }
  for (const step of envOrder) {
    const res = await step.run();
    if (res) return res;
  }

  // 5. Ollama again — the last real provider before the deterministic fallback,
  //    so a temporarily busy local model gets one more chance after the remotes.
  if (!localFirst) {
    const local = await tryOllama(messages, options, maxTokens, temperature);
    if (local) {
      attempts.push({ provider: 'ollama', ok: true });
      return makeResult(local.text, 'ollama', local.model, attempts.length, start, {
        promptTokens: local.promptTokens,
        completionTokens: local.completionTokens,
      });
    }
    attempts.push({ provider: 'ollama', ok: false, error: 'local model unavailable' });
  }

  // 6. Rule-based fallback — deterministic, never fails
  const fallbackText = ruleBasedFallback ? ruleBasedFallback(messages) : defaultRuleBasedFallback(messages);
  return makeResult(fallbackText, 'rule-based', 'rule-based', attempts.length, start, { fallback: true });
}

function makeResult(
  text: string,
  provider: ChainCallResult['provider'],
  model: string,
  attempts: number,
  start: number,
  extra: Partial<ChainCallResult> = {}
): ChainCallResult {
  return {
    text,
    provider,
    model,
    attempts,
    durationMs: Date.now() - start,
    fallback: provider === 'rule-based',
    promptTokens: extra.promptTokens,
    completionTokens: extra.completionTokens,
  };
}

/**
 * Default rule-based fallback when no LLM provider responds and the
 * caller didn't supply one. The agent always has something to say —
 * a deterministic acknowledgment + the next-step instruction.
 */
function defaultRuleBasedFallback(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser?.content || '';
  return [
    'আমি বর্তমানে একটি নির্ধারিত উত্তর দিচ্ছি (LLM unavailable — fallback active).',
    '',
    'ব্যবহারকারীর শেষ বার্তা:',
    userText.slice(0, 200),
    '',
    'পরবর্তী ধাপ: অনুগ্রহ করে সংযুক্ত করতে চাওয়া প্ল্যাটফর্মের নাম বা সংখ্যা লিখুন (1=Google, 2=YouTube, 3=Facebook/Instagram, 4=LinkedIn, 5=TikTok, 6=X, 7=Pinterest, 8=WordPress, 9=CRM/Email, 10=E-commerce, 11=Other).',
  ].join('\n');
}

/**
 * Lazy-load the Z.AI SDK. Returns null if the SDK is not configured
 * (e.g. /etc/.z-ai-config missing in dev). Only caches a live client;
 * transient initialization failures are never cached sticky.
 */
let _zaiClient: any | null = null;
let _zaiInFlight: Promise<any | null> | null = null;
function loadZai(): Promise<any | null> {
  if (!isExternalAiAllowed()) return Promise.resolve(null);
  if (_zaiClient) return Promise.resolve(_zaiClient);
  if (!_zaiInFlight) {
    _zaiInFlight = (async () => {
      try {
        const zai = await createApprovedZai();
        if (zai) _zaiClient = zai;
        return zai ?? null;
      } catch {
        // Most likely /etc/.z-ai-config missing — silent failover (non-sticky)
        return null;
      } finally {
        _zaiInFlight = null;
      }
    })();
  }
  return _zaiInFlight;
}

/**
 * Registry-driven provider path.
 *
 * Reads enabled providers + their default models from the AiModelProvider
 * table (priority ascending). For each provider, resolves the API key
 * (encrypted DB row OR env var named in apiKeyEnvName) and tries the
 * provider's chat-completion endpoint via SSRF-hardened `requestProviderJson`.
 */
async function tryRegistryProviders(
  messages: ChatMessage[],
  options: ChainCallOptions,
  maxTokens: number,
  temperature: number,
  start: number,
  attempts: Array<{ provider: ChainCallResult['provider']; ok: boolean; error?: string }>
): Promise<ChainCallResult | null> {
  let db: any;
  try {
    const mod = await import('./db');
    db = mod.db;
  } catch {
    return null; // DB not available — skip registry path
  }

  let providers: any[];
  try {
    providers = await db.aiModelProvider.findMany({
      where: { isEnabled: true },
      include: { models: { where: { isEnabled: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] } },
      orderBy: [{ priority: 'asc' }, { label: 'asc' }],
    });
  } catch {
    return null; // Table not migrated yet or DB error — skip silently
  }

  if (!providers || providers.length === 0) return null;

  const preferred = resolvePreferredProvider(options);
  if (preferred) {
    const aliases = new Set(preferred === 'openrouter-free' ? ['openrouter-free', 'openrouter'] : [preferred]);
    providers = [...providers].sort((a, b) => {
      const aMatch = aliases.has(a.slug) ? 0 : 1;
      const bMatch = aliases.has(b.slug) ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  for (const provider of providers) {
    if (!isExternalAiAllowed()) {
      if (provider.slug !== 'ollama') continue;
      try {
        const localEndpoint = getPrivateLocalBaseUrl('OLLAMA_BASE_URL', 'http://localhost:11434').href.replace(/\/$/, '');
        if (provider.baseUrl?.replace(/\/$/, '') !== localEndpoint) continue;
      } catch { continue; }
    }
    const defaultModel = provider.models[0];
    if (!defaultModel) continue;

    // Resolve API key
    let apiKey: string | null = null;
    if (provider.secretCipher) {
      try {
        const { decryptSecret } = await import('./vault');
        apiKey = decryptSecret(provider.secretCipher);
      } catch {
        continue; // bad key — skip
      }
    } else if (provider.apiKeyEnvName) {
      apiKey = process.env[provider.apiKeyEnvName] || null;
    }
    if (!apiKey && !provider.apiKeyOptional) continue; // unconfigured — skip

    const providerSlug = provider.slug as ChainCallResult['provider'];
    try {
      attempts.push({ provider: providerSlug, ok: true });
      const text = await callRegistryProvider(provider, defaultModel, messages, maxTokens, temperature, apiKey);
      if (text) {
        return makeResult(text, providerSlug, defaultModel.modelId, attempts.length, start);
      }
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = 'empty response';
    } catch (e: any) {
      attempts[attempts.length - 1].ok = false;
      attempts[attempts.length - 1].error = e?.message?.slice(0, 120) || `${provider.slug} failed`;
    }
  }
  return null;
}

function isConfiguredLocalOllamaUrl(rawBaseUrl: string): boolean {
  try {
    const localEndpoint = getPrivateLocalBaseUrl('OLLAMA_BASE_URL', 'http://localhost:11434').href.replace(/\/$/, '');
    return rawBaseUrl.replace(/\/+$/, '') === localEndpoint;
  } catch {
    return false;
  }
}

/**
 * Calls one registry-configured provider using SSRF-hardened `requestProviderJson`.
 */
async function callRegistryProvider(
  provider: any,
  model: any,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  apiKey: string | null
): Promise<string> {
  const slug = provider.slug as string;
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const baseUrl = String(provider.baseUrl || '')
    .replace('{account_id}', encodeURIComponent(accountId))
    .replace(/\/+$/, '');
  const modelId = String(model.modelId || '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Z.AI uses the SDK, not raw HTTP
  if (slug === 'zai') {
    const zai = await loadZai();
    if (!zai) throw new Error('zai sdk not loaded');
    const r: any = await zai.chat.completions.create({ messages, max_tokens: maxTokens, temperature });
    return r?.choices?.[0]?.message?.content || '';
  }

  if (slug === 'pollinations') {
    return '';
  }

  if (slug === 'gemini') {
    const geminiHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) geminiHeaders['x-goog-api-key'] = apiKey;
    const { status, data } = await requestProviderJson(
      `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`,
      {
        method: 'POST',
        headers: geminiHeaders,
        body: JSON.stringify({
          contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: maxTokens, temperature },
        }),
        timeoutMs: 30_000,
      }
    );
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const payload: any = data;
    return payload?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  }

  if (slug === 'ollama' || slug === 'opencode') {
    const allowLocal = slug === 'ollama' && isConfiguredLocalOllamaUrl(baseUrl);
    const { status, data } = await requestProviderJson(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages, stream: false, options: { num_predict: maxTokens, temperature } }),
      timeoutMs: 30_000,
      allowLocalOllama: allowLocal,
    });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const payload: any = data;
    return payload?.message?.content || '';
  }

  if (slug === 'cloudflare') {
    const { status, data } = await requestProviderJson(`${baseUrl}/models/${modelId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: messages.map((m) => m.content).join('\n') }),
      timeoutMs: 30_000,
    });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const payload: any = data;
    return payload?.result?.response || payload?.result || '';
  }

  if (slug === 'huggingface') {
    const { status, data } = await requestProviderJson(`${baseUrl}/${modelId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ inputs: messages.map((m) => m.content).join('\n') }),
      timeoutMs: 30_000,
    });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const payload: any = data;
    return Array.isArray(payload) ? payload[0]?.generated_text || '' : payload?.generated_text || '';
  }

  // Default: OpenAI-compatible /v1/chat/completions (groq, openrouter, mistral, opencode-compatible)
  if (provider.openAiCompatible) {
    const { status, data } = await requestProviderJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, messages, max_tokens: maxTokens, temperature }),
      timeoutMs: 30_000,
    });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const payload: any = data;
    return payload?.choices?.[0]?.message?.content || '';
  }

  return '';
}
