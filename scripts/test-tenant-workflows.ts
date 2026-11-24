// Run only after migrate deploy on a disposable DB. Unique test rows are
// intentionally left in that disposable DB for inspection (no deletes/reset).
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireTestDatabase } from './require-test-database.mjs';

async function main() {
  requireTestDatabase();
  const id = randomUUID();
  Object.assign(process.env, { JWT_SECRET: randomBytes(32).toString('hex'), VAULT_MASTER_KEY: randomBytes(32).toString('base64') });
  const { db } = await import('../src/lib/db');
  const register = await import('../src/app/api/auth/register/route');
  const login = await import('../src/app/api/auth/login/route');
  const users = await import('../src/app/api/users/route');
  const team = await import('../src/app/api/team/route');
  const setup = await import('../src/app/api/v1/auth/mfa/setup/route');
  const verify = await import('../src/app/api/v1/auth/mfa/verify/route');
  const refresh = await import('../src/app/api/v1/auth/refresh/route');
  const { computeTotp } = await import('../src/lib/totp');
  const { verifyToken } = await import('../src/lib/auth');
  const req = (body: object, token?: string) => new NextRequest('http://localhost/api/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body),
  });
  const account = { email: `${id}@example.test`, name: id, password: randomBytes(24).toString('hex') };
  try {
    const response = await register.POST(req(account));
    assert.equal(response.status, 200);
    const { token, user } = await response.json();
    const duplicate = { ...account, email: `other-${account.email}` };
    assert.equal((await register.POST(req(duplicate))).status, 409);
    assert.equal(await db.user.count({ where: { email: duplicate.email } }), 0);
    const member = { ...duplicate, name: 'Viewer', role: 'viewer' };
    assert.equal((await users.POST(req({ ...member, role: 'super_admin' }, token))).status, 403);
    assert.equal((await users.POST(req(member, token))).status, 201);
    const viewerLogin = await login.POST(req(member));
    assert.equal(viewerLogin.status, 200);
    const viewer = await viewerLogin.json();
    const viewerSid = (await verifyToken(viewer.token)).sid;
    assert.equal((await db.userSession.findUniqueOrThrow({ where: { id: viewerSid } })).userId, viewer.user.id);
    const link = await db.companyUser.findFirstOrThrow({ where: { userId: viewer.user.id, companyId: user.companyId } });
    assert.equal((await team.POST(req({ action: 'update_role', companyUserId: link.id, role: 'super_admin' }, token))).status, 403);
    assert.equal((await db.companyUser.findUniqueOrThrow({ where: { id: link.id } })).role, 'viewer');
    assert.equal((await team.POST(req({ action: 'invite', email: 'no@example.test' }, viewer.token))).status, 403);
    assert.equal(await db.invitation.count({ where: { companyId: user.companyId } }), 0);
    assert.equal((await team.POST(req({ action: 'invite', email: 'yes@example.test', role: 'viewer' }, token))).status, 200);
    assert.equal(await db.invitation.count({ where: { companyId: user.companyId } }), 1);

    const existingCredit = await db.usageCredit.create({ data: { companyId: user.companyId, creditType: 'ai_minutes', balance: 37 } });
    for (const credits of [await import('../src/app/api/v1/billing/credits/route'), await import('../src/app/api/v1/billing/credits/purchase/route')]) {
      const order = { creditType: 'ai_minutes', amount: 1000 };
      assert.equal((await credits.POST(req(order, viewer.token))).status, 403);
      assert.equal((await credits.POST(req(order, token))).status, 503);
      assert.equal((await credits.POST(req(order, token))).status, 503);
    }
    const { GET: readCredits } = await import('../src/app/api/v1/billing/credits/route');
    const read = await readCredits(req({}, token));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).data.credits[0].balance, 37);
    assert.equal((await db.usageCredit.findUniqueOrThrow({ where: { id: existingCredit.id } })).balance, 37);
    assert.equal(await db.billingAdjustment.count({ where: { companyId: user.companyId } }), 0);

    const payments = await import('../src/app/api/v1/billing/payments/route');
    const intent = { requestId: randomUUID(), amount: 10, method: 'card', provider: 'sandbox' };
    assert.equal((await payments.POST(req(intent, viewer.token))).status, 403);
    assert.equal((await payments.POST(req({ ...intent, status: 'succeeded' }, token))).status, 400);
    assert.equal(await db.payment.count({ where: { companyId: user.companyId } }), 0);
    assert.equal((await payments.POST(req(intent, token))).status, 200);
    assert.equal((await payments.POST(req(intent, token))).status, 200);
    assert.equal((await payments.POST(req({ ...intent, amount: 20 }, token))).status, 409);
    assert.equal(await db.payment.count({ where: { companyId: user.companyId, status: 'pending' } }), 1);

    const invoice = await db.mosInvoice.create({ data: { companyId: user.companyId, invoiceNumber: `rc-${id}`,
      periodStart: new Date(), periodEnd: new Date(), subtotal: 10, total: 10, status: 'sent', lineItems: '[]' } });
    const againstInvoice = { ...intent, invoiceId: invoice.id };
    assert.equal((await payments.POST(req({ ...againstInvoice, status: 'succeeded' }, token))).status, 400);
    const retries = await Promise.all([payments.POST(req(againstInvoice, token)), payments.POST(req(againstInvoice, token))]);
    assert.deepEqual(retries.map(r => r.status), [200, 200]);
    assert.equal(await db.payment.count({ where: { invoiceId: invoice.id, status: 'pending' } }), 1);
    assert.deepEqual(await db.mosInvoice.findUniqueOrThrow({ where: { id: invoice.id } }), invoice);

    const enrollment = await setup.POST(req({}, token));
    assert.equal(enrollment.status, 200);
    const { data } = await enrollment.json();
    assert.match(data.qr_code_data_url, /^data:image\/png;base64,/);
    assert.equal((await verify.POST(req({ code: 'invalid' }, token))).status, 400);
    assert.equal((await verify.POST(req({ code: computeTotp(data.secret) }, token))).status, 200);
    assert.equal((await login.POST(req(account))).status, 401);
    assert.equal((await login.POST(req({ ...account, code: 'invalid' }))).status, 401);
    const code = computeTotp(data.secret, Math.floor(Date.now() / 1000) + 30);
    assert.equal((await login.POST(req({ ...account, code }))).status, 200);
    assert.equal((await login.POST(req({ ...account, code }))).status, 401);

    const second = await db.mosCompany.create({ data: { slug: `test-${id}`, name: 'Second workspace' } });
    await db.companyUser.create({ data: { userId: user.id, companyId: second.id, permissions: '{}', role: 'viewer' } });
    const raw = randomBytes(32).toString('hex');
    await db.refreshToken.create({ data: { userId: user.id, companyId: second.id, tokenHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now()+60000) } });
    const expired = randomBytes(32).toString('hex');
    await db.refreshToken.create({ data: { userId: user.id, companyId: second.id, tokenHash: createHash('sha256').update(expired).digest('hex'), expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await refresh.POST(req({ refreshToken: expired }))).status, 401);
    const rotate = () => refresh.POST(req({ refreshToken: raw }));
    const rotations = await Promise.all([rotate(), rotate()]);
    assert.deepEqual(rotations.map(r => r.status).sort(), [200, 401]);
    const renewed = await rotations.find(r => r.ok)!.json();
    assert.equal((await verifyToken(renewed.accessToken)).companyId, second.id);
    assert.equal((await team.POST(req({ action: 'update_role', companyUserId: link.id, role: 'manager' }, renewed.accessToken))).status, 403);
    const revoke = await import('../src/app/api/settings/sessions/[id]/route');
    assert.equal((await revoke.DELETE(req({}, renewed.accessToken), { params: Promise.resolve({ id: 'current' }) })).status, 200);
    assert.equal(await verifyToken(renewed.accessToken), null);
    assert.equal((await refresh.POST(req({ refreshToken: renewed.refreshToken }))).status, 401);
    const logout = await import('../src/app/api/v1/auth/logout/route');
    assert.equal((await logout.POST(req({ all: true }, token))).status, 200);
    assert.equal(await verifyToken(token), null);
    assert.ok(await verifyToken(viewer.token), 'another user was not revoked');
    console.log('PASS: tenant registration rollback, grants, invitation persistence, MFA challenge/replay and concurrent refresh isolation');
  } finally { await db.$disconnect(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
