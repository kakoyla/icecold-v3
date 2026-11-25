// SPEC §4.3: the self-test runs known vectors; any failure disables signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as xrpl from 'xrpl';
import * as V from '../../src/offline/core/vectors.js';
import { runSelfTest } from '../../src/offline/core/selftest.js';
import { signingEnabled, _resetGateForTests } from '../../src/offline/core/gate.js';
import { signTx, keyFromSeed } from '../../src/offline/core/keys.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

test('vectors: ED25519_TX is reproduced by xrpl.js', () => {
  const r = xrpl.Wallet.fromSeed(V.ED25519_TX.seed).sign(V.ED25519_TX.tx);
  assert.equal(r.tx_blob, V.ED25519_TX.blob);
  assert.equal(r.hash, V.ED25519_TX.hash);
});

test('self-test passes with the built-in vectors and covers every §4.3 item', () => {
  _resetGateForTests();
  const r = runSelfTest();
  assert.equal(r.passed, true, JSON.stringify(r.results));
  const names = r.results.map((x) => x.name).join('\n');
  for (const needle of ['ed25519: seed', 'secp256k1: seed', 'deterministic transaction signature',
    'multisign signature', 'binary codec round-trip']) {
    assert.ok(names.includes(needle), `missing self-test item: ${needle}`);
  }
  assert.equal(signingEnabled(), true);
});

const corruptions = {
  'wrong derived address': (v) => { v.DERIVATION[1].address = v.DERIVATION[0].address; },
  'wrong secp256k1 tx signature': (v) => { v.SECP_TX.blob = v.SECP_TX.blob.replace(/.$/, '0'); },
  'wrong ed25519 tx hash': (v) => { v.ED25519_TX.hash = '00'.repeat(32); },
  'wrong multisign blob': (v) => { v.MULTISIGN_TX.blob = v.MULTISIGN_TX.blob.slice(0, -2) + 'F2'; },
};

for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`a failing vector (${name}) disables signing`, () => {
    _resetGateForTests();
    const v = clone(V);
    corrupt(v);
    const r = runSelfTest(v);
    assert.equal(r.passed, false);
    assert.equal(signingEnabled(), false);
    assert.throws(() => signTx(V.ED25519_TX.tx, keyFromSeed(V.ED25519_TX.seed)), /Signing disabled/);
  });
}

test('once failed, a later passing self-test cannot re-enable signing', () => {
  _resetGateForTests();
  const v = clone(V);
  v.DERIVATION[0].signature = '00';
  runSelfTest(v);
  runSelfTest();
  assert.equal(signingEnabled(), false);
});
