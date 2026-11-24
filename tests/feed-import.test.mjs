import test from 'node:test';
import assert from 'node:assert/strict';
import { feedImportContentId, importFeedItemTransaction } from '../src/lib/feed-import.ts';

function memoryDatabase({ failFeedUpdate = false } = {}) {
  let shouldFailFeedUpdate = failFeedUpdate;
  const item = { id: 'feed-item-1', companyId: 'company-1', title: 'A story', link: 'https://news.example.test/a', description: 'Summary', author: null, source: { name: 'News' }, isRead: false, isStarred: false };
  const contents = new Map();
  return {
    item, contents,
    setFailFeedUpdate(value) { shouldFailFeedUpdate = value; },
    async $transaction(callback) {
      const workingItem = structuredClone(item);
      const workingContents = new Map(contents);
      const tx = {
        feedItem: {
          findFirst: async () => workingItem,
          update: async ({ data }) => {
            if (shouldFailFeedUpdate) throw new Error('injected update failure');
            Object.assign(workingItem, data);
            return workingItem;
          },
        },
        content: {
          findUnique: async ({ where }) => workingContents.get(where.id) || null,
          findFirst: async ({ where }) => [...workingContents.values()].find((row) => row.companyId === where.companyId && row.mediaUrl === where.mediaUrl) || null,
          create: async ({ data }) => {
            if (workingContents.has(data.id)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
            const created = { ...data };
            workingContents.set(created.id, created);
            return created;
          },
        },
      };
      const result = await callback(tx);
      Object.assign(item, workingItem);
      contents.clear();
      for (const [id, content] of workingContents) contents.set(id, content);
      return result;
    },
  };
}

test('first feed import creates deterministic content and updates read/star state atomically; repeat is idempotent', async () => {
  const db = memoryDatabase();
  const first = await importFeedItemTransaction(db, { itemId: db.item.id, companyId: db.item.companyId, userId: 'user-1' });
  assert.equal(first.kind, 'created');
  assert.equal(first.content.id, feedImportContentId(db.item.id));
  assert.equal(db.contents.size, 1);
  assert.equal(db.item.isRead, true);
  assert.equal(db.item.isStarred, true);

  const repeated = await importFeedItemTransaction(db, { itemId: db.item.id, companyId: db.item.companyId, userId: 'user-1' });
  assert.equal(repeated.kind, 'existing');
  assert.equal(db.contents.size, 1);
  assert.equal(db.item.isStarred, true);
});

test('feed update failure rolls back content creation and a retry completes the import', async () => {
  const db = memoryDatabase({ failFeedUpdate: true });
  await assert.rejects(importFeedItemTransaction(db, { itemId: db.item.id, companyId: db.item.companyId, userId: 'user-1' }), /injected update failure/);
  assert.equal(db.contents.size, 0, 'transaction did not commit orphan content');
  assert.equal(db.item.isStarred, false);
  assert.equal(db.item.isRead, false);

  db.setFailFeedUpdate(false);
  const result = await importFeedItemTransaction(db, { itemId: db.item.id, companyId: db.item.companyId, userId: 'user-1' });
  assert.equal(result.kind, 'created');
  assert.equal(db.contents.size, 1);
  assert.equal(db.item.isStarred, true);
});

test('existing legacy duplicate is reused and feed marker is completed', async () => {
  const db = memoryDatabase();
  db.contents.set('legacy-content', { id: 'legacy-content', companyId: db.item.companyId, mediaUrl: db.item.link });
  const result = await importFeedItemTransaction(db, { itemId: db.item.id, companyId: db.item.companyId, userId: 'user-1' });
  assert.equal(result.kind, 'existing');
  assert.equal(result.content.id, 'legacy-content');
  assert.equal(db.item.isRead, true);
  assert.equal(db.item.isStarred, true);
  assert.equal(db.contents.size, 1);
});
