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
  clickButton, captureDownload, noSecretsLeft, showQrs, readSpareCard, typeSeed, PASS, PAGE_URL,
} from './harness.js';
import { frameEnvelope } from '../../src/offline/core/multipart.js';
import { decryptVault } from '../../src/offline/core/vault.js';
import { generateKey } from '../../src/offline/core/keys.js';
import { ALPHABET } from '../../src/offline/core/seedrepair.js';

const srk = (W, acct, extra = {}) => W.base(acct, { TransactionType: 'SetRegularKey', ...extra });
const sls = (W, acct, extra = {}) => W.base(acct, { TransactionType: 'SignerListSet', SignerQuorum: 1, ...extra });
const typo = (seed, i = 12) => seed.slice(0, i) + ALPHABET[(ALPHABET.indexOf(seed[i]) + 1) % ALPHABET.length] + seed.slice(i + 1);

const ENGINES = (process.env.ICECOLD_E2E_ENGINES || 'chromium,firefox').split(',');
const engines = { chromium, firefox };

for (const name of ENGINES) {
  describe(`flows in headless ${name}`, () => {
    let browser, page, errors;
    before(async () => ({ browser, page, errors } = await openPage(engines[name])));
    after(async () => { await browser?.close(); });
    const fresh = async () => {
      await page.goto(PAGE_URL);
      await page.waitForFunction(() => window.__icecoldStatus !== undefined);
    };

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

    test('envelope in 4 parts, scanned out of order; a part of another envelope is refused', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const env = W.envelope('sign', [W.payment({ Amount: '2500000' })]);
      const parts = frameEnvelope(JSON.stringify(env), Math.ceil(JSON.stringify(env).length / 4));
      assert.equal(parts.length, 4);
      const other = frameEnvelope(JSON.stringify({ ...env, purpose: 'rotate' }), Math.ceil(JSON.stringify(env).length / 4));
      await clickButton(page, 'Scan an envelope');
      await page.waitForSelector('.scan-status:has-text("Scanning")');
      await showQrs(page, [parts[2], parts[0]]);
      assert.match(await page.textContent('.parts'), /Scanned 2 of 4\. Still needed: part 2, 4/);
      await showQrs(page, [other[1]]);
      assert.match(await page.textContent('.error-box'), /different envelope/);
      await showQrs(page, [parts[3], parts[1], parts[0], parts[2]]);
      await page.waitForSelector('text=This sign envelope needs your TESTNET vault');
    });

    test('a mainnet envelope is refused by a testnet vault', async () => {
      await fresh();
      const W = makeWorld('testnet');
      await clickButton(page, 'Open vault');
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('text=Vault unlocked');
      await scanEnvelope(page, W.envelope('sign', [W.payment()], { network: 'mainnet' }));
      await page.waitForSelector('text=This envelope is for MAINNET but the open vault is TESTNET');
      assert.equal(await page.textContent('#network-banner'), 'MAINNET');
    });

    test('a ledger key matching neither vault key blocks signing and points to Recovery', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const env = W.envelope('sign', [W.payment()]);
      env.ledger = { ...env.ledger, [W.personal.address]: W.snapshot(generateKey().address, W.spare.personal.address) };
      await scanEnvelope(page, env);
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('h2:has-text("Signing blocked")');
      assert.match(await page.textContent('.error-box'), /Use Recovery/);
    });

    test('unsafe envelope (fee over the cap) is refused with the reason', async () => {
      await fresh();
      const W = makeWorld('testnet');
      await scanEnvelope(page, W.envelope('sign', [W.payment({ Fee: '5000' })]));
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('h2:has-text("Cannot sign")');
      assert.match(await page.textContent('#screen'), /over the cap/);
    });

    test('first-time destination: needs confirmation; adding it saves a new vault', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const dest = generateKey().address;
      await scanEnvelope(page, W.envelope('sign', [W.payment({ Destination: dest, DestinationTag: 9 })]));
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('h3:has-text("New destination")');
      await passphraseAndClick(page, 'Sign');
      await page.waitForSelector('text=Confirm the new destination first');
      const card = page.locator('.first-time');
      await card.locator('label:has-text("character by character") input').check();
      await card.locator('label:has-text("Add it to the address book") input').check();
      await card.locator('input[placeholder^="Label"]').fill('New exchange');
      await card.locator('label:has-text("exchange") input').first().check();
      const dl = await captureDownload(page, () => passphraseAndClick(page, 'Sign'));
      const blobs = await signedBlobs(page);
      assert.equal(xrplVerifies(blobs[0]), true);
      const saved = await decryptVault(dl.text, PASS, 'testnet');
      assert.deepEqual(saved.accounts[0].addressBook.at(-1), { label: 'New exchange', address: dest, isExchange: true, requiresTag: false });
    });

    test('acks: an unknown field must be acknowledged before signing', async () => {
      await fresh();
      const W = makeWorld('testnet');
      await scanEnvelope(page, W.envelope('sign', [W.payment({ Memos: [{ Memo: { MemoData: '41' } }] })]));
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('h3:has-text("Check these before signing")');
      await passphraseAndClick(page, 'Sign');
      await page.waitForSelector('text=Tick or type every item');
      await page.locator('.acks input[type=checkbox]').check();
      await passphraseAndClick(page, 'Sign');
      assert.equal(xrplVerifies((await signedBlobs(page))[0]), true);
    });

    test('markup inside an envelope is shown as text, never as HTML', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const evil = '<b id="pwn">x</b><img src=x>';
      const hex = Buffer.from(evil).toString('hex').toUpperCase();
      await scanEnvelope(page, W.envelope('sign', [W.base(W.personal.address, { TransactionType: 'AccountSet', Domain: hex, Memos: evil })]));
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('h2:has-text("Review and sign")');
      assert.equal(await page.locator('#pwn').count(), 0);
      assert.equal(await page.locator('#screen img').count(), 0);
      assert.match(await page.textContent('.summary'), /domain: <b id="pwn">/);
    });

    test('send & rotate: new key saved as pending, gate refuses the old file, then both are signed', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const oldVault = await vaultFile(W.vault);
      const env = W.envelope('send-rotate', [W.payment({ Sequence: 10 }), srk(W, W.personal.address, { Sequence: 11 })]);
      await scanEnvelope(page, env);
      await openVault(page, oldVault);
      await page.waitForSelector('h2:has-text("Send & Rotate")');
      const dl = await captureDownload(page, () => passphraseAndClick(page, 'Make new key, save vault, sign both'));
      await page.waitForSelector('h3:has-text("Check the saved vault")');
      assert.equal(await page.locator('.signed-item').count(), 0, 'nothing is shown before the gate passes');
      await page.locator('.gate input[type=file]').setInputFiles(oldVault);
      await page.waitForSelector('.gate .error-box:has-text("does not contain the new key")');
      await page.locator('.gate input[type=file]').setInputFiles(dl.path);
      const blobs = await signedBlobs(page);
      assert.equal(blobs.length, 2);
      const saved = await decryptVault(dl.text, PASS, 'testnet');
      const pending = saved.accounts[0].pendingKey.address;
      const [pay, rot] = blobs.map((b) => xrpl.decode(b));
      assert.equal(pay.TransactionType, 'Payment');
      assert.equal(rot.TransactionType, 'SetRegularKey');
      assert.equal(rot.RegularKey, pending);
      assert.equal(rot.Sequence, 11);
      for (const b of blobs) { assert.equal(xrplVerifies(b), true); assert.equal(xrpl.decode(b).SigningPubKey, W.reg.personal.publicKey); }
      assert.equal(await page.textContent('.big-address .big'), `${pending.slice(0, 6)} … ${pending.slice(-6)}`);
    });

    test('next signing promotes the pending key once the ledger shows it', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const next = generateKey();
      const vault = structuredClone(W.vault);
      vault.accounts[0].pendingKey = { algorithm: next.algorithm, seed: next.seed, publicKey: next.publicKey, address: next.address };
      const env = W.envelope('sign', [W.payment()]);
      env.ledger = { ...env.ledger, [W.personal.address]: W.snapshot(next.address, W.spare.personal.address) };
      await scanEnvelope(page, env);
      await openVault(page, await vaultFile(vault));
      await page.waitForSelector('text=rotation of');
      const dl = await captureDownload(page, () => passphraseAndClick(page, 'Sign'));
      const [blob] = await signedBlobs(page);
      assert.equal(xrpl.decode(blob).SigningPubKey, next.publicKey, 'signed with the promoted key');
      const saved = await decryptVault(dl.text, PASS, 'testnet');
      assert.equal(saved.accounts[0].regularKey.address, next.address);
      assert.equal(saved.accounts[0].pendingKey, null);
      assert.deepEqual(saved.accounts[0].retiredKeys, [W.reg.personal.address]);
    });

    test('recovery with no vault: confirm network, repair a typo in the spare, new vault, gate, multisign', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const env = W.envelope('recovery', [srk(W, W.personal.address, { SigningPubKey: '', Fee: '24' })]);
      await scanEnvelope(page, env);
      await clickButton(page, 'MAINNET');
      await page.waitForSelector('text=not MAINNET');
      await clickButton(page, 'TESTNET');
      await page.waitForSelector('h2:has-text("Recovery")');
      await typeSeed(page, typo(W.spare.personal.seed), 'Check spare');
      await page.waitForSelector('.candidate.match');
      await page.locator('.candidate.match button').click();
      await page.waitForSelector(`text=Spare confirmed: ${W.spare.personal.address}`);
      await page.locator('input[placeholder^="Account label"]').fill('Personal');
      await page.locator('input[placeholder^="At least"]').fill(PASS);
      await page.locator('input[placeholder="Type it again"]').fill(PASS);
      const dl = await captureDownload(page, () => clickButton(page, 'Make new key, create vault'));
      await page.locator('.gate input[type=file]').setInputFiles(dl.path);
      const [blob] = await signedBlobs(page);
      const tx = xrpl.decode(blob);
      assert.equal(tx.Signers.length, 1);
      assert.equal(tx.Signers[0].Signer.Account, W.spare.personal.address);
      assert.equal(xrplVerifies(blob), true);
      const saved = await decryptVault(dl.text, PASS, 'testnet');
      assert.equal(saved.accounts[0].label, 'Personal');
      assert.equal(saved.accounts[0].pendingKey.address, tx.RegularKey);
      assert.match(await page.textContent('#screen'), /Your spare is now used/);
    });

    test('recovery refuses a spare that is not in the signer list', async () => {
      await fresh();
      const W = makeWorld('testnet');
      await scanEnvelope(page, W.envelope('recovery', [srk(W, W.personal.address, { SigningPubKey: '', Fee: '24' })]));
      await clickButton(page, 'TESTNET');
      await typeSeed(page, W.spare.managed.seed, 'Check spare');
      await page.waitForSelector('h2:has-text("Recovery stopped")');
    });

    test('estate: no vault, network confirmed, summary checked twice, spare signs', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const env = W.envelope('estate', [W.payment({ SigningPubKey: '', Fee: '24', DestinationTag: 77, Destination: W.exchange.address })]);
      await scanEnvelope(page, env);
      await clickButton(page, 'TESTNET');
      await page.waitForSelector('h2:has-text("Estate Transfer")');
      assert.equal(await page.locator('.seed-entry').isVisible(), false, 'spare entry is hidden until both checks');
      await page.locator('label:has-text("it is what I expect") input').check();
      await page.locator('label:has-text("a second time") input').check();
      await typeSeed(page, W.spare.personal.seed, 'Check spare and sign');
      const [blob] = await signedBlobs(page);
      const tx = xrpl.decode(blob);
      assert.equal(tx.DestinationTag, 77);
      assert.equal(tx.Signers[0].Signer.Account, W.spare.personal.address);
      assert.equal(xrplVerifies(blob), true);
    });

    test('replace spare: card shown, typed back, signed; the seed is gone from the page', async () => {
      await fresh();
      const W = makeWorld('testnet');
      await scanEnvelope(page, W.envelope('replace-spare', [sls(W, W.personal.address)]));
      await openVault(page, await vaultFile(W.vault));
      await clickButton(page, 'Generate the new spare');
      const seed = await readSpareCard(page);
      assert.match(seed, /^sEd/);
      const spareAddr = (await page.textContent('.spare-card strong.mono')).trim();
      await clickButton(page, 'I have written it down');
      assert.equal(await page.locator('.spare-card').count(), 0);
      await typeSeed(page, typo(seed), 'Check');
      await page.waitForSelector('.candidate');
      await typeSeed(page, seed, 'Check');
      await passphraseAndClick(page, 'Sign');
      const [blob] = await signedBlobs(page);
      const tx = xrpl.decode(blob);
      assert.deepEqual(tx.SignerEntries, [{ SignerEntry: { Account: spareAddr, SignerWeight: 1 } }]);
      assert.equal(xrplVerifies(blob), true);
      assert.equal(await page.evaluate((s) => document.body.textContent.includes(s), seed), false);
    });

    test('migration: shared key, label, spare, new vault with pending key, gate, three signed in order', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const shared = generateKey();
      const small = generateKey();
      const env = W.envelope('migration', [
        sls(W, W.personal.address, { Sequence: 10 }),
        srk(W, W.personal.address, { Sequence: 11 }),
        W.base(small.address, { TransactionType: 'AccountDelete', Destination: W.personal.address, Fee: '200000' }),
      ]);
      env.ledger = { [W.personal.address]: W.snapshot(shared.address, null), [small.address]: W.snapshot(shared.address, null) };
      await scanEnvelope(page, env);
      await clickButton(page, 'TESTNET');
      await page.waitForSelector('h3:has-text("Step 1: the shared regular key")');
      await typeSeed(page, generateKey().seed, 'Use this key');
      await page.waitForSelector('text=is not the regular key of');
      await typeSeed(page, shared.seed, 'Use this key');
      await page.locator('input[placeholder^="Label for"]').fill('Personal');
      await clickButton(page, 'Make the new key and spare');
      const seed = await readSpareCard(page);
      await clickButton(page, 'I have written it down');
      await typeSeed(page, seed, 'Check');
      await page.waitForSelector('h2:has-text("save the vault")');
      await page.locator('input[placeholder^="At least"]').fill(PASS);
      await page.locator('input[placeholder="Type it again"]').fill(PASS);
      const dl = await captureDownload(page, () => clickButton(page, 'Create vault with the new keys'));
      await page.locator('.gate input[type=file]').setInputFiles(dl.path);
      const blobs = await signedBlobs(page);
      assert.deepEqual(blobs.map((b) => xrpl.decode(b).TransactionType), ['SignerListSet', 'SetRegularKey', 'AccountDelete']);
      for (const b of blobs) { assert.equal(xrplVerifies(b), true); assert.equal(xrpl.decode(b).SigningPubKey, shared.publicKey); }
      const saved = await decryptVault(dl.text, PASS, 'testnet');
      assert.equal(saved.accounts.length, 1);
      assert.equal(saved.accounts[0].pendingKey.address, xrpl.decode(blobs[1]).RegularKey);
      assert.equal(xrpl.decode(blobs[0]).SignerEntries[0].SignerEntry.Account.length > 0, true);
      assert.equal(await page.evaluate((s) => document.body.textContent.includes(s), shared.seed), false);
    });

    test('leaving the scan screen turns the camera off', async () => {
      await fresh();
      await clickButton(page, 'Scan an envelope');
      await page.waitForSelector('.scan-status:has-text("Scanning")');
      assert.equal(await page.evaluate(() => window.__testCam.liveTracks()), 1);
      await clickButton(page, 'Home');
      assert.equal(await page.evaluate(() => window.__testCam.liveTracks()), 0);
    });

    test('migration: the shared key can be scanned from paper instead of typed', async () => {
      await fresh();
      const W = makeWorld('testnet');
      const shared = generateKey();
      const env = W.envelope('migration', [sls(W, W.personal.address, { Sequence: 10 }), srk(W, W.personal.address, { Sequence: 11 })]);
      env.ledger = { [W.personal.address]: W.snapshot(shared.address, null) };
      await scanEnvelope(page, env);
      await clickButton(page, 'TESTNET');
      await clickButton(page, 'Scan the shared key from paper');
      await page.waitForSelector('.scan-status:has-text("Scanning")');
      await showQrs(page, [shared.seed]);
      await page.waitForSelector(`text=Shared key confirmed: ${shared.address}`);
      assert.equal(await page.evaluate(() => window.__testCam.liveTracks()), 0, 'camera stopped after the scan');
    });

    test('vault screen: rename an account and add a destination, then save a new file', async () => {
      await fresh();
      const W = makeWorld('testnet');
      await clickButton(page, 'Open vault');
      await openVault(page, await vaultFile(W.vault));
      await clickButton(page, 'Vault: accounts and address book');
      const card = page.locator('.card', { hasText: W.managed.address }).first();
      await card.locator('label.field input').fill('Managed (renamed)');
      const dest = generateKey().address;
      await card.locator('input[placeholder="Label"]').fill('Savings');
      await card.locator('input[placeholder="r…"]').fill(dest);
      await card.locator('label:has-text("needs tag") input').check();
      await card.locator('button', { hasText: 'Add destination' }).click();
      await page.waitForSelector('text=Changes are not saved yet');
      await clickButton(page, 'Save a new vault file');
      const dl = await captureDownload(page, () => passphraseAndClick(page, 'Save vault'));
      const saved = await decryptVault(dl.text, PASS, 'testnet');
      const m = saved.accounts.find((a) => a.address === W.managed.address);
      assert.equal(m.label, 'Managed (renamed)');
      assert.deepEqual(m.addressBook, [{ label: 'Savings', address: dest, isExchange: false, requiresTag: true }]);
    });

    test('tools: generate keypair, decode/verify (valid and garbage), seed repair', async () => {
      await fresh();
      await clickButton(page, 'Generate keypair');
      await clickButton(page, 'Ed25519');
      assert.match(await readSpareCard(page), /^sEd/);
      await clickButton(page, 'I have written it down');
      assert.equal(await page.locator('.spare-card').count(), 0);
      await clickButton(page, 'Home');
      await clickButton(page, 'Decode / verify');
      const { SECP_TX } = await import('../../src/offline/core/vectors.js');
      await page.fill('textarea', SECP_TX.blob);
      await clickButton(page, 'Decode and verify');
      await page.waitForSelector('.ok-box:has-text("Signature valid")');
      await page.fill('textarea', 'not hex at all');
      await clickButton(page, 'Decode and verify');
      await page.waitForSelector('.error-box:has-text("Not a transaction")');
      await clickButton(page, 'Home');
      await clickButton(page, 'Seed repair');
      const k = generateKey();
      await typeSeed(page, typo(k.seed), 'Check seed');
      await page.waitForSelector(`.candidate:has-text("${k.address}")`);
    });

    test('new vault: choose network, passphrase twice, saved as a download', async () => {
      await fresh();
      await clickButton(page, 'New vault');
      await clickButton(page, 'TESTNET');
      await page.locator('input[placeholder^="At least"]').fill('short');
      await page.locator('input[placeholder="Type it again"]').fill('short');
      await clickButton(page, 'Create vault');
      await page.waitForSelector('text=at least 12 characters');
      await page.locator('input[placeholder^="At least"]').fill(PASS);
      await page.locator('input[placeholder="Type it again"]').fill(PASS);
      const dl = await captureDownload(page, () => clickButton(page, 'Create vault'));
      assert.match(dl.name, /^icecold-vault-testnet-\d{8}T\d{6}Z\.json$/);
      assert.deepEqual((await decryptVault(dl.text, PASS, 'testnet')).accounts, []);
      await page.waitForSelector('text=Vault open');
      assert.deepEqual(errors, []);
    });
  });
}

describe('idle lock (DECISIONS A17)', () => {
  test('countdown in the last minute, then lock and wipe', async () => {
    const { browser, page } = await openPage(chromium, { clock: true });
    try {
      const W = makeWorld('testnet');
      await clickButton(page, 'Open vault');
      await openVault(page, await vaultFile(W.vault));
      await page.waitForSelector('text=Vault unlocked');
      await page.clock.runFor(4 * 60 * 1000 + 5000);
      await page.waitForSelector('#idle-warning:not(.hidden)');
      assert.match(await page.textContent('#idle-warning'), /Locking in \d+ s/);
      await page.clock.runFor(60 * 1000);
      await page.waitForSelector('text=Locked after 5 minutes idle');
      assert.equal(await page.locator('text=/^Vault open:/').count(), 0);
      assert.deepEqual(await noSecretsLeft(page), { filledInputs: 0, seedNodes: 0 });
    } finally {
      await browser.close();
    }
  });
});
