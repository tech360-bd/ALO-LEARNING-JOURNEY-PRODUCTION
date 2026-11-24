/**
 * GET /api/cron/social-publish
 *
 * MySQL conditional updates lease each due row before provider calls. A worker
 * may finalize only while its exact claim token and unexpired lease still own
 * the row. Provider idempotency/reconciliation is not assumed; ambiguous results
 * become a durable `unknown` state and are never automatically re-sent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { publishPost, isPostizConfigured } from '@/lib/postiz-adapter';
import {
  claimScheduledContent,
  finalizeClaim,
  markClaimSending,
  parsePublishMetadata,
  SOCIAL_PUBLISH_MAX_RETRIES,
} from '@/lib/social-publish-claims';
import { emitEvent } from '@/lib/events';

export const dynamic = 'force-dynamic';

const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube'];

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization') || '';
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET env var not set — refusing to run' }, { status: 503 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isPostizConfigured()) {
    return NextResponse.json({ ok: true, simulated: true, processed: 0, message: 'Postiz not configured — no posts were sent.' });
  }

  const now = new Date();
  const candidates = await db.content.findMany({
    where: { status: 'scheduled', scheduledAt: { lte: now }, platform: { in: PLATFORMS } },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    take: 20,
  });

  let published = 0;
  let failed = 0;
  let retried = 0;
  let unknown = 0;
  let busy = 0;
  const errors: Array<{ contentId: string; error: string }> = [];

  for (const content of candidates) {
    const metadata = parsePublishMetadata(content.engagement);
    if (metadata.postizPostId || metadata.publishingState === 'published') continue;
    if (metadata.publishingState === 'unknown') { unknown++; continue; }

    if (Number(metadata.retryCount || 0) >= SOCIAL_PUBLISH_MAX_RETRIES && !content.publishClaimToken) {
      const marked = await db.content.updateMany({
        where: { id: content.id, status: 'scheduled', publishClaimToken: null, engagement: content.engagement ?? '{}' },
        data: { status: 'failed', engagement: JSON.stringify({ ...metadata, publishingState: 'failed' }) },
      });
      if (marked.count === 1) failed++;
      continue;
    }

    const claimed = await claimScheduledContent(db, content, now);
    if (claimed.kind === 'unknown') { unknown++; continue; }
    if (claimed.kind !== 'claimed') { busy++; continue; }

    const sending = await markClaimSending(db, claimed.claim, new Date());
    if (!sending?.sendingEngagement) { busy++; continue; }

    const result = await publishPost({
      contentId: content.id,
      text: content.body || content.title,
      platforms: [content.platform] as any,
      mediaUrls: content.mediaUrl ? [content.mediaUrl] : [],
      attemptKey: claimed.claim.attemptKey,
    });

    const sendingMetadata = parsePublishMetadata(sending.sendingEngagement);
    const finishedAt = new Date();

    if (result.outcome === 'accepted' && result.postizPostId) {
      const publishedMetadata: Record<string, any> = {
        ...sendingMetadata,
        publishingState: 'published',
        postizPostId: result.postizPostId,
        platformPostIds: result.platformPostIds || [],
        publishedAt: finishedAt.toISOString(),
        publishedVia: 'postiz',
      };
      delete publishedMetadata.lastError;
      delete publishedMetadata.retryCount;
      const saved = await finalizeClaim(db, sending, sending.sendingEngagement, {
        status: 'published', publishedAt: finishedAt, engagement: JSON.stringify(publishedMetadata),
      }, finishedAt);
      if (!saved) { busy++; continue; }

      await emitEvent({
        type: 'social.post_published', companyId: content.companyId, resource: 'content', resourceId: content.id,
        metadata: {
          postizPostId: result.postizPostId, platformPostIds: result.platformPostIds,
          platform: content.platform, scheduledAt: content.scheduledAt?.toISOString(), publishedAt: finishedAt.toISOString(),
        },
      });
      published++;
      continue;
    }

    if (result.outcome === 'rejected') {
      const retryCount = Number(sendingMetadata.retryCount || 0) + 1;
      const nextState = retryCount >= SOCIAL_PUBLISH_MAX_RETRIES ? 'failed' : 'retryable';
      const retryMetadata = {
        ...sendingMetadata, publishingState: nextState, retryCount,
        lastError: result.error?.slice(0, 200) || 'provider_rejected', lastRetryAt: finishedAt.toISOString(),
      };
      const saved = await finalizeClaim(db, sending, sending.sendingEngagement, {
        ...(nextState === 'failed' ? { status: 'failed' } : {}),
        engagement: JSON.stringify(retryMetadata),
      }, finishedAt);
      if (saved) {
        if (nextState === 'failed') failed++;
        else retried++;
      } else busy++;
      if (result.error) errors.push({ contentId: content.id, error: result.error });
      continue;
    }

    // Timeouts, redirects, 5xx, malformed success, and connection loss are
    // uncertain. Persist this state and stop automated retries to avoid dupes.
    const unknownMetadata = {
      ...sendingMetadata, publishingState: 'unknown',
      unknownReason: result.error?.slice(0, 200) || 'provider_outcome_not_confirmed',
      unknownAt: finishedAt.toISOString(),
    };
    const saved = await finalizeClaim(db, sending, sending.sendingEngagement, {
      engagement: JSON.stringify(unknownMetadata),
    }, finishedAt);
    if (saved) unknown++;
    else busy++;
    if (result.error) errors.push({ contentId: content.id, error: result.error });
  }

  return NextResponse.json({
    ok: true, processed: candidates.length, published, failed, retried, unknown, busy,
    errors: errors.slice(0, 5), timestamp: now.toISOString(),
  });
}
