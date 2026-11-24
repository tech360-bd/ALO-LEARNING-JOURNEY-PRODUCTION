import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPost } from '../src/lib/postiz-adapter.ts';

const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(['POSTIZ_BASE_URL', 'POSTIZ_API_KEY', 'POSTIZ_WORKSPACE_ID'].map((key) => [key, process.env[key]]));

function configure() {
  process.env.POSTIZ_BASE_URL = 'https://postiz.example.test';
  process.env.POSTIZ_API_KEY = 'test-only-postiz-key';
  process.env.POSTIZ_WORKSPACE_ID = 'workspace-test';
}

test('Postiz accepts a well-formed success only when it contains a provider post ID', async () => {
  configure();
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://postiz.example.test/api/posts');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer test-only-postiz-key');
    return new Response(JSON.stringify({ id: 'post-42', platformResults: [{ platform: 'linkedin', id: 'li-42', status: 'published' }] }), { status: 201 });
  };
  try {
    const result = await publishPost({ contentId: 'c1', text: 'hello', platforms: ['linkedin'], attemptKey: 'local-key' });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.postizPostId, 'post-42');
    assert.equal(result.platformPostIds[0].id, 'li-42');
  } finally { globalThis.fetch = originalFetch; }
});

test('empty, invalid JSON, and missing-ID 2xx responses are unknown, never accepted', async (t) => {
  configure();
  for (const [name, response] of [
    ['empty', new Response('', { status: 200 })],
    ['invalid-json', new Response('{not json', { status: 200 })],
    ['missing-id', new Response(JSON.stringify({ platformResults: [] }), { status: 200 })],
  ]) {
    await t.test(name, async () => {
      globalThis.fetch = async () => response.clone();
      const result = await publishPost({ contentId: 'c1', text: 'hello', platforms: ['linkedin'] });
      assert.equal(result.outcome, 'unknown');
      assert.equal(result.postizPostId, undefined);
    });
  }
  globalThis.fetch = originalFetch;
});

test('provider 4xx is a definite rejection, while 5xx is ambiguous', async () => {
  configure();
  globalThis.fetch = async () => new Response('no', { status: 422 });
  const rejected = await publishPost({ contentId: 'c1', text: 'hello', platforms: ['linkedin'] });
  assert.equal(rejected.outcome, 'rejected');
  globalThis.fetch = async () => new Response('maybe accepted', { status: 503 });
  const unknown = await publishPost({ contentId: 'c1', text: 'hello', platforms: ['linkedin'] });
  assert.equal(unknown.outcome, 'unknown');
  globalThis.fetch = originalFetch;
});

test('timeout and accepted-request/response-lost failures remain unknown', async () => {
  configure();
  let providerAccepted = false;
  globalThis.fetch = async () => {
    providerAccepted = true;
    throw new DOMException('response lost after acceptance', 'TimeoutError');
  };
  const result = await publishPost({ contentId: 'c1', text: 'hello', platforms: ['linkedin'] });
  assert.equal(providerAccepted, true);
  assert.equal(result.outcome, 'unknown');
  assert.match(result.error, /timed out|acceptance is unknown/i);
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
