import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScraperUrl } from '../src/lib/scraper-url.ts';

test('accepts public HTTPS URLs and normalizes the URL', () => {
  assert.equal(validateScraperUrl('https://example.com/path').href, 'https://example.com/path');
});

test('rejects HTTP, unsupported schemes, malformed URLs, and IP/private destinations at the boundary', () => {
  for (const url of ['http://example.com', 'ftp://example.com/file', 'not a URL', 'https://localhost', 'https://127.0.0.1', 'https://192.168.1.10']) {
    assert.throws(() => validateScraperUrl(url));
  }
});
