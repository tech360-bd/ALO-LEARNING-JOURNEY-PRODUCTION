// ALO Learning Journey — Super Admin rate limiting (server-only).
//
// In-memory sliding-window limiter scoped to the owner (single-owner
// deployment). Bounds abuse of the command center and protects free-tier
// provider quotas. Kept deliberately small and dependency-free; it resets on
// process restart, which is acceptable for an owner-only surface (the
// durable guard is the approval workflow, not the limiter).

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

export function checkLimit(key: string, max: number, windowMs = WINDOW_MS): LimitResult {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { hits: [] };
    buckets.set(key, b);
  }
  // Prune old hits.
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= max) {
    const oldest = b.hits[0];
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, oldest + windowMs - now) };
  }
  b.hits.push(now);
  return { allowed: true, remaining: max - b.hits.length, retryAfterMs: 0 };
}

/** Test hook. */
export function _resetLimits(): void {
  buckets.clear();
}
