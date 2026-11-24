import test from 'node:test';
import assert from 'node:assert/strict';
import { canAssignTeamRole } from '../src/lib/team-roles.ts';
import { enrollmentSecret, matchingTotpStep } from '../src/lib/totp.ts';

// RFC 6238 SHA-1 vector at 59s, truncated to six digits.
test('old encrypted enrollment payloads and new Base32 payloads verify the same authenticator code', () => {
  const old = Buffer.from('12345678901234567890').toString('base64');
  const standard = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const stored of [old, 'b32:' + standard]) {
    assert.equal(enrollmentSecret(stored), standard);
    assert.equal(matchingTotpStep(enrollmentSecret(stored), '287082', 59), 30);
    for (const invalid of [undefined, '', 287082, '28708', '000000']) {
      assert.equal(matchingTotpStep(standard, invalid, 59), null);
    }
  }
  assert.throws(() => enrollmentSecret('malformed'));
});

test('tenant management grants canonical subordinate roles only', () => {
  for (const actor of ['admin', 'company_owner', 'super_admin']) {
    for (const forbidden of ['super_admin', 'company_owner', '__proto__', null, {}, 'Super Admin']) {
      assert.equal(canAssignTeamRole(actor, forbidden), false);
    }
    assert.equal(canAssignTeamRole(actor, 'viewer'), true);
  }
  assert.equal(canAssignTeamRole('viewer', 'team_member'), false);
  assert.equal(canAssignTeamRole('admin', 'admin'), false);
  assert.equal(canAssignTeamRole('company_owner', 'admin'), true);
});

test('older dashboard role labels map to canonical keys without granting protected roles', async () => {
  const { teamRoleKey } = await import('../src/lib/team-roles.ts');
  assert.equal(teamRoleKey('Team Member'), 'team_member');
  assert.equal(teamRoleKey('unknown'), undefined);
  assert.equal(canAssignTeamRole('company_owner', teamRoleKey('Super Admin')), false);
});

test('the legacy SDK is blocked before import or network activity without both owner switches', async () => {
  const { createApprovedZai } = await import('../src/lib/approved-zai.ts');
  const keys = ['ALO_PAID_AI_API_ALLOWED','ALO_OWNER_APPROVED_PAID_AI_API'];
  const prev = keys.map(k=>process.env[k]);
  try {
    for (const flags of [['false','true'], ['true','false']]) {
      keys.forEach((k,i)=>{process.env[k]=flags[i]});
      await assert.rejects(createApprovedZai(), /external_ai_blocked_by_payment_guard/);
    }
  } finally { keys.forEach((k,i)=>{ if(prev[i]===undefined) delete process.env[k]; else process.env[k]=prev[i]; }); }
});
