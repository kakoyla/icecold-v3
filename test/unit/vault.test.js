// SPEC §7.1: vault round-trip; a wrong passphrase fails, tampering fails, a
// mismatched network fails. Plus §4.2 rules (no spares, per-network files).
// Keys here are generated fresh per run; address-book entries are public
// xrpl.js test-vector addresses.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as Vt from '../../src/offline/core/vault.js';
import { generateKey } from '../../src/offline/core/keys.js';
import { DERIVATION } from '../../src/offline/core/vectors.js';

const FAST = { kdf: { N: 2 ** 14 } };
const PASS = 'correct horse battery staple';

function samplePayload(network = 'testnet') {
  const p = Vt.emptyPayload(network);
  const acct = generateKey();
  p.accounts.push({
    label: 'Test account A',
    address: acct.address,
    regularKey: Vt.storedKey(generateKey()),
    pendingKey: null,
    retiredKeys: [generateKey().address],
    addressBook: [{ label: 'Test exchange', address: DERIVATION[0].address, isExchange: true, requiresTag: true }],
  });
  return p;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (e) => e instanceof Vt.VaultError && e.code === code, `expected VaultError ${code}`);
}

function flipHexChar(hex, idx) {
  const c = hex[idx];
  return hex.slice(0, idx) + (c === '0' ? '1' : '0') + hex.slice(idx + 1);
}

describe('vault', () => {
  test('round-trip: encrypt then decrypt returns the same payload', async () => {
    const p = samplePayload();
    const { text } = await Vt.encryptVault(p, PASS, FAST);
    assert.deepEqual(await Vt.decryptVault(text, PASS, 'testnet'), p);
  });

  test('file is not plaintext: no seed or address appears in it', async () => {
    const p = samplePayload();
    const { text } = await Vt.encryptVault(p, PASS, FAST);
    assert.ok(!text.includes(p.accounts[0].regularKey.seed));
    assert.ok(!text.includes(p.accounts[0].address));
  });

  test('wrong passphrase fails', async () => {
    const { text } = await Vt.encryptVault(samplePayload(), PASS, FAST);
    await rejectsWith(Vt.decryptVault(text, PASS + '!', 'testnet'), 'decrypt');
  });

  test('tampered ciphertext fails', async () => {
    const { text } = await Vt.encryptVault(samplePayload(), PASS, FAST);
    const f = JSON.parse(text);
    f.ciphertext = flipHexChar(f.ciphertext, 10);
    await rejectsWith(Vt.decryptVault(JSON.stringify(f), PASS, 'testnet'), 'decrypt');
  });

  test('tampered GCM tag (last bytes) fails', async () => {
    const { text } = await Vt.encryptVault(samplePayload(), PASS, FAST);
    const f = JSON.parse(text);
    f.ciphertext = flipHexChar(f.ciphertext, f.ciphertext.length - 1);
    await rejectsWith(Vt.decryptVault(JSON.stringify(f), PASS, 'testnet'), 'decrypt');
  });

  for (const [field, mutate] of [
    ['createdAt', (f) => { f.createdAt = '2000-01-01T00:00:00.000Z'; }],
    ['salt', (f) => { f.salt = flipHexChar(f.salt, 0); }],
    ['nonce', (f) => { f.cipher.nonce = flipHexChar(f.cipher.nonce, 0); }],
    ['kdf.N', (f) => { f.kdf.N = 2 ** 15; }],
  ]) {
    test(`tampered header (${field}) fails`, async () => {
      const { text } = await Vt.encryptVault(samplePayload(), PASS, FAST);
      const f = JSON.parse(text);
      mutate(f);
      await rejectsWith(Vt.decryptVault(JSON.stringify(f), PASS, 'testnet'), 'decrypt');
    });
  }

  test('relabelling a testnet vault as mainnet fails to decrypt', async () => {
    const { text } = await Vt.encryptVault(samplePayload('testnet'), PASS, FAST);
    const f = JSON.parse(text);
    f.network = 'mainnet';
    await rejectsWith(Vt.decryptVault(JSON.stringify(f), PASS, 'mainnet'), 'decrypt');
  });

  test('mismatched network fails: a testnet vault cannot be opened as mainnet, and the reverse', async () => {
    const t = await Vt.encryptVault(samplePayload('testnet'), PASS, FAST);
    await rejectsWith(Vt.decryptVault(t.text, PASS, 'mainnet'), 'network');
    const m = await Vt.encryptVault(samplePayload('mainnet'), PASS, FAST);
    await rejectsWith(Vt.decryptVault(m.text, PASS, 'testnet'), 'network');
  });

  test('payload network must match header network', () => {
    assert.throws(() => Vt.validatePayload(samplePayload('testnet'), 'mainnet'), (e) => e.code === 'network');
  });

  test('spares are never stored: any spare field is refused', async () => {
    const p = samplePayload();
    p.accounts[0].spareKey = Vt.storedKey(generateKey());
    await assert.rejects(Vt.encryptVault(p, PASS, FAST), (e) => e.code === 'spare');
  });

  test('unknown fields are refused anywhere in the payload', () => {
    const p = samplePayload();
    p.accounts[0].addressBook[0].note = 'x';
    assert.throws(() => Vt.validatePayload(p), (e) => e.code === 'schema');
  });

  test('a seed that does not derive the stored address is refused', () => {
    const p = samplePayload();
    p.accounts[0].regularKey.address = generateKey().address;
    assert.throws(() => Vt.validatePayload(p), /does not derive/);
  });

  test('file name is icecold-vault-<network>-<timestamp>.json', async () => {
    const { filename } = await Vt.encryptVault(samplePayload('testnet'), PASS,
      { ...FAST, now: new Date('2026-11-25T21:05:09.123Z') });
    assert.equal(filename, 'icecold-vault-testnet-20261125T210509Z.json');
  });

  test('short passphrase is refused', async () => {
    await assert.rejects(Vt.encryptVault(samplePayload(), 'short', FAST), (e) => e.code === 'passphrase');
  });

  test('KDF parameters outside the allowed range are refused', async () => {
    await assert.rejects(Vt.encryptVault(samplePayload(), PASS, { kdf: { N: 2 ** 10 } }), (e) => e.code === 'kdf');
  });

  test('default KDF is scrypt N=2^17, r=8, p=1 and round-trips', async () => {
    const { text } = await Vt.encryptVault(samplePayload(), PASS);
    const f = JSON.parse(text);
    assert.deepEqual(f.kdf, { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, dkLen: 32 });
    assert.equal(f.cipher.name, 'aes-256-gcm');
    assert.equal((await Vt.decryptVault(text, PASS, 'testnet')).accounts.length, 1);
  });

  test('confirmPendingSaved (SPEC §4.5 gate) finds the pending key only when present', async () => {
    const p = samplePayload();
    const pending = generateKey();
    const without = await Vt.encryptVault(p, PASS, FAST);
    p.accounts[0].pendingKey = Vt.storedKey(pending);
    const withIt = await Vt.encryptVault(p, PASS, FAST);
    const addr = p.accounts[0].address;
    assert.equal(await Vt.confirmPendingSaved(withIt.text, PASS, 'testnet', addr, pending.address), true);
    assert.equal(await Vt.confirmPendingSaved(without.text, PASS, 'testnet', addr, pending.address), false);
    await rejectsWith(Vt.confirmPendingSaved(withIt.text, 'wrong passphrase!!', 'testnet', addr, pending.address), 'decrypt');
  });
});
