#!/usr/bin/env node
// Scans added lines of a git diff for things that must never be published:
// XRPL addresses/seeds that are not known public test vectors, emails other
// than GitHub noreply addresses, and XRP amounts written in prose.
//
// Usage: node scripts/privacy-scan.mjs [<git diff range>]   (default: --cached)
// Exit code 1 if anything needs a human look.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const range = process.argv.slice(2);
const diffArgs = range.length ? range : ['--cached'];
const diff = execFileSync('git', ['diff', '--unified=0', '--no-color', ...diffArgs], { encoding: 'utf8', maxBuffer: 1 << 28 });

// Public test keys from the xrpl.js suites (src/offline/core/vectors.js) and
// any extra fixtures listed in test/fixtures/public-test-keys.txt.
const allow = new Set();
const harvest = (text) => {
  for (const m of text.matchAll(/\b[rs][1-9A-HJ-NP-Za-km-z]{24,34}\b/g)) allow.add(m[0]);
};
harvest(readFileSync(new URL('../src/offline/core/vectors.js', import.meta.url), 'utf8'));
try { harvest(readFileSync(new URL('../test/fixtures/public-test-keys.txt', import.meta.url), 'utf8')); } catch {}
// The base58 alphabet itself, as it appears in library code.
allow.add('rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz');

const findings = [];
let file = '';
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ ')) { file = line.slice(6); continue; }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (file === 'package-lock.json') continue; // registry URLs and integrity hashes only
  const text = line.slice(1);
  for (const m of text.matchAll(/\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g)) {
    if (!allow.has(m[0]) && /\d/.test(m[0]) && /[A-Z]/.test(m[0])) findings.push([file, 'XRPL address not in test vectors', m[0]]);
  }
  for (const m of text.matchAll(/\bs(Ed)?[1-9A-HJ-NP-Za-km-z]{27,30}\b/g)) {
    if (!allow.has(m[0]) && /\d/.test(m[0]) && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0])) findings.push([file, 'possible seed not in test vectors', m[0]]);
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (!/@(users\.)?noreply\.github\.com$|^noreply@anthropic\.com$/.test(m[0])) findings.push([file, 'email address', m[0]]);
  }
  for (const m of text.matchAll(/\b\d[\d,]*(\.\d+)?\s?XRP\b/g)) {
    findings.push([file, 'XRP amount (check it is an example/policy value)', m[0]]);
  }
}

if (findings.length === 0) {
  console.log('privacy-scan: clean (no addresses, seeds, emails or XRP amounts outside test vectors)');
} else {
  console.log('privacy-scan: review these:');
  for (const [f, kind, v] of findings) console.log(`  ${f}: ${kind}: ${v}`);
  process.exitCode = 1;
}
