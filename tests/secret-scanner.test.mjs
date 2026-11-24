import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/scan-secrets.mjs', import.meta.url));
test('candidate scanner includes tracked nested and proposed files, redacts both values and filenames', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'alo-scan-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const run = () => spawnSync(process.execPath, [scanner], { cwd, encoding: 'utf8' });
    writeFileSync(path.join(cwd, '.env.example'), 'API_KEY=\n');
    assert.equal(run().status, 0);
    const sample = 'gh' + 'p_' + 'X'.repeat(36); // format only, never issued
    for (const dir of ['.github', 'marketingos', 'scripts', 'tests', 'upload']) {
      mkdirSync(path.join(cwd, dir));
      const file = path.join(cwd, dir, sample + '.txt');
      writeFileSync(file, sample);
      execFileSync('git', ['add','--', file], { cwd });
      const r = run(); assert.equal(r.status, 1); assert.match(r.stderr,/provider-token/);
      assert.ok(!(r.stdout + r.stderr).includes(sample));
      rmSync(file);
    }
    writeFileSync(path.join(cwd, 'scripts/.env.save'), 'CONTROL_ONLY=1');
    assert.equal(run().status, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
