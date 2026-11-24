import { createHash, randomUUID } from 'node:crypto';

export const SOCIAL_PUBLISH_LEASE_MS = 60_000;
export const SOCIAL_PUBLISH_MAX_RETRIES = 3;

export interface ClaimableContent {
  id: string;
  status: string;
  engagement: string | null;
  publishClaimToken: string | null;
  publishLeaseUntil: Date | null;
}

export interface ContentClaimDelegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface PublishClaim {
  contentId: string;
  expectedStatus: string;
  token: string;
  leaseUntil: Date;
  attemptNumber: number;
  attemptKey: string;
  claimedEngagement: string;
  sendingEngagement?: string;
}

export type ClaimResult =
  | { kind: 'claimed'; claim: PublishClaim }
  | { kind: 'busy' | 'unknown' | 'stale' };

export function parsePublishMetadata(value: string | null | undefined): Record<string, any> {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serialize(value: Record<string, any>): string {
  return JSON.stringify(value);
}

function attemptKey(contentId: string, attemptNumber: number): string {
  // Local durable correlation only. The current Postiz adapter/docs do not
  // establish provider idempotency-key support, so this is not sent upstream.
  return createHash('sha256').update(`alo-postiz:${contentId}:${attemptNumber}`).digest('hex');
}

/**
 * Claim with one conditional MySQL UPDATE. Concurrent workers may read the same
 * candidate, but only one update can match the old lease and engagement value.
 */
export async function claimContentForPublish(
  db: { content: ContentClaimDelegate },
  content: ClaimableContent,
  now = new Date(),
  leaseMs = SOCIAL_PUBLISH_LEASE_MS,
  allowedStatuses: string[] = ['scheduled'],
): Promise<ClaimResult> {
  if (!allowedStatuses.includes(content.status)) return { kind: 'stale' };
  const metadata = parsePublishMetadata(content.engagement);
  if (metadata.publishingState === 'unknown') return { kind: 'unknown' };

  const leaseExpired = content.publishClaimToken !== null &&
    (content.publishLeaseUntil === null || content.publishLeaseUntil <= now);
  if (content.publishClaimToken && !leaseExpired) return { kind: 'busy' };

  // An expired request that reached the provider is ambiguous. Clear its lease
  // and persist unknown; never silently send it again. Only an expired pre-send
  // claim may be safely recovered by another worker.
  if (content.publishClaimToken && leaseExpired && metadata.publishingState === 'sending') {
    const unknown = serialize({
      ...metadata,
      publishingState: 'unknown',
      unknownReason: 'lease_expired_after_request_started',
      unknownAt: now.toISOString(),
    });
    const result = await db.content.updateMany({
      where: {
        id: content.id,
        status: content.status,
        publishClaimToken: content.publishClaimToken,
        OR: [{ publishLeaseUntil: { lte: now } }, { publishLeaseUntil: null }],
        engagement: content.engagement ?? '{}',
      },
      data: { publishClaimToken: null, publishLeaseUntil: null, engagement: unknown },
    });
    return { kind: result.count === 1 ? 'unknown' : 'stale' };
  }

  const previousAttempts = Number.isSafeInteger(metadata.publishAttemptCount)
    ? Math.max(0, metadata.publishAttemptCount)
    : 0;
  const attemptNumber = previousAttempts + 1;
  const token = randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const claimedMetadata = {
    ...metadata,
    publishingState: 'claimed',
    publishAttemptCount: attemptNumber,
    publishAttemptKey: attemptKey(content.id, attemptNumber),
    publishClaimedAt: now.toISOString(),
  };
  const claimedEngagement = serialize(claimedMetadata);

  const where: Record<string, unknown> = {
    id: content.id,
    status: content.status,
    engagement: content.engagement ?? '{}',
  };
  if (content.publishClaimToken) {
    where.publishClaimToken = content.publishClaimToken;
    where.OR = [{ publishLeaseUntil: { lte: now } }, { publishLeaseUntil: null }];
  } else {
    where.publishClaimToken = null;
  }

  const result = await db.content.updateMany({
    where,
    data: { publishClaimToken: token, publishLeaseUntil: leaseUntil, engagement: claimedEngagement },
  });
  if (result.count !== 1) return { kind: 'stale' };

  return {
    kind: 'claimed',
    claim: {
      contentId: content.id,
      expectedStatus: content.status,
      token,
      leaseUntil,
      attemptNumber,
      attemptKey: claimedMetadata.publishAttemptKey,
      claimedEngagement,
    },
  };
}

export function claimScheduledContent(
  db: { content: ContentClaimDelegate },
  content: ClaimableContent,
  now = new Date(),
  leaseMs = SOCIAL_PUBLISH_LEASE_MS,
): Promise<ClaimResult> {
  return claimContentForPublish(db, content, now, leaseMs, ['scheduled']);
}

/** Move claimed -> sending with a token + non-expired lease CAS. */
export async function markClaimSending(
  db: { content: ContentClaimDelegate },
  claim: PublishClaim,
  now = new Date(),
): Promise<PublishClaim | null> {
  const metadata = parsePublishMetadata(claim.claimedEngagement);
  const sendingEngagement = serialize({ ...metadata, publishingState: 'sending', publishRequestStartedAt: now.toISOString() });
  const result = await db.content.updateMany({
    where: {
      id: claim.contentId,
      status: claim.expectedStatus,
      publishClaimToken: claim.token,
      publishLeaseUntil: { gt: now },
      engagement: claim.claimedEngagement,
    },
    data: { engagement: sendingEngagement },
  });
  return result.count === 1 ? { ...claim, sendingEngagement } : null;
}

/** Final state changes require the same token, an unexpired lease, and exact attempt state. */
export async function finalizeClaim(
  db: { content: ContentClaimDelegate },
  claim: PublishClaim,
  expectedEngagement: string,
  data: Record<string, unknown>,
  now = new Date(),
): Promise<boolean> {
  const result = await db.content.updateMany({
    where: {
      id: claim.contentId,
      status: claim.expectedStatus,
      publishClaimToken: claim.token,
      publishLeaseUntil: { gt: now },
      engagement: expectedEngagement,
    },
    data: { ...data, publishClaimToken: null, publishLeaseUntil: null },
  });
  return result.count === 1;
}
