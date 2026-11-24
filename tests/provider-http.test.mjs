import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { assertProviderRedirectAllowed, assertProviderResolvedAddresses, requestProviderJsonUsing, validateProviderDestination } from '../src/lib/provider-http.ts';

const localOllama = (url) => validateProviderDestination(url, true);

test('rejects localhost, private/public-IP literals, metadata hosts, and unsupported schemes', () => {
  assert.throws(() => validateProviderDestination('http://localhost:8080/models'), /HTTPS/);
  assert.throws(() => validateProviderDestination('https://127.0.0.1/models'), /public DNS/);
  assert.throws(() => validateProviderDestination('https://169.254.169.254/latest/meta-data'), /public DNS/);
  assert.throws(() => validateProviderDestination('https://metadata.google.internal/computeMetadata/v1'), /public DNS/);
  assert.throws(() => validateProviderDestination('ftp://provider.example.test/models'), /HTTPS/);
  assert.throws(() => validateProviderDestination('https://provider.example.test/models?api_key=secret'), /query parameters/);
  assert.equal(localOllama('http://localhost:11434/api/tags').hostname, 'localhost');
});

test('rejects DNS answers containing private, link-local, or mixed public/private addresses', () => {
  for (const addresses of [[], ['127.0.0.1'], ['169.254.10.20'], ['8.8.8.8', '10.0.0.1']]) {
    assert.throws(() => assertProviderResolvedAddresses(addresses), /non-public/);
  }
  assert.doesNotThrow(() => assertProviderResolvedAddresses(['8.8.8.8']));
});

test('provider redirects are rejected and never followed', async () => {
  assert.throws(() => assertProviderRedirectAllowed(302), /redirects are disabled/);
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options });
    const req = new EventEmitter();
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 302;
      response.destroy = () => {};
      callback(response);
    };
    req.destroy = () => {};
    return req;
  };
  await assert.rejects(requestProviderJsonUsing('https://provider.example.test/models', {}, request, (_host, _opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }])));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, undefined, 'node transport does not auto-follow redirects');
});

test('timeout/cancellation signal is passed to provider transport and aborts pending I/O', async () => {
  const controller = new AbortController();
  let requestSignal;
  const request = (_url, options) => {
    requestSignal = options.signal;
    const req = new EventEmitter();
    req.end = () => requestSignal.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true });
    req.destroy = () => {};
    return req;
  };
  const pending = requestProviderJsonUsing('https://provider.example.test/models', { signal: controller.signal, timeoutMs: 60_000 }, request, (_host, _opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]));
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(requestSignal.aborted, true);
});

test('Gemini discovery no longer puts API keys in a URL query string', () => {
  const route = readFileSync(new URL('../src/app/api/v1/admin/ai-models/providers/[providerId]/discover-models/route.ts', import.meta.url), 'utf8');
  assert.match(route, /x-goog-api-key/);
  assert.doesNotMatch(route, /models\?key=\$\{apiKey\}/);
});
