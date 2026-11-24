/** Manual and scheduled post dispatch share the same atomic content lease. */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getSessionContext, unauthorized, badRequest, notFound, ok } from '@/lib/v1-middleware';
import { isPostizConfigured, publishPost } from '@/lib/postiz-adapter';
import { emitEvent } from '@/lib/events';
import { claimContentForPublish, finalizeClaim, markClaimSending, parsePublishMetadata } from '@/lib/social-publish-claims';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ctx = await getSessionContext(request);
  if (!('authenticated' in ctx && ctx.authenticated)) return unauthorized();

  const body = await request.json().catch(() => null);
  if (!body || !body.contentId) return badRequest('contentId is required');
  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return badRequest('platforms array is required (e.g. ["facebook", "instagram"])');
  }

  const content = await db.content.findFirst({ where: { id: body.contentId, companyId: ctx.companyId } });
  if (!content) return notFound('content not found');

  if (!isPostizConfigured()) {
    const simulated = await publishPost({ contentId: content.id, text: content.body || content.title, platforms: body.platforms });
    await db.content.update({
      where: { id: content.id },
      data: { status: 'scheduled', scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : new Date() },
    });
    return ok({ contentId: content.id, status: 'scheduled', simulated: true, warning: simulated.error });
  }

  const claimed = await claimContentForPublish(db, content, new Date(), undefined, ['draft', 'scheduled']);
  if (claimed.kind === 'unknown') {
    return Response.json({ ok: false, error: 'publish_outcome_unknown', contentId: content.id, retryAllowed: false }, { status: 202 });
  }
  if (claimed.kind !== 'claimed') {
    return Response.json({ ok: false, error: 'content_publish_busy', contentId: content.id }, { status: 409 });
  }
  const sending = await markClaimSending(db, claimed.claim);
  if (!sending?.sendingEngagement) return Response.json({ ok: false, error: 'content_publish_busy', contentId: content.id }, { status: 409 });

  const result = await publishPost({
    contentId: content.id,
    text: content.body || content.title,
    platforms: body.platforms,
    scheduledAt: body.scheduledAt,
    mediaUrls: body.mediaUrls || [],
    attemptKey: claimed.claim.attemptKey,
  });
  const previous = parsePublishMetadata(sending.sendingEngagement);
  const finishedAt = new Date();

  if (result.outcome === 'accepted' && result.postizPostId) {
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
    const isImmediate = !scheduledAt || scheduledAt.getTime() <= Date.now() + 60_000;
    const evidence: Record<string, any> = {
      ...previous, publishingState: 'published', postizPostId: result.postizPostId,
      platformPostIds: result.platformPostIds || [], publishedVia: 'postiz', publishedAt: finishedAt.toISOString(),
    };
    delete evidence.retryCount;
    delete evidence.lastError;
    const saved = await finalizeClaim(db, sending, sending.sendingEngagement, {
      status: isImmediate ? 'published' : 'scheduled', scheduledAt,
      publishedAt: isImmediate ? finishedAt : null, engagement: JSON.stringify(evidence),
    }, finishedAt);
    if (!saved) return Response.json({ ok: false, error: 'publish_lease_expired', contentId: content.id, retryAllowed: false }, { status: 202 });

    await emitEvent({
      type: 'social.post_published', companyId: ctx.companyId, userId: ctx.userId,
      resource: 'content', resourceId: content.id,
      metadata: { platforms: body.platforms, postizPostId: result.postizPostId, platformPostIds: result.platformPostIds, simulated: false },
    });
    return ok({
      contentId: content.id, status: isImmediate ? 'published' : 'scheduled', simulated: false,
      postizPostId: result.postizPostId, platformPostIds: result.platformPostIds,
      publishedAt: isImmediate ? finishedAt.toISOString() : null, scheduledAt: scheduledAt?.toISOString() || null,
    });
  }

  if (result.outcome === 'rejected') {
    const retryCount = Number(previous.retryCount || 0) + 1;
    const saved = await finalizeClaim(db, sending, sending.sendingEngagement, {
      engagement: JSON.stringify({ ...previous, publishingState: 'retryable', retryCount, lastError: result.error?.slice(0, 200) }),
    }, finishedAt);
    if (!saved) return Response.json({ ok: false, error: 'publish_lease_expired', contentId: content.id }, { status: 409 });
    return Response.json({ ok: false, error: 'publish_failed', httpStatus: result.httpStatus }, { status: 502 });
  }

  const saved = await finalizeClaim(db, sending, sending.sendingEngagement, {
    engagement: JSON.stringify({
      ...previous, publishingState: 'unknown',
      unknownReason: result.error?.slice(0, 200) || 'provider_outcome_not_confirmed', unknownAt: finishedAt.toISOString(),
    }),
  }, finishedAt);
  return Response.json({ ok: false, error: 'publish_outcome_unknown', contentId: content.id, retryAllowed: false, saved }, { status: 202 });
}
