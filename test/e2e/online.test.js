// SPEC §5 Online Builder end to end, against a local fake ledger (no real
// network): build -> offline sign -> submit -> post-checks, plus the secret
// guard, the watch list and printing. Test keys only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
import * as xrpl from 'xrpl';
import { MockLedger } from '../online/mockLedger.js';
import { makeWorld } from '../unit/helpers.js';
import { generateKey } from '../../src/offline/core/keys.js';
import { ONLINE_TEST_OUT_FILE, ONLINE_OUT_FILE, OUT_FILE } from '../../build.config.js';
import {
  FAKE_CAMERA, PAGE_URL, showQrs, vaultFile, openVault, passphraseAndClick, signedBlobs, captureDownload, clickButton,
  readSpareCard, typeSeed, PASS,
} from './harness.js';

const root = resolve(import.meta.dirname, '../..');
const ONLINE_URL = pathToFileURL(resolve(root, ONLINE_TEST_OUT_FILE)).href;
const ENGINES = (process.env.ICECOLD_E2E_ENGINES || 'chromium,firefox').split(',');
const engines = { chromium, firefox };

let ledger;
let wsUrl;
before(async () => {
  ledger = new MockLedger();
  wsUrl = await ledger.listen();
  execFileSync(process.execPath, ['scripts/build.mjs', '--online-test', wsUrl], { cwd: root, stdio: 'pipe' });
});
after(() => ledger.close());

/** Decode every envelope QR part shown by the online page. */
async function readEnvelopeParts(page) {
  const { default: jsQR } = await import('jsqr');
  const total = Number((await page.textContent('.parts')).match(/of (\d+)/)[1]);
  const texts = [];
  for (let i = 0; i < total; i++) {
    const img = await page.evaluate(() => {
      const c = document.querySelector('.qr-holder canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: Array.from(d.data) };
    });
    texts.push(jsQR(Uint8ClampedArray.from(img.data), img.w, img.h).data);
    if (total > 1) await clickButton(page, 'Next');
  }
  return texts;
}

for (const name of ENGINES) {
  describe(`Online Builder in headless ${name}`, () => {
    let browser, online, offline, errors;
    before(async () => {
      browser = await engines[name].launch();
      const ctx = await browser.newContext({ acceptDownloads: true });
      await ctx.addInitScript(FAKE_CAMERA);
      online = await ctx.newPage();
      offline = await ctx.newPage();
      errors = [];
      online.on('pageerror', (e) => errors.push(String(e)));
      await online.goto(ONLINE_URL);
      await online.waitForSelector(`#conn-status:has-text("Connected to ${wsUrl}")`);
    });
    after(async () => { await browser?.close(); });

    async function goHome() {
      const b = online.locator('.screen-head button', { hasText: 'Home' });
      if (await b.count()) await b.first().click();
    }
    async function watch(label, address) {
      await goHome();
      await clickButton(online, 'Watched accounts');
      await online.fill('input[placeholder^="Label, e.g."]', label);
      await online.fill('input[placeholder="r…"]', address);
      await clickButton(online, 'Add');
      await online.waitForSelector(`td:has-text("${address}")`);
    }

    test('the secret guard clears a pasted or typed seed and warns', async () => {
      await clickButton(online, 'Watched accounts');
      const seed = generateKey().seed;
      await online.fill('input[placeholder="r…"]', seed);
      await online.waitForSelector('#secret-warning:not(.hidden)');
      assert.equal(await online.inputValue('input[placeholder="r…"]'), '');
      assert.match(await online.textContent('#secret-warning'), /treat that key as compromised/);
    });

    test('Send & Rotate round trip: build, sign offline, check, submit, post-checks', async () => {
      const W = makeWorld('testnet');
      ledger.addAccount(W.personal.address, { regularKey: W.reg.personal.address, spare: W.spare.personal.address, balance: '100000000' });
      ledger.addAccount(W.friend.address, { flags: 0 });
      await watch('Personal', W.personal.address);
      await watch('Friend', W.friend.address);

      // 1. Build on the online page.
      await goHome();
      await clickButton(online, 'Build an envelope');
      await online.locator('button', { hasText: 'Send & Rotate' }).first().click();
      await online.fill('input[placeholder="From account (r…)"]', W.personal.address);
      await online.fill('input[placeholder="Destination (r…)"]', W.friend.address);
      await online.fill('input[placeholder="e.g. 25.5"]', '3');
      await clickButton(online, 'Build envelope');
      await online.waitForSelector('h2:has-text("Envelope ready")');
      const parts = await readEnvelopeParts(online);
      assert.ok(parts.every((p) => p.startsWith('IC3E:')));

      // 2. Sign on the offline page (fake camera shows the online QR codes).
      await offline.goto(PAGE_URL);
      await offline.waitForFunction(() => window.__icecoldStatus !== undefined);
      await clickButton(offline, 'Scan an envelope');
      await offline.waitForSelector('.scan-status:has-text("Scanning")');
      await showQrs(offline, parts);
      await openVault(offline, await vaultFile(W.vault));
      const dl = await captureDownload(offline, () => passphraseAndClick(offline, 'Make new key, save vault, sign both'));
      await offline.locator('.gate input[type=file]').setInputFiles(dl.path);
      const blobs = await signedBlobs(offline);
      assert.equal(blobs.length, 2);
      const newKey = xrpl.decode(blobs[1]).RegularKey;

      // 3. Submit on the online page (fake camera shows the signed codes, out of order).
      await clickButton(online, 'Next: scan the signed QR codes');
      await online.waitForSelector('.scan-status:has-text("Scanning")');
      await showQrs(online, [blobs[1], blobs[0]]);
      await online.waitForSelector('button:has-text("Submit to the ledger")');
      await clickButton(online, 'Submit to the ledger');
      await online.waitForSelector('.ok-box:has-text("All post-checks passed")', { timeout: 60000 });
      assert.equal(ledger.accounts.get(W.personal.address).RegularKey, newKey);
      assert.deepEqual(ledger.submitted.slice(-2).map((t) => t.TransactionType), ['Payment', 'SetRegularKey']);
      assert.deepEqual(errors, []);
    });

    async function offlineScan(parts) {
      await offline.goto(PAGE_URL);
      await offline.waitForFunction(() => window.__icecoldStatus !== undefined);
      await clickButton(offline, 'Scan an envelope');
      await offline.waitForSelector('.scan-status:has-text("Scanning")');
      await showQrs(offline, parts);
    }
    async function onlineSubmit(blobs) {
      await clickButton(online, 'Next: scan the signed QR codes');
      await online.waitForSelector('.scan-status:has-text("Scanning")');
      await showQrs(online, blobs);
      await clickButton(online, 'Submit to the ledger');
      await online.waitForSelector('.ok-box:has-text("All post-checks passed"), .error-box:has-text("Post-checks failed")', { timeout: 60000 });
      return online.textContent('#screen');
    }

    test('Migration round trip: one kept and one small account; post-checks pass', async () => {
      const shared = generateKey();
      const kept = generateKey();
      const small = generateKey();
      ledger.addAccount(kept.address, { regularKey: shared.address, balance: '80000000' });
      ledger.addAccount(small.address, { regularKey: shared.address, balance: '25000000', sequence: 3 });
      await watch('Kept', kept.address);
      await watch('Small', small.address);
      await goHome();
      await clickButton(online, 'Build an envelope');
      await online.locator('button', { hasText: 'Migration' }).click();
      await online.locator('tr', { hasText: kept.address }).locator('select').selectOption('kept');
      await online.locator('tr', { hasText: small.address }).locator('select').selectOption('small');
      await online.locator('label:has-text("Leftovers") select').selectOption(kept.address);
      await clickButton(online, 'Check accounts and build');
      await online.waitForSelector('h2:has-text("Envelope ready")');
      const parts = await readEnvelopeParts(online);

      await offlineScan(parts);
      await clickButton(offline, 'TESTNET');
      await typeSeed(offline, shared.seed, 'Use this key');
      await offline.locator('input[placeholder^="Label for"]').fill('Kept');
      await clickButton(offline, 'Make the new key and spare');
      const spare = await readSpareCard(offline);
      await clickButton(offline, 'I have written it down');
      await typeSeed(offline, spare, 'Check');
      await offline.locator('input[placeholder^="At least"]').fill(PASS);
      await offline.locator('input[placeholder="Type it again"]').fill(PASS);
      const dl = await captureDownload(offline, () => clickButton(offline, 'Create vault with the new keys'));
      await offline.locator('.gate input[type=file]').setInputFiles(dl.path);
      const blobs = await signedBlobs(offline);
      assert.equal(blobs.length, 3);

      const text = await onlineSubmit(blobs);
      assert.match(text, /All post-checks passed/);
      const k = ledger.accounts.get(kept.address);
      assert.equal(k.RegularKey, xrpl.decode(blobs[1]).RegularKey);
      assert.notEqual(k.RegularKey, shared.address);
      assert.equal(k.signerList.SignerEntries[0].SignerEntry.Account, xrpl.decode(blobs[0]).SignerEntries[0].SignerEntry.Account);
      assert.equal(ledger.accounts.has(small.address), false, 'the small account was deleted');
    });

    test('Recovery round trip: the spare sets a new key; post-check passes', async () => {
      const W = makeWorld('testnet');
      const lost = generateKey();
      ledger.addAccount(W.personal.address, { regularKey: lost.address, spare: W.spare.personal.address });
      await goHome();
      await clickButton(online, 'Build an envelope');
      await online.locator('button', { hasText: 'Recovery' }).click();
      await online.fill('input[placeholder="Account (r…)"]', W.personal.address);
      await clickButton(online, 'Build envelope');
      await online.waitForSelector('h2:has-text("Envelope ready")');
      await offlineScan(await readEnvelopeParts(online));
      await clickButton(offline, 'TESTNET');
      await typeSeed(offline, W.spare.personal.seed, 'Check spare');
      await offline.locator('input[placeholder^="Account label"]').fill('Personal');
      await offline.locator('input[placeholder^="At least"]').fill(PASS);
      await offline.locator('input[placeholder="Type it again"]').fill(PASS);
      const dl = await captureDownload(offline, () => clickButton(offline, 'Make new key, create vault'));
      await offline.locator('.gate input[type=file]').setInputFiles(dl.path);
      const [blob] = await signedBlobs(offline);
      const text = await onlineSubmit([blob]);
      assert.match(text, /All post-checks passed/);
      assert.equal(ledger.accounts.get(W.personal.address).RegularKey, xrpl.decode(blob).RegularKey);
    });

    test('a signed code that differs from what was built is refused', async () => {
      const W = makeWorld('testnet');
      ledger.addAccount(W.personal.address, { regularKey: W.reg.personal.address, spare: W.spare.personal.address });
      await watch('P2', W.personal.address);
      await goHome();
      await clickButton(online, 'Build an envelope');
      await online.locator('button', { hasText: 'Rotate key' }).click();
      await online.fill('input[placeholder="Account (r…)"]', W.personal.address);
      await clickButton(online, 'Build envelope');
      await online.waitForSelector('h2:has-text("Envelope ready")');
      const env = JSON.parse((await readEnvelopeParts(online))[0].replace(/^IC3E:[0-9a-f]{16}:1\/1:/, ''));
      const { signTx } = await import('../../src/offline/core/keys.js');
      const { runSelfTest } = await import('../../src/offline/core/selftest.js');
      runSelfTest();
      const evil = signTx({ ...env.txs[0], RegularKey: generateKey().address, Fee: '999' }, W.reg.personal);
      await clickButton(online, 'Next: scan the signed QR codes');
      await online.waitForSelector('.scan-status:has-text("Scanning")');
      await showQrs(online, [evil.tx_blob]);
      await online.waitForSelector('.error-box:has-text("Fee changed")');
    });

    test('estate: amount is balance - reserve - fee; a destination tag is required by default', async () => {
      const W = makeWorld('testnet');
      ledger.addAccount(W.managed.address, { regularKey: W.reg.managed.address, spare: W.spare.managed.address, balance: '30000000' });
      ledger.addAccount(W.exchange.address, { flags: 0 });
      await goHome();
      await clickButton(online, 'Build an envelope');
      await online.locator('button', { hasText: 'Estate Transfer' }).click();
      await online.fill('input[placeholder^="The account to transfer"]', W.managed.address);
      await online.fill('input[placeholder="Destination (r…)"]', W.exchange.address);
      await clickButton(online, 'Build envelope');
      await online.waitForSelector('.error-box:has-text("destination tag is required")');
      await online.fill('input[placeholder^="Destination tag"]', '123');
      await clickButton(online, 'Build envelope');
      await online.waitForSelector('h2:has-text("Envelope ready")');
      const env = JSON.parse((await readEnvelopeParts(online)).map((p) => p.replace(/^IC3E:[0-9a-f]{16}:\d+\/\d+:/, '')).join(''));
      assert.equal(env.txs[0].Amount, String(30000000n - 1200000n - 24n));
      assert.equal(env.txs[0].DestinationTag, 123);
    });

    test('print: the blank card has 31 boxes; the letter has the offline hash and no secret', async () => {
      await goHome();
      await clickButton(online, 'Print');
      await clickButton(online, 'Blank Spare Key Card');
      await online.fill('input[placeholder^="Account label"]', 'Managed');
      await clickButton(online, 'Make card');
      assert.equal(await online.locator('.spare-blank .box').count(), 31);
      await goHome();
      await clickButton(online, 'Print');
      await clickButton(online, 'Estate letter');
      await online.fill('input[placeholder="Account address (r…)"]', generateKey().address);
      await clickButton(online, 'Make letter');
      const offlineHash = readFileSync(resolve(root, `${OUT_FILE}.sha256`), 'utf8').split(' ')[0];
      const text = await online.textContent('.print-area');
      assert.ok(text.includes(offlineHash), 'the letter quotes the offline SHA-256');
      assert.match(text, /recovery services/);
    });

    test('the watch list is per network and can be cleared', async () => {
      await goHome();
      const before = await online.evaluate(() => Object.keys(localStorage));
      assert.ok(before.every((k) => k === 'icecold-watch-v1-testnet'));
      await clickButton(online, 'MAINNET');
      await online.waitForSelector('#network-banner:has-text("MAINNET")');
      await clickButton(online, 'Watched accounts');
      assert.equal(await online.locator('td.mono').count(), 0, 'mainnet list is separate');
      await clickButton(online, 'TESTNET');
      await clickButton(online, 'Watched accounts');
      online.once('dialog', (d) => d.accept());
      await clickButton(online, 'Clear the testnet list');
      assert.equal(await online.locator('td.mono').count(), 0);
    });
  });
}

describe('published Online Builder build', () => {
  test('its CSP allows only the public XRPL servers, and it has no test server', () => {
    const html = readFileSync(resolve(root, ONLINE_OUT_FILE), 'utf8');
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    const connect = csp.match(/connect-src ([^;]+)/)[1].split(' ');
    assert.deepEqual(connect.sort(), ['wss://s.altnet.rippletest.net:51233', 'wss://s1.ripple.com', 'wss://s2.ripple.com', 'wss://testnet.xrpl-labs.com', 'wss://xrplcluster.com'].sort());
    assert.doesNotMatch(html, /127\.0\.0\.1/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  });
});
