import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('contact rejects invalid input and acknowledges a real saved enquiry without SMTP', () => {
  const dir = mkdtempSync(path.join(tmpdir(),'alo-contact-'));
  try {
    const r = spawnSync(process.execPath, ['--import','tsx','--input-type=commonjs','-e', `
      const assert = require('node:assert/strict');
      const { POST } = require('./src/app/api/contact/route.ts');
      const { db } = require('./src/lib/db.ts');
      const req = body => new Request('http://localhost/api/contact', {method:'POST', body:JSON.stringify(body)});
      (async () => {
        assert.equal((await POST(req(null))).status,400);
        const res = await POST(req({name:'Test',email:'test@example.test',message:'Admissions question'}));
        assert.equal(res.status,202); const data=await res.json(); assert.equal(data.saved,true); assert.equal(data.delivered,false);
        const rows=await db.marketingLead.findMany({where:{email:'test@example.test'}}); assert.equal(rows.length,1); assert.equal(rows[0].notes,'Admissions question');
      })().catch(e=>{console.error(e);process.exitCode=1});`], {encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_URL:'',ALO_LOCAL_DB_FILE:path.join(dir,'store.json'),SMTP_PASS:'',SMTPPASS:'',SMTP_PASSWORD:''}});
    assert.equal(r.status,0,r.stderr);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
