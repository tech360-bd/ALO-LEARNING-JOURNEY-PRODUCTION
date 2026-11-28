// Server-side public retrieval and approved webhook delivery. Deliberately
// supports DNS names and public IPv4 only. TLS validates the original name;
// the socket lookup itself filters and selects the address (no second lookup).
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';

const excluded = new BlockList();
for (const [net, bits] of [ ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8], ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4] ] as const) excluded.addSubnet(net, bits);
export function publicAddress(ip: string) { return isIP(ip) === 4 && !excluded.check(ip); }
export function publicUrl(raw: string, webhook = false) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !url.hostname.includes('.') || isIP(url.hostname) || url.hostname.includes(':')) throw new Error('Public HTTPS hostname required');
  if (webhook && !(process.env.MOS_WEBHOOK_ALLOWED_ORIGINS || '').split(',').some(o => o.trim() === url.origin)) throw new Error('Webhook origin not approved');
  return url;
}
export function publicHttp(raw: string, post?: { body: string; headers: Record<string,string> }): Promise<{ status: number; text: string }> {
  const url = publicUrl(raw, !!post);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: post ? 'POST' : 'GET', agent: false, family: 4,
      signal: AbortSignal.timeout(10000), headers: post?.headers,
      lookup(host, options, cb) {
        const wantAll = typeof options === 'object' && options !== null && options.all;
        lookup(host, { family: 4, all: true }, (err, rows) => {
          if (err || !rows.length || !rows.every(r => publicAddress(r.address))) {
            const denyErr = new Error('Destination not allowed');
            if (wantAll) return (cb as unknown as (e: Error) => void)(denyErr);
            return cb(denyErr, '', 4);
          }
          if (wantAll) return (cb as unknown as (e: null, addrs: Array<{ address: string; family: number }>) => void)(null, [{ address: rows[0].address, family: 4 }]);
          cb(null, rows[0].address, 4);
        });
      },
    }, res => {
      res.on('error', reject);
      const status = res.statusCode ?? 502;
      if (status < 200 || status >= 300) { res.destroy(); resolve({ status, text: '' }); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (post ? 65536 : 2 << 20)) { req.destroy(new Error('Response exceeds limit')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(post?.body);
  });
}
