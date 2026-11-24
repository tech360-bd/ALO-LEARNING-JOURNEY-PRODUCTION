import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { emitEvent } from '@/lib/events';
import { feedImportContentId, importFeedItemTransaction } from '@/lib/feed-import';

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

// POST /api/feeds/import — convert a feed item into a Content row.
export async function POST(req: NextRequest) {
  let companyId = '';
  let userId = '';
  let itemId = '';
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload || !payload.companyId) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    companyId = payload.companyId;
    userId = payload.userId;

    const body = await req.json().catch(() => null);
    itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    if (!itemId) return NextResponse.json({ error: 'itemId is required' }, { status: 400 });

    const result = await importFeedItemTransaction(db, { itemId, companyId, userId });
    if (result.kind === 'missing') return NextResponse.json({ error: 'Feed item not found' }, { status: 404 });
    if (result.kind === 'existing') {
      return NextResponse.json({ error: 'Already imported as content', duplicate: true, data: { contentId: result.content.id } }, { status: 409 });
    }

    await emitEvent({
      companyId,
      userId,
      type: 'content.imported_from_feed',
      title: 'Feed item imported as content',
      description: `"${result.item.title}" imported from ${result.item.source.name}`,
      resourceType: 'content',
      resourceId: result.content.id,
      link: '/content',
      metadata: { feedItemId: result.item.id, sourceName: result.item.source.name },
    });

    return NextResponse.json({ data: { contentId: result.content.id, title: result.content.title, status: result.content.status } }, { status: 201 });
  } catch (error) {
    // MySQL's Content primary key is the stable feed-item import constraint.
    // The winner has committed before the conflicting insert returns P2002.
    if (isUniqueConstraintError(error) && companyId && itemId) {
      try {
        const content = await db.content.findUnique({ where: { id: feedImportContentId(itemId) } });
        const item = await db.feedItem.findFirst({ where: { id: itemId, companyId } });
        if (content && item) {
          // Repair/complete the marker after a prior winning import; do not leave
          // the item unstarred if a concurrent request encountered the key.
          await db.feedItem.update({ where: { id: item.id }, data: { isStarred: true, isRead: true } });
          return NextResponse.json({ error: 'Already imported as content', duplicate: true, data: { contentId: content.id } }, { status: 409 });
        }
      } catch { /* keep the generic response; never return raw DB error details */ }
    }
    console.error('[POST /api/feeds/import] failed');
    return NextResponse.json({ error: 'Failed to import feed item' }, { status: 500 });
  }
}
