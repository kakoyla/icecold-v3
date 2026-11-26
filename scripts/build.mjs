#!/usr/bin/env node
// One-command build (SPEC §7.3): `npm run build` -> two self-contained HTML
// files with all JS and CSS inline and a strict CSP:
//   dist/icecold-v3-offline.html  the offline signer: no network at all
//   dist/icecold-v3-online.html   the Online Builder: only the public XRPL
//                                 servers in src/online/core/config.js (A21)
// Deterministic: no timestamps or machine paths go into the output.
//
// `node scripts/build.mjs --online-test ws://127.0.0.1:PORT` builds only a
// test copy of the Online Builder for that local fake ledger, into dist-test/.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_TARGET, OUT_FILE, ONLINE_TARGET, ONLINE_OUT_FILE, ONLINE_TEST_OUT_FILE } from '../build.config.js';
import { SERVERS } from '../src/online/core/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function buildPage({ entry, template, css, out, target, connect, define = {} }) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target,
    charset: 'utf8',
    minify: false,
    legalComments: 'inline',
    sourcemap: false,
    logLevel: 'warning',
    define: { __BUILD_VERSION__: JSON.stringify(pkg.version), ...define },
  });
  // "</script" inside the bundle would end the inline <script> early.
  const js = result.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
  const cssText = readFileSync(resolve(root, css), 'utf8');
  // SPEC §4.1: default-src 'none'; scripts and styles only by the exact hash
  // of the inline blocks; connections only where `connect` allows.
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${b64(js)}'`,
    `style-src 'sha256-${b64(cssText)}'`,
    `connect-src ${connect}`,
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
  const tpl = readFileSync(resolve(root, template), 'utf8');
  const fill = { CSP: csp, CSS: cssText, JS: js, CODE_SHA256: hex(js) };
  // Single pass, function replacer: inserted text is never re-scanned.
  const html = tpl.replace(/\{\{(CSP|CSS|JS|CODE_SHA256)\}\}/g, (_, k) => fill[k]);
  const path = resolve(root, out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  const fileHash = createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(`${path}.sha256`, `${fileHash}  ${out.split('/').pop()}\n`);
  console.log(`built ${out} (${html.length} bytes, target ${target.join(',')})`);
  console.log(`  code sha256: ${hex(js)}`);
  console.log(`  file sha256: ${fileHash}`);
  return fileHash;
}

const testIdx = process.argv.indexOf('--online-test');
const offlineHash = await buildPage({
  entry: 'src/offline/main.js', template: 'src/offline/index.html', css: 'src/offline/style.css',
  out: OUT_FILE, target: BROWSER_TARGET, connect: "'none'",
});
const online = (servers, out) => buildPage({
  entry: 'src/online/main.js', template: 'src/online/index.html', css: 'src/online/style.css',
  out, target: ONLINE_TARGET, connect: [...servers.mainnet, ...servers.testnet].join(' '),
  // A25: the estate letter quotes the offline file's SHA-256.
  define: { __OFFLINE_SHA256__: JSON.stringify(offlineHash), __TEST_SERVERS__: JSON.stringify(servers === SERVERS ? null : servers) },
});
// Index page for GitHub Pages: links and SHA-256 of both builds. Static
// text only; same CSP rules (no script at all).
function writeIndex(onlineHash) {
  const css = 'body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}code{word-break:break-all}';
  const csp = `default-src 'none'; style-src 'sha256-${b64(css)}'; base-uri 'none'; form-action 'none'`;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICE COLD v3</title><style>${css}</style></head><body>
<h1>ICE COLD v3 ${pkg.version}</h1>
<p><a href="icecold-v3-online.html">Online Builder</a>: use on a normal computer. It never asks for a secret key.<br>
SHA-256: <code>${onlineHash}</code></p>
<p><a href="icecold-v3-offline.html" download>Offline Signer</a>: download it, copy it to a laptop, turn Wi-Fi off, then check its SHA-256 before opening it.<br>
SHA-256: <code>${offlineHash}</code></p>
<p>Check a downloaded file: <code>sha256sum icecold-v3-offline.html</code> (Linux), <code>shasum -a 256 icecold-v3-offline.html</code> (macOS), <code>certutil -hashfile icecold-v3-offline.html SHA256</code> (Windows). Compare every character with your paper log.</p>
<p>Source: <a href="https://github.com/kakoyla/icecold-v3">github.com/kakoyla/icecold-v3</a></p>
</body></html>
`;
  writeFileSync(resolve(root, 'dist/index.html'), html);
}

if (testIdx >= 0) {
  const url = process.argv[testIdx + 1];
  if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url || '')) throw new Error('--online-test needs ws://127.0.0.1:PORT');
  await online({ mainnet: [url], testnet: [url] }, ONLINE_TEST_OUT_FILE);
} else {
  writeIndex(await online(SERVERS, ONLINE_OUT_FILE));
}
