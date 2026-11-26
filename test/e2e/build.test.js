// SPEC §7.3: the single HTML is built from source by one command, and the
// build is reproducible (same source -> same SHA-256).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { OUT_FILE } from '../../build.config.js';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, OUT_FILE);
const sha = () => createHash('sha256').update(readFileSync(out)).digest('hex');

test('two builds from the same source produce byte-identical HTML', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  const first = sha();
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  assert.equal(sha(), first);
  assert.equal(readFileSync(`${out}.sha256`, 'utf8').split(' ')[0], first);
});

test('the HTML is self-contained: no external script, style, image or font references', () => {
  const html = readFileSync(out, 'utf8');
  assert.equal((html.match(/<script>/g) || []).length, 1);
  // Check the page markup, not the text inside the inline script (a bundled
  // library has an unused createImgTag() that builds "<img src=" as a string;
  // the CSP's img-src 'none' would block it anyway).
  const markup = html.replace(/<script>[\s\S]*<\/script>/, '<script></script>');
  assert.doesNotMatch(markup, /<script[^>]+src=/i);
  assert.doesNotMatch(markup, /<link[^>]+href=/i);
  assert.doesNotMatch(markup, /<img[^>]+src=/i);
  assert.doesNotMatch(html, /\/home\/|\\Users\\|C:\\/, 'no build-machine paths in the output');
});

test('the Online Builder build is reproducible and self-contained too', async () => {
  const { ONLINE_OUT_FILE } = await import('../../build.config.js');
  const p = resolve(root, ONLINE_OUT_FILE);
  const h = () => createHash('sha256').update(readFileSync(p)).digest('hex');
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  const first = h();
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  assert.equal(h(), first);
  assert.equal(readFileSync(`${p}.sha256`, 'utf8').split(' ')[0], first);
  const markup = readFileSync(p, 'utf8').replace(/<script>[\s\S]*<\/script>/, '<script></script>');
  assert.doesNotMatch(markup, /<script[^>]+src=|<link[^>]+href=|<img[^>]+src=/i);
});
