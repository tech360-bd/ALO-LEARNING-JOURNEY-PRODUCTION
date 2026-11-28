/**
 * SSRF (Server-Side Request Forgery) protection for outbound HTTP requests.
 *
 * Blocks attempts to deliver webhooks to:
 *   - localhost / 127.0.0.1 / 0.0.0.0 / ::1
 *   - private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 *   - link-local addresses (169.254.0.0/16 — includes AWS/GCP/Azure metadata endpoints)
 *   - cloud metadata endpoints (169.254.169.254 — AWS/Azure/GCP metadata service)
 *   - unique-local IPv6 (fc00::/7)
 *   - IPv6 loopback
 *   - IP-literal forms that bypass hostname checks (e.g. http://2130706433/ = 127.0.0.1)
 *
 * Strategy:
 *   1. Parse URL
 *   2. Validate scheme (only http/https)
 *   3. Resolve hostname to IP(s) via DNS
 *   4. Block if any resolved IP is private/loopback/link-local/multicast
 *   5. Compare connected IP against blocklist at fetch time (defense in depth)
 */

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { BodyTooLargeError, readLimitedStream } from './read-limited-stream.mjs';

const BLOCKED_HOSTNAMES = new Set<string>([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal', // GCP metadata
  'metadata.aws.internal',    // AWS metadata alias
]);

export interface SsrfCheckResult {
  allowed: boolean;
  reason?: string;
  resolvedIps?: string[];
}

/**
 * Check whether a URL is safe to fetch from the server.
 * Does NOT fetch — only validates.
 *
 * Resolves DNS to IP(s) and blocks if any IP is in a private range.
 * This is the canonical SSRF protection pattern.
 */
export async function isUrlSafe(url: string): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  // Only http and https schemes are allowed
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Scheme "${parsed.protocol}" not allowed` };
  }

  // Block obvious hostname patterns
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `Hostname "${hostname}" is blocked` };
  }

  // If hostname is already an IP literal, validate directly
  if (isIpLiteral(hostname)) {
    if (isPrivateIp(hostname)) {
      return { allowed: false, reason: `IP ${hostname} is in a blocked range` };
    }
    return { allowed: true, resolvedIps: [hostname] };
  }

  // Resolve hostname via DNS — Node's dns.lookup returns the resolved IPs
  // We use a custom resolver because we need to see all A/AAAA records
  const resolvedIps = await resolveHostname(hostname).catch(() => []);
  if (resolvedIps.length === 0) {
    return { allowed: false, reason: `DNS resolution failed for ${hostname}` };
  }

  for (const ip of resolvedIps) {
    if (isPrivateIp(ip)) {
      return {
        allowed: false,
        reason: `Hostname ${hostname} resolves to private/blocked IP ${ip}`,
      };
    }
  }

  return { allowed: true, resolvedIps };
}

/**
 * Check if a string looks like an IP literal (IPv4 or IPv6).
 */
function isIpLiteral(s: string): boolean {
  // IPv4: 4 octets, 0-255 each
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(s)) return true;
  // IPv6: contains colons
  if (s.includes(':') && /^[0-9a-fA-F:]+$/.test(s)) return true;
  // Bracketed IPv6 form: [::1]
  if (s.startsWith('[') && s.endsWith(']')) return true;
  return false;
}

/**
 * Check if an IP is in a private/loopback/link-local/multicast range.
 *
 * Returns true for:
 *   - 127.0.0.0/8 (IPv4 loopback)
 *   - 0.0.0.0/8 (this-network)
 *   - 10.0.0.0/8 (private class A)
 *   - 172.16.0.0/12 (private class B)
 *   - 192.168.0.0/16 (private class C)
 *   - 169.254.0.0/16 (link-local — includes 169.254.169.254 cloud metadata)
 *   - 224.0.0.0/4 (multicast)
 *   - 240.0.0.0/4 (reserved)
 *   - ::1 (IPv6 loopback)
 *   - fc00::/7 (IPv6 unique-local)
 *   - fe80::/10 (IPv6 link-local)
 *   - ff00::/8 (IPv6 multicast)
 */
export function isPrivateIp(ip: string): boolean {
  // Strip IPv6 brackets and zone index if present
  const clean = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const ipVersion = isIP(clean);
  if (ipVersion === 0) return true; // fail closed on invalid IP strings

  // IPv4 check
  if (ipVersion === 4) {
    const [a, b] = clean.split('.').map((s) => parseInt(s, 10));
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true;                        // 127.0.0.0/8
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }

  // IPv6 check
  if (clean === '::1' || clean === '::' || clean === '0:0:0:0:0:0:0:1' || clean === '0:0:0:0:0:0:0:0') {
    return true; // loopback / unspecified
  }
  if (clean.startsWith('fc') || clean.startsWith('fd')) return true; // fc00::/7 unique-local
  if (clean.startsWith('fe8') || clean.startsWith('fe9') ||
      clean.startsWith('fea') || clean.startsWith('feb')) return true; // fe80::/10 link-local
  if (clean.startsWith('ff')) return true;                             // ff00::/8 multicast

  // IPv4-mapped IPv6 in dotted form: ::ffff:a.b.c.d (or 0:0:0:0:0:ffff:a.b.c.d)
  const v4Dotted = clean.match(/^(?:(?:0{1,4}:){5}|::)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Dotted) return isPrivateIp(v4Dotted[1]);

  // IPv4-mapped IPv6 in normalized hex form from WHATWG URL parser: e.g. ::ffff:7f00:1
  const v4Hex = clean.match(/^(?:(?:0{1,4}:){5}|::)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4Hex) {
    const hi = parseInt(v4Hex[1], 16);
    const lo = parseInt(v4Hex[2], 16);
    const mappedV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIp(mappedV4);
  }

  return false;
}

/**
 * Resolve a hostname to its IPv4 + IPv6 addresses.
 * Uses Node's `dns` module via dynamic import to avoid pulling it into client bundles.
 */
async function resolveHostname(hostname: string): Promise<string[]> {
  // Dynamic import so this file can be imported by client-safe code
  const dns = await import('dns').then((m) => m.promises || m);
  const ips: string[] = [];
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const r of records) ips.push(r.address);
  } catch {
    // Try dns.resolve4 + dns.resolve6 as fallbacks
    try {
      const v4 = await dns.resolve4(hostname);
      ips.push(...v4);
    } catch { /* ignore */ }
    try {
      const v6 = await dns.resolve6(hostname);
      ips.push(...v6);
    } catch { /* ignore */ }
  }
  return ips;
}

/**
 * Build a safe fetch options object for outbound webhook delivery.
 * Adds timeouts, redirect: 'error' (don't follow redirects — could redirect to private IPs),
 * and a max-response-size guard.
 */
export function safeWebhookFetchOptions(): RequestInit {
  return {
    redirect: 'error', // SSRF protection: don't follow redirects
    headers: {
      'User-Agent': 'MarketingOS-Webhook/1.0',
      Accept: 'application/json, */*',
    },
  };
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeFetchResponse {
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

/**
 * Perform a bounded HTTP(S) GET/HEAD request with SSRF protection on every hop:
 *   1. Validates URL scheme + resolves DNS + rejects any private/reserved IP via `isUrlSafe`.
 *   2. Pins the validated IP directly on the socket via `lookup` (prevents DNS rebinding TOCTOU).
 *   3. Disables automatic redirects; follows up to `maxRedirects` manually after re-checking `isUrlSafe`.
 *   4. Reads response stream via `readLimitedStream` (cancels oversized bodies before buffering).
 */
export async function fetchSafePublicUrl(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  return fetchSafePublicUrlUsing(rawUrl, options);
}

export async function fetchSafePublicUrlUsing(
  rawUrl: string,
  options: SafeFetchOptions = {},
  deps: {
    checkUrl?: (url: string) => Promise<SsrfCheckResult>;
    httpRequest?: typeof http.request;
    httpsRequest?: typeof https.request;
  } = {}
): Promise<SafeFetchResponse> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const checkUrl = deps.checkUrl ?? isUrlSafe;
  const httpRequest = deps.httpRequest ?? http.request.bind(http);
  const httpsRequest = deps.httpsRequest ?? https.request.bind(https);

  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safety = await checkUrl(currentUrl);
    if (!safety.allowed || !safety.resolvedIps || safety.resolvedIps.length === 0) {
      throw new Error(`refused by SSRF guard: ${safety.reason ?? 'unsafe host'}`);
    }
    for (const ip of safety.resolvedIps) {
      if (isPrivateIp(ip)) {
        throw new Error(`refused by SSRF guard: private/blocked IP ${ip}`);
      }
    }
    const pinnedIp = safety.resolvedIps[0].replace(/^\[|\]$/g, '');
    const pinnedFamily = isIP(pinnedIp) === 6 ? 6 : 4;

    const parsed = new URL(currentUrl);
    const requester = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

    const hopResult = await new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: Uint8Array;
      location?: string;
    }>((resolve, reject) => {
      const req = requester(
        parsed,
        {
          method,
          agent: false,
          signal,
          headers: options.headers,
          lookup(_hostname, lookupOpts, cb) {
            if (isPrivateIp(pinnedIp)) {
              const err = new Error('Destination IP is not allowed');
              if (lookupOpts && typeof lookupOpts === 'object' && lookupOpts.all) {
                return (cb as unknown as (e: Error) => void)(err);
              }
              return cb(err, '', 4);
            }
            if (lookupOpts && typeof lookupOpts === 'object' && lookupOpts.all) {
              return (cb as unknown as (e: null, addrs: Array<{ address: string; family: number }>) => void)(null, [
                { address: pinnedIp, family: pinnedFamily },
              ]);
            }
            cb(null, pinnedIp, pinnedFamily);
          },
        },
        async (res) => {
          const status = res.statusCode ?? 502;
          const headers = res.headers;
          if (status >= 300 && status < 400) {
            const loc = typeof headers.location === 'string' ? headers.location : undefined;
            res.destroy();
            resolve({ status, headers, body: new Uint8Array(0), location: loc });
            return;
          }
          if (method === 'HEAD' || maxBytes === 0) {
            res.destroy();
            resolve({ status, headers, body: new Uint8Array(0) });
            return;
          }
          try {
            const body = await readLimitedStream(res, maxBytes);
            resolve({ status, headers, body });
          } catch (err) {
            res.destroy();
            reject(err instanceof BodyTooLargeError ? err : new Error('Failed reading response stream'));
          }
        }
      );
      req.on('error', reject);
      req.end();
    });

    if (hopResult.status >= 300 && hopResult.status < 400 && hopResult.location) {
      if (hop === maxRedirects) {
        throw new Error(`Too many redirects (max ${maxRedirects})`);
      }
      currentUrl = new URL(hopResult.location, currentUrl).toString();
      continue;
    }

    return {
      url: currentUrl,
      status: hopResult.status,
      headers: hopResult.headers,
      body: hopResult.body,
    };
  }

  throw new Error('Redirect limit exceeded');
}
