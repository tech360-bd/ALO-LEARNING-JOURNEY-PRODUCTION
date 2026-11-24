/**
 * Postiz Adapter — social media publishing via Postiz (self-hosted or Postiz Cloud).
 *
 * The repository only establishes POST /api/posts and list retrieval. It does
 * not establish Postiz support for idempotency headers or a reliable lookup by
 * caller-supplied attempt key. Do not assume either: timeout/5xx/malformed
 * success responses are reported as `unknown` and must not be blindly retried.
 */
export interface PublishPostInput {
  contentId: string;
  text: string;
  platforms: Array<'facebook' | 'instagram' | 'linkedin' | 'x' | 'tiktok' | 'youtube'>;
  scheduledAt?: string;
  mediaUrls?: string[];
  /** Durable local correlation key; not sent to Postiz absent verified support. */
  attemptKey?: string;
}

export type PublishOutcome = 'accepted' | 'rejected' | 'unknown' | 'simulated';

export interface PublishPostResult {
  outcome: PublishOutcome;
  simulated: boolean;
  postizPostId?: string;
  platformPostIds?: Array<{ platform: string; id: string | null; status: string }>;
  httpStatus: number;
  error?: string;
  providerName: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function isPostizConfigured(): boolean {
  return !!(process.env.POSTIZ_BASE_URL && process.env.POSTIZ_API_KEY && process.env.POSTIZ_WORKSPACE_ID);
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Postiz response exceeded 64 KiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

function unknown(httpStatus: number, error: string): PublishPostResult {
  return { outcome: 'unknown', simulated: false, httpStatus, providerName: 'postiz', error: error.slice(0, 200) };
}

export async function publishPost(input: PublishPostInput): Promise<PublishPostResult> {
  if (!isPostizConfigured()) {
    return {
      outcome: 'simulated', simulated: true, httpStatus: 0, providerName: 'simulation',
      error: 'Postiz is not configured. Set POSTIZ_BASE_URL + POSTIZ_API_KEY + POSTIZ_WORKSPACE_ID in .env to enable real publishing.',
    };
  }

  const baseUrl = process.env.POSTIZ_BASE_URL!.replace(/\/$/, '');
  const apiKey = process.env.POSTIZ_API_KEY!;
  const workspaceId = process.env.POSTIZ_WORKSPACE_ID!;

  try {
    const res = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Postiz-Workspace': workspaceId,
      },
      body: JSON.stringify({
        content: input.text,
        platforms: input.platforms,
        scheduleAt: input.scheduledAt || null,
        mediaUrls: input.mediaUrls || [],
      }),
    });

    if (!res.ok) {
      const status = res.status;
      await res.body?.cancel().catch(() => undefined);
      const detail = `Postiz returned HTTP ${status}`;
      // A 4xx response is an explicit rejection. Redirects, 5xx, and other
      // non-2xx outcomes may follow partial acceptance; never auto-retry them.
      if (status >= 400 && status < 500) {
        return { outcome: 'rejected', simulated: false, httpStatus: status, providerName: 'postiz', error: detail };
      }
      return unknown(status, detail);
    }

    let data: unknown;
    try {
      const body = await readLimitedBody(res);
      data = JSON.parse(body);
    } catch {
      return unknown(res.status, 'Postiz returned an empty, oversized, or invalid JSON success response');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return unknown(res.status, 'Postiz success response was not an object');
    }

    const response = data as Record<string, unknown>;
    const rawId = response.id ?? response.postId;
    if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 512) {
      return unknown(res.status, 'Postiz success response did not contain a valid post ID');
    }
    const rawResults = response.platformResults;
    if (rawResults !== undefined && (!Array.isArray(rawResults) || rawResults.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)))) {
      return unknown(res.status, 'Postiz success response contained invalid platform results');
    }

    return {
      outcome: 'accepted', simulated: false, httpStatus: res.status, providerName: 'postiz', postizPostId: rawId.trim(),
      platformPostIds: (rawResults as Array<Record<string, unknown>> | undefined)?.map((entry) => ({
        platform: typeof entry.platform === 'string' ? entry.platform : 'unknown',
        id: typeof (entry.postId ?? entry.id) === 'string' ? String(entry.postId ?? entry.id) : null,
        status: typeof entry.status === 'string' ? entry.status : 'pending',
      })) ?? [],
    };
  } catch (error) {
    // Fetch errors, including timeout/connection loss, are ambiguous: Postiz may
    // have accepted the request before the response was lost.
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Postiz request timed out; acceptance is unknown'
      : 'Postiz request failed; acceptance is unknown';
    return unknown(0, message);
  }
}

/** List posts for display/sync. No caller-key lookup contract is assumed. */
export async function listPostizPosts(limit = 50): Promise<{
  simulated: boolean;
  posts?: Array<{ id: string; platforms: string[]; status: string; scheduledAt?: string; publishedAt?: string }>;
  error?: string;
}> {
  if (!isPostizConfigured()) return { simulated: true };
  const baseUrl = process.env.POSTIZ_BASE_URL!.replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/api/posts?limit=${limit}`, {
      redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${process.env.POSTIZ_API_KEY}` },
    });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return { simulated: false, error: `HTTP ${res.status}` }; }
    const data: any = await res.json();
    return {
      simulated: false,
      posts: (data.posts || data || []).map((p: any) => ({
        id: p.id, platforms: p.platforms || [], status: p.status || 'unknown',
        scheduledAt: p.scheduleAt || p.scheduledAt, publishedAt: p.publishedAt,
      })),
    };
  } catch {
    return { simulated: false, error: 'Postiz list request failed' };
  }
}
