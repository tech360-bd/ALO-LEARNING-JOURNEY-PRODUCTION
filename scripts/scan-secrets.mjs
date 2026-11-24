// Candidate worktree scanner, not a history scanner. Inspect all tracked and
// nonignored proposed files; never traverse symlinks or echo matching bytes.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const names = execFileSync('git', ['ls-files', '-coz', '--exclude-standard'], { maxBuffer: 64 << 20 }).toString().split('\0').filter(Boolean);
const rules = [
  ['private-key', /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{60,}|AKIA[A-Z0-9]{16}|sk_live_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{20,})\b/],
  ['credential-assignment', /(?:secret|password|passwd|api[_-]?key|access[_-]?token|encryption[_-]?key|master[_-]?key)["']?\s*[:=]\s*["']?(?=[A-Za-z0-9+/=_-]{24,}["'\s;,}]|[A-Za-z0-9+/=_-]{24,}$)(?=[A-Za-z0-9+/=_-]*\d)(?=[A-Za-z0-9+/=_-]*[a-z])[A-Za-z0-9+/=_-]{24,}/i],
  ['database-credential', /(?:mysql|postgres(?:ql)?):\/\/[^\s/:@]+:(?!REPLACE_WITH_|example|test|password)[^\s@/'"$<>]{8,}@/i],
];
let findings = 0, scanned = 0;
for (const file of new Set(names)) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) continue; // Working-tree deletion. CI runs on a clean checkout.
  const flag = rule => {
    // Even a malicious filename can contain the credential. Log no filenames.
    const locator = createHash('sha256').update(file).digest('hex').slice(0,12);
    console.error(`Sensitive material: ${rule} (path fingerprint ${locator})`);
    findings++;
  };
  if (file !== '.env.example' && /^(?:\.env(?:$|[.~_-])|\.envrc$)/i.test(path.basename(file))) flag('environment-file');
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported tracked entry; review scanner coverage');
  const text = stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file, 'latin1');
  // Keep the previous broader short-literal check on application source;
  // high-confidence rules above cover every directory and file format.
  if (file.startsWith('src/') && /(?:password|passwd)["']?\s*[:=]\s*["'][^"'\s]{6,}["']|(?:secret|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["'][^"'\s]{10,}["']/i.test(text)) flag('application-literal');
  for (const [rule, pattern] of rules) if (pattern.test(text)) flag(rule);
  scanned++;
}
console.log(`Scanned ${scanned} worktree entries; ${findings} findings (redacted).`);
process.exitCode = findings ? 1 : 0;
