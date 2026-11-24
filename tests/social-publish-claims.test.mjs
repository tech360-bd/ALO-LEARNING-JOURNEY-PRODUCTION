import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimScheduledContent,
  finalizeClaim,
  markClaimSending,
  parsePublishMetadata,
} from '../src/lib/social-publish-claims.ts';

function fixture() {
  const row = {
    id: 'content-1', status: 'scheduled', engagement: '{}',
    publishClaimToken: null, publishLeaseUntil: null,
  };
  const db = { content: { updateMany: async ({ where, data }) => {
    const matches = (condition) => {
      if (condition.OR) return condition.OR.some(matches);
      for (const [key, expected] of Object.entries(condition)) {
        if (key === 'OR') continue;
        const actual = row[key];
        if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
          if ('lte' in expected && !(actual instanceof Date && actual <= expected.lte)) return false;
          if ('lt' in expected && !(actual instanceof Date && actual < expected.lt)) return false;
          if ('gt' in expected && !(actual instanceof Date && actual > expected.gt)) return false;
        } else if (actual instanceof Date && expected instanceof Date) {
          if (actual.getTime() !== expected.getTime()) return false;
        } else if (actual !== expected) return false;
      }
      return true;
    };
    if (!matches(where)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  } } };
  return { db, row };
}

test('two workers race with atomic compare-and-swap; only one obtains the due-row lease', async () => {
  const { db, row } = fixture();
  const now = new Date('2026-11-24T12:00:00Z');
  const candidate = { ...row };
  const results = await Promise.all([
    claimScheduledContent(db, { ...candidate }, now),
    claimScheduledContent(db, { ...candidate }, now),
  ]);
  assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
  assert.equal(results.filter((result) => result.kind === 'stale').length, 1);
  assert.ok(row.publishClaimToken);
  assert.ok(row.publishLeaseUntil > now);
});

test('expired pre-send lease is replaced, and stale worker cannot transition or finalize', async () => {
  const { db, row } = fixture();
  const now = new Date('2026-11-24T12:00:00Z');
  const first = await claimScheduledContent(db, { ...row }, now, 10);
  assert.equal(first.kind, 'claimed');
  const expiredAt = new Date(now.getTime() + 11);
  const replacement = await claimScheduledContent(db, { ...row }, expiredAt, 10);
  assert.equal(replacement.kind, 'claimed');
  if (first.kind !== 'claimed' || replacement.kind !== 'claimed') return;
  assert.notEqual(first.claim.token, replacement.claim.token);
  assert.equal(await markClaimSending(db, first.claim, expiredAt), null);
  assert.equal(await finalizeClaim(db, first.claim, first.claim.claimedEngagement, { status: 'published' }, expiredAt), false);
  assert.equal(row.publishClaimToken, replacement.claim.token);
});

test('expired sending lease becomes durable unknown and cannot be re-published or finalized stale', async () => {
  const { db, row } = fixture();
  const now = new Date('2026-11-24T12:00:00Z');
  const result = await claimScheduledContent(db, { ...row }, now, 10);
  assert.equal(result.kind, 'claimed');
  if (result.kind !== 'claimed') return;
  const sending = await markClaimSending(db, result.claim, new Date(now.getTime() + 1));
  assert.ok(sending?.sendingEngagement);
  const expiredAt = new Date(now.getTime() + 11);
  const recovered = await claimScheduledContent(db, { ...row }, expiredAt, 10);
  assert.equal(recovered.kind, 'unknown');
  assert.equal(parsePublishMetadata(row.engagement).publishingState, 'unknown');
  assert.equal(row.publishClaimToken, null);
  assert.equal(await finalizeClaim(db, sending, sending.sendingEngagement, { status: 'published' }, expiredAt), false);
  assert.equal((await claimScheduledContent(db, { ...row }, new Date(expiredAt.getTime() + 1))).kind, 'unknown');
});
