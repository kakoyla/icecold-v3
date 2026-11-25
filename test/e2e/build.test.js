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
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /<img[^>]+src=/i);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.doesNotMatch(html, /\/home\/|\\Users\\|C:\\/, 'no build-machine paths in the output');
});
