#!/usr/bin/env node
// One-command build (SPEC §7.3): `npm run build` -> one self-contained HTML
// with all JS and CSS inline and a CSP that blocks every network request.
// Deterministic: no timestamps or machine paths go into the output.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_TARGET, OUT_FILE } from '../build.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/offline/main.js'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: BROWSER_TARGET,
  charset: 'utf8',
  minify: false,
  legalComments: 'inline',
  sourcemap: false,
  logLevel: 'warning',
  define: { __BUILD_VERSION__: JSON.stringify(pkg.version) },
});

// "</script" inside the bundle would end the inline <script> early.
const js = result.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
const css = readFileSync(resolve(root, 'src/offline/style.css'), 'utf8');

const b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// SPEC §4.1: connect-src 'none' and no remote scripts, images or fonts.
// default-src 'none' covers everything not listed; scripts and styles are
// allowed only by the exact hash of the inline blocks below.
const csp = [
  "default-src 'none'",
  `script-src 'sha256-${b64(js)}'`,
  `style-src 'sha256-${b64(css)}'`,
  "connect-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const template = readFileSync(resolve(root, 'src/offline/index.html'), 'utf8');
const fill = { CSP: csp, CSS: css, JS: js, CODE_SHA256: hex(js) };
// Single pass, function replacer: inserted text is never re-scanned or
// interpreted ($ patterns in the bundle stay literal).
const html = template.replace(/\{\{(CSP|CSS|JS|CODE_SHA256)\}\}/g, (_, k) => fill[k]);

const out = resolve(root, OUT_FILE);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
const fileHash = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(`${out}.sha256`, `${fileHash}  ${OUT_FILE.split('/').pop()}\n`);

console.log(`built ${OUT_FILE} (${html.length} bytes, target ${BROWSER_TARGET.join(',')})`);
console.log(`code sha256: ${hex(js)}`);
console.log(`file sha256: ${fileHash}`);
