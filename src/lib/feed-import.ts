import { createHash } from 'node:crypto';

export function feedImportContentId(itemId: string): string {
  return `feed_${createHash('sha256').update(itemId).digest('hex')}`;
}

/** Transactional create + read/star update. Duplicate primary keys are surfaced for the route to reconcile. */
export async function importFeedItemTransaction(
  database: any,
  input: { itemId: string; companyId: string; userId: string },
): Promise<any> {
  return database.$transaction(async (tx: any) => {
    const item = await tx.feedItem.findFirst({
      where: { id: input.itemId, companyId: input.companyId }, include: { source: true },
    });
    if (!item) return { kind: 'missing' };

    const contentId = feedImportContentId(item.id);
    const imported = await tx.content.findUnique({ where: { id: contentId } });
    if (imported) {
      await tx.feedItem.update({ where: { id: item.id }, data: { isStarred: true, isRead: true } });
      return { kind: 'existing', content: imported };
    }

    // Preserve compatibility with content imported before deterministic IDs.
    const legacy = await tx.content.findFirst({ where: { companyId: input.companyId, mediaUrl: item.link } });
    if (legacy) {
      await tx.feedItem.update({ where: { id: item.id }, data: { isStarred: true, isRead: true } });
      return { kind: 'existing', content: legacy };
    }

    const content = await tx.content.create({
      data: {
        id: contentId,
        title: item.title,
        type: 'blog',
        status: 'draft',
        platform: null,
        body: item.description
          ? `${item.description}\n\nSource: ${item.source.name}\nOriginal: ${item.link}${item.author ? `\nAuthor: ${item.author}` : ''}`
          : `Imported from ${item.source.name}: ${item.link}`,
        mediaUrl: item.link,
        mediaType: 'external',
        thumbnailUrl: null,
        hashtags: '#curated',
        engagement: '{}',
        creatorId: input.userId,
        companyId: input.companyId,
      },
    });
    await tx.feedItem.update({ where: { id: item.id }, data: { isStarred: true, isRead: true } });
    return { kind: 'created', content, item };
  });
}
