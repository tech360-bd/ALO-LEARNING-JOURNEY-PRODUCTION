import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { publicAddress } from './public-http.ts';

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata.google', 'instance-data.ec2.internal']);

export interface ProviderRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Explicit exception for the documented local Ollama endpoint only. */
  allowLocalOllama?: boolean;
}

export interface ProviderJsonResponse {
  status: number;
  data: unknown;
}

export function validateProviderDestination(raw: string, allowLocalOllama = false): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash) throw new Error('Provider URL credentials and fragments are not allowed');
  if ([...url.searchParams.keys()].some((key) => /(?:key|token|secret|auth|password)/i.test(key))) {
    throw new Error('Provider credentials must not be placed in URL query parameters');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const localOllama = allowLocalOllama && url.protocol === 'http:' &&
    (host === 'localhost' || host === '127.0.0.1') && url.port === '11434';
  if (localOllama) return url;

  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) throw new Error('Provider URLs must use HTTPS on the standard port');
  if (!host.includes('.') || BLOCKED_HOSTS.has(host) || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || isIP(host)) {
    throw new Error('Provider URL must use an approved public DNS hostname');
  }
  return url;
}

export function assertProviderResolvedAddresses(addresses: string[]): void {
  if (addresses.length === 0 || !addresses.every((address) => publicAddress(address))) {
    throw new Error('Provider destination resolves to a non-public address');
  }
}

export function assertProviderRedirectAllowed(status: number): void {
  if (status >= 300 && status < 400) throw new Error('Provider redirects are disabled');
}

/**
 * Bounded JSON GET with DNS validation and address pinning. Redirects are not
 * followed, so credentials cannot be forwarded to another origin. The one
 * private-network exception is the repository's documented local Ollama URL.
 */
export async function requestProviderJson(raw: string, options: ProviderRequestOptions = {}): Promise<ProviderJsonResponse> {
  const url = validateProviderDestination(raw, options.allowLocalOllama);
  const transport = url.protocol === 'https:' ? https : http;
  return requestProviderJsonUsing(raw, options, transport.request.bind(transport), dnsLookup);
}

// Exported for deterministic tests: production uses Node's HTTP transport and
// DNS resolver above; tests inject a controlled socket/response implementation.
export async function requestProviderJsonUsing(
  raw: string,
  options: ProviderRequestOptions,
  request: (url: URL, options: any, callback: (response: any) => void) => any,
  resolveHost: typeof dnsLookup,
): Promise<ProviderJsonResponse> {
  const url = validateProviderDestination(raw, options.allowLocalOllama);
  const local = options.allowLocalOllama === true;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      agent: false,
      family: 4,
      signal,
      headers: options.headers,
      lookup(host, _lookupOptions, callback) {
        if (local) {
          if (host.toLowerCase() === 'localhost') return callback(null, '127.0.0.1', 4);
          if (host === '127.0.0.1') return callback(null, host, 4);
          return callback(new Error('Local Ollama host mismatch'), '', 4);
        }
        resolveHost(host, { family: 4, all: true }, (error, addresses) => {
          if (error) return callback(new Error('Provider DNS lookup failed'), '', 4);
          try { assertProviderResolvedAddresses(addresses.map((entry) => entry.address)); }
          catch (policyError) { return callback(policyError as Error, '', 4); }
          // Pin the validated address for this socket; do not perform a second DNS lookup.
          callback(null, addresses[0].address, 4);
        });
      },
    }, (response) => {
      const status = response.statusCode ?? 502;
      try { assertProviderRedirectAllowed(status); }
      catch (error) { response.destroy(); reject(error); return; }

      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
          response.destroy(new Error('Provider response exceeded 2 MiB'));
          req.destroy(new Error('Provider response exceeded 2 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (status < 200 || status >= 300) {
          resolve({ status, data: null });
          return;
        }
        try {
          resolve({ status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          reject(new Error('Provider returned invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
