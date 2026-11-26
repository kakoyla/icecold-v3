// Shared helpers for the end-to-end flow tests (SPEC §7.1, §7.2).
// The fake camera is injected by the test only (Playwright init script); the
// built HTML has no test hook.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import qrcode from 'qrcode-generator';
import * as xrpl from 'xrpl';
import * as xrplKeypairs from 'ripple-keypairs';
import { OUT_FILE } from '../../build.config.js';
import { encryptVault } from '../../src/offline/core/vault.js';
import { frameEnvelope } from '../../src/offline/core/multipart.js';

export const HTML = process.env.ICECOLD_TEST_HTML || resolve(import.meta.dirname, '../..', OUT_FILE);
export const PAGE_URL = pathToFileURL(HTML).href;
export const PASS = 'test passphrase for e2e only';
export const tmp = mkdtempSync(join(tmpdir(), 'icecold-e2e-'));

/** QR module matrix as rows of '0'/'1', for the fake camera. */
export function qrRows(text) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (q.isDark(r, c) ? '1' : '0')).join(''));
}

// Runs in the page before its own script. Replaces getUserMedia with a canvas
// stream that shows whatever QR the test puts up.
export const FAKE_CAMERA = `(() => {
  const W = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = W;
  const ctx = canvas.getContext('2d');
  let rows = null;
  let tick = 0;
  const draw = () => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, W);
    if (rows) {
      const n = rows.length, s = Math.floor((W - 80) / (n + 8)), o = Math.floor((W - n * s) / 2);
      ctx.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (rows[r][c] === '1') ctx.fillRect(o + c * s, o + r * s, s, s);
    }
    ctx.fillStyle = (tick++ % 2) ? '#fefefe' : '#fff'; ctx.fillRect(0, 0, 2, 2);
  };
  setInterval(draw, 50);
  window.__testCam = { show(r) { rows = r; draw(); }, blank() { rows = null; draw(); } };
  const streams = [];
  window.__testCam.liveTracks = () => streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length;
  const gum = async () => { const s = canvas.captureStream(20); streams.push(s); return s; };
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = gum;
  else Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: gum } });
})();`;

export async function openPage(engine, { clock = false } = {}) {
  const browser = await engine.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(FAKE_CAMERA);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (clock) await page.clock.install();
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => window.__icecoldStatus !== undefined, null, { timeout: 30000 });
  return { browser, context, page, errors };
}

/** Show each QR text to the fake camera, one after another. */
export async function showQrs(page, texts, waitMs = 700) {
  for (const t of texts) {
    await page.evaluate((r) => window.__testCam.show(r), qrRows(t));
    await page.waitForTimeout(waitMs);
  }
}

export async function scanEnvelope(page, env, { chunk } = {}) {
  await clickButton(page, 'Scan an envelope');
  await page.waitForSelector('.scan-status:has-text("Scanning")', { timeout: 15000 });
  await showQrs(page, frameEnvelope(JSON.stringify(env), chunk));
}

export const clickButton = (page, text) => page.locator('button', { hasText: text }).first().click();

/** Write a fast (N=2^14) vault file for a payload; returns its path. */
export async function vaultFile(payload, name = `vault-${Date.now()}-${Math.random().toString(36).slice(2)}.json`) {
  const { text } = await encryptVault(payload, PASS, { kdf: { N: 2 ** 14 } });
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}

export async function openVault(page, path) {
  await page.locator('label.file-label:has-text("Vault file") input[type=file]').setInputFiles(path);
  await page.locator('input[placeholder="Vault passphrase"]').first().fill(PASS);
  await clickButton(page, 'Unlock vault');
}

/** Run `action`, capture the download it triggers, save it; returns the path. */
export async function captureDownload(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), action()]);
  const p = join(tmp, `dl-${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(p);
  return { path: p, name: dl.suggestedFilename(), text: readFileSync(p, 'utf8') };
}

export async function passphraseAndClick(page, buttonText) {
  const box = page.locator('.card', { has: page.locator('button', { hasText: buttonText }) }).last();
  await box.locator('input[placeholder="Vault passphrase"]').fill(PASS);
  await box.locator('button', { hasText: buttonText }).click();
}

/** Signed blobs shown on the screen, in order. */
export async function signedBlobs(page) {
  await page.waitForSelector('.signed-item', { timeout: 60000 });
  return page.locator('.signed-item .blob').allTextContents();
}

/** Decode the first signed QR canvas back to text (checks the QR itself). */
export async function decodeFirstQr(page) {
  const { default: jsQR } = await import('jsqr');
  const img = await page.evaluate(() => {
    const c = document.querySelector('.signed-item canvas.qr');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, data: Array.from(d.data) };
  });
  const code = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h);
  return code && code.data;
}

/** Every signature in a blob verifies with xrpl.js (single or multi). */
export function xrplVerifies(blob) {
  const tx = xrpl.decode(blob);
  if (tx.Signers) {
    const { Signers, ...unsigned } = tx;
    return Signers.every(({ Signer }) => xrplKeypairs.verify(
      xrpl.encodeForMultiSigning(unsigned, Signer.Account), Signer.TxnSignature, Signer.SigningPubKey));
  }
  return xrpl.verifySignature(blob);
}

/** Read the displayed spare seed from a Spare Key Card. */
export async function readSpareCard(page) {
  const chars = await page.locator('.spare-card .seed-char').allTextContents();
  return chars.join('');
}

export async function typeSeed(page, seed, buttonText) {
  const entry = page.locator('.seed-entry').last();
  await entry.locator('input.seed-input').fill(seed);
  await entry.locator('button', { hasText: buttonText }).click();
}

export async function noSecretsLeft(page) {
  return page.evaluate(() => ({
    filledInputs: [...document.querySelectorAll('input, textarea')].filter((i) => i.type !== 'checkbox' && i.type !== 'file' && i.value).length,
    seedNodes: document.querySelectorAll('[data-seed]').length,
  }));
}
