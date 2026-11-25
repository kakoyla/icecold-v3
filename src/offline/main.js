// Phase 1 page: network lockdown, code self-hash, startup self-test.
// The signing screens arrive in Phase 2; until then nothing here signs.
import { lockdownNetwork, forbidMathRandom } from './core/lockdown.js';
import { runSelfTest } from './core/selftest.js';
import { markSelfTest, signingEnabled } from './core/gate.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// 1. Lock down network APIs and Math.random before anything else runs.
const lock = lockdownNetwork();
if (!forbidMathRandom()) lock.failed.push('Math.random');

// 2. DECISIONS A1: hash this page's own application code and compare it
//    with the value the build embedded.
const scriptText = document.currentScript ? document.currentScript.textContent : '';
const codeHash = bytesToHex(sha256(new TextEncoder().encode(scriptText)));
const meta = document.querySelector('meta[name="icecold-code-sha256"]');
const expectedHash = meta ? meta.getAttribute('content') : '';
const codeOk = codeHash === expectedHash;

// 3. SPEC §4.3 self-test.
const st = runSelfTest();
if (!codeOk || lock.failed.length > 0) markSelfTest(false);

const allOk = st.passed && codeOk && lock.failed.length === 0 && signingEnabled();

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

const banner = document.getElementById('selftest-banner');
banner.className = allOk ? 'banner ok' : 'banner fail';
banner.textContent = allOk
  ? 'Self-test passed. Signing is available.'
  : 'SELF-TEST FAILED. All signing is disabled. Do not use this file.';

document.getElementById('version').textContent = __BUILD_VERSION__;
document.getElementById('code-hash').textContent = codeHash;
document.getElementById('code-hash-status').textContent = codeOk ? 'matches build' : 'DOES NOT MATCH BUILD';

const table = document.getElementById('selftest-results');
const rows = [
  ...st.results,
  { name: 'application code hash matches build', ok: codeOk },
  { name: `network APIs removed (${lock.removed.length}), Math.random disabled`, ok: lock.failed.length === 0, detail: lock.failed.join(', ') },
];
for (const r of rows) {
  table.append(el('tr', {},
    el('td', {}, r.name),
    el('td', { class: r.ok ? 'ok' : 'fail' }, r.ok ? 'PASS' : 'FAIL'),
    el('td', {}, r.detail || '')));
}

// Read-only status for the automated browser test. No functions exposed.
Object.defineProperty(window, '__icecoldStatus', {
  value: Object.freeze({ selfTestPassed: st.passed, codeOk, signingEnabled: signingEnabled(), lockdownFailed: lock.failed.slice() }),
  writable: false, configurable: false,
});
