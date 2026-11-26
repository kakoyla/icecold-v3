// SPEC §7.1 / §7.2: every screen driven end to end in headless Chromium and
// Firefox. Test keys only (fresh per run) on testnet. Every signature is
// checked with xrpl.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import * as xrpl from 'xrpl';
import { makeWorld } from '../unit/helpers.js';
import {
  openPage, scanEnvelope, vaultFile, openVault, passphraseAndClick, signedBlobs, decodeFirstQr, xrplVerifies,
  clickButton, captureDownload, noSecretsLeft,
} from './harness.js';

const ENGINES = (process.env.ICECOLD_E2E_ENGINES || 'chromium,firefox').split(',');
const engines = { chromium, firefox };

for (const name of ENGINES) {
  describe(`flows in headless ${name}`, () => {
    let browser, page, errors;
    before(async () => ({ browser, page, errors } = await openPage(engines[name])));
    after(async () => { await browser?.close(); });

    test('sign: scan a Payment envelope, unlock the vault, sign; xrpl.js verifies it', async () => {
      const W = makeWorld('testnet');
      const env = W.envelope('sign', [W.payment()]);
      await scanEnvelope(page, env);
      await page.waitForSelector('text=This sign envelope needs your TESTNET vault');
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('h2:has-text("Review and sign")');
      assert.match(await page.textContent('.summary'), /Send 1 XRP from Personal .* to Friend/);
      assert.equal(await page.textContent('#network-banner'), 'TESTNET');
      await passphraseAndClick(page, 'Sign');
      const [blob] = await signedBlobs(page);
      assert.equal(xrplVerifies(blob), true);
      const tx = xrpl.decode(blob);
      assert.equal(tx.Account, W.personal.address);
      assert.equal(tx.SigningPubKey, W.reg.personal.publicKey);
      assert.equal(await decodeFirstQr(page), blob, 'the QR code holds exactly the signed blob');
      assert.equal(await page.textContent('.signed-item .hash'), xrpl.hashes.hashSignedTx(blob));
      await clickButton(page, 'Done: wipe and lock');
      await page.waitForSelector('text=Vault locked');
      assert.deepEqual(await noSecretsLeft(page), { filledInputs: 0, seedNodes: 0 });
      assert.deepEqual(errors, []);
    });
  });
}
