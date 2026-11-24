// Optional local acceptance check. Uses an already built standalone app and
// ephemeral test credentials. No SMTP, databases, or external websites used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createServer } from 'node:net';

const load = createRequire(path.resolve('.cache/alo-browser/package.json'));
const chromium = load('@sparticuz/chromium').default;
const puppeteer = load('puppeteer-core').default;
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(32).toString('hex'), salt = randomBytes(16);
const email = 'browser@example.test';
const server = spawn(process.execPath, ['.next/standalone/server.js'], { env: {
  PATH: process.env.PATH, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_EMAIL: email, ADMIN_OTP_REQUIRED: 'false',
  ADMIN_PASSWORD_HASH: `scrypt$${salt.toString('base64url')}$${scryptSync(password,salt,64).toString('base64url')}`,
}, stdio: ['ignore','pipe','ignore'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Standalone startup timed out')), 15000);
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Standalone server exited')); });
    server.stdout.on('data', d => { if (/ready/i.test(d)) { clearTimeout(timer); resolve(); } });
  });
  browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => { const url = new URL(r.url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) void r.continue(); else void r.abort(); });
  await page.setViewport({ width: 375, height: 812 });
  await page.goto(`${origin}/contact`);
  assert.equal(await page.evaluate(async () => (await fetch('/fonts/HindSiliguri-Regular.ttf', { redirect: 'manual' })).status), 200);
  for (const [id, text] of [['name','Test'],['email',email],['message','Disposable contact test']]) await page.type(`#contact-${id}`,text);
  await page.click('button[type=submit]');
  await page.waitForSelector('[role=alert]');
  assert.match(await page.$eval('[role=alert]', e=>e.textContent), /not received/);
  assert.equal(await page.$eval('#contact-message', e=>e.value),'Disposable contact test');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth));
  await page.goto(`${origin}/dashboard`);
  assert.equal(new URL(page.url()).pathname, '/login');
  await page.type('#admin-email', email); await page.type('#admin-password', password);
  await page.waitForSelector('button[type=submit]:not(:disabled)');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => location.pathname === '/dashboard');
  await page.waitForFunction(() => document.body.innerText.includes('Welcome back'));
  const session = await page.evaluate(async () => (await fetch('/api/auth/session')).json());
  assert.equal(session.user.email, email);
  assert.equal(await page.evaluate(async () => (await fetch('/api/settings/sessions')).status), 401);
  await page.setViewport({ width: 1280, height: 900 });
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth));
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/auth/csrf')).json();
    await fetch('/api/auth/signout', { method: 'POST', body: new URLSearchParams({ csrfToken, json: 'true' }) });
  });
  assert.equal(await page.evaluate(async () => (await fetch('/api/ideas')).status), 401);
  assert.deepEqual(errors, []);
  console.log('PASS: mobile contact failure retains input, desktop/mobile layout, /dashboard admin gate, real credential sign-in and separate tenant login; no page exceptions.');
} finally { if (browser) await browser.close(); server.kill('SIGTERM'); }
