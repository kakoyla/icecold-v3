// SPEC §7.1: key derivation and signing vectors for both algorithms; every
// signature v3 produces is verified by xrpl.js; multisign checked against
// xrpl.multisign.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import * as xrpl from 'xrpl';
import * as keypairs from 'ripple-keypairs';
import * as K from '../../src/offline/core/keys.js';
import * as V from '../../src/offline/core/vectors.js';
import { runSelfTest } from '../../src/offline/core/selftest.js';
import { signingEnabled } from '../../src/offline/core/gate.js';

describe('gate before self-test', () => {
  test('signTx and multisignTx refuse to run before the self-test passes', () => {
    assert.equal(signingEnabled(), false);
    const key = K.keyFromSeed(V.ED25519_TX.seed);
    assert.throws(() => K.signTx(V.ED25519_TX.tx, key), /Signing disabled/);
    assert.throws(() => K.multisignTx(V.MULTISIGN_TX.tx, key), /Signing disabled/);
  });
});

describe('keys (after self-test)', () => {
  before(() => {
    const r = runSelfTest();
    assert.equal(r.passed, true, JSON.stringify(r.results));
  });

  for (const d of V.DERIVATION) {
    test(`${d.algorithm}: seed derives the xrpl.js fixture keypair and address`, () => {
      const k = K.keyFromSeed(d.seed);
      assert.equal(k.algorithm, d.algorithm);
      assert.equal(k.publicKey, d.publicKey);
      assert.equal(k.privateKey, d.privateKey);
      assert.equal(k.address, d.address);
      assert.equal(xrpl.Wallet.fromSeed(d.seed).classicAddress, d.address);
    });
    test(`${d.algorithm}: message signature matches the fixture`, () => {
      assert.equal(keypairs.sign(d.messageHex, d.privateKey), d.signature);
    });
  }

  test('secp256k1: signTx reproduces the xrpl.js sign fixture blob and hash', () => {
    const r = K.signTx(V.SECP_TX.tx, K.keyFromSeed(V.SECP_TX.seed));
    assert.equal(r.tx_blob, V.SECP_TX.blob);
    assert.equal(r.hash, V.SECP_TX.hash);
  });

  test('ed25519: signTx matches xrpl.js Wallet.sign for the same transaction', () => {
    const r = K.signTx(V.ED25519_TX.tx, K.keyFromSeed(V.ED25519_TX.seed));
    const ref = xrpl.Wallet.fromSeed(V.ED25519_TX.seed).sign(V.ED25519_TX.tx);
    assert.equal(r.tx_blob, ref.tx_blob);
    assert.equal(r.hash, ref.hash);
    assert.equal(r.tx_blob, V.ED25519_TX.blob);
  });

  test('multisignTx reproduces the xrpl.js signAs fixture', () => {
    const r = K.multisignTx(V.MULTISIGN_TX.tx, K.keyFromSeed(V.MULTISIGN_TX.seed));
    assert.equal(r.tx_blob, V.MULTISIGN_TX.blob);
    assert.equal(r.hash, V.MULTISIGN_TX.hash);
  });

  test('verifySignedBlob rejects a blob that is both single- and multi-signed', () => {
    const { tx } = K.multisignTx(V.MULTISIGN_TX.tx, K.keyFromSeed(V.MULTISIGN_TX.seed));
    const blob = K.encodeTx({ ...tx, TxnSignature: tx.Signers[0].Signer.TxnSignature });
    assert.equal(K.verifySignedBlob(blob).valid, false);
  });

  test('verifySignedBlob rejects duplicate signers', () => {
    const { tx } = K.multisignTx(V.MULTISIGN_TX.tx, K.keyFromSeed(V.MULTISIGN_TX.seed));
    const blob = K.encodeTx({ ...tx, Signers: [tx.Signers[0], tx.Signers[0]] });
    const r = K.verifySignedBlob(blob);
    assert.equal(r.valid, false);
    assert.match(r.reason, /duplicate/);
  });

  test('verifySignedBlob rejects a non-canonical encoding of a valid signed tx', () => {
    // Swap the first two fields (TransactionType, Flags): same content, wrong order.
    const b = V.SECP_TX.blob;
    assert.ok(b.startsWith('1200032280000000'));
    const swapped = '2280000000' + '120003' + b.slice(16);
    assert.equal(K.verifySignedBlob(b).valid, true);
    assert.equal(K.verifySignedBlob(swapped).valid, false);
  });

  for (const [name, input] of [['non-hex text', 'hello'], ['odd-length hex', 'ABC'],
    ['truncated blob', V.SECP_TX.blob.slice(0, 40)], ['not a string', 42]]) {
    test(`verifySignedBlob reports ${name} without throwing`, () => {
      const r = K.verifySignedBlob(input);
      assert.equal(r.valid, false);
      assert.ok(r.reason);
    });
  }

  test('verifySignedBlob accepts lower-case hex of a valid blob', () => {
    assert.equal(K.verifySignedBlob(V.SECP_TX.blob.toLowerCase()).valid, true);
  });

  for (const alg of K.ALGORITHMS) {
    test(`${alg}: multisign output equals xrpl.multisign of xrpl's own signature`, () => {
      const signer = K.generateKey(alg);
      const tx = { ...V.MULTISIGN_TX.tx, SigningPubKey: '', LastLedgerSequence: 99 };
      const ours = K.multisignTx(tx, signer);
      const theirs = xrpl.multisign([xrpl.Wallet.fromSeed(signer.seed).sign(tx, true).tx_blob]);
      assert.equal(ours.tx_blob, theirs);
      assert.equal(ours.hash, xrpl.hashes.hashSignedTx(theirs));
    });

    test(`${alg}: every signature v3 makes verifies with xrpl.verifySignature`, () => {
      const key = K.generateKey(alg);
      const tx = { TransactionType: 'SetRegularKey', Account: key.address, Fee: '12', Sequence: 5,
        LastLedgerSequence: 100, RegularKey: V.DERIVATION[0].address };
      const single = K.signTx(tx, key);
      assert.equal(xrpl.verifySignature(single.tx_blob), true);
      assert.equal(K.verifySignedBlob(single.tx_blob).valid, true);
      assert.equal(single.hash, xrpl.hashes.hashSignedTx(single.tx_blob));

      // xrpl.verifySignature does not take multisigned blobs, so verify the
      // signer entry with xrpl's own encodeForMultiSigning + keypairs.verify.
      const multi = K.multisignTx({ ...tx, Account: V.MULTISIGN_TX.tx.Account, SigningPubKey: '' }, key);
      const { Signers, ...unsigned } = xrpl.decode(multi.tx_blob);
      const { Signer } = Signers[0];
      assert.equal(Signer.Account, key.address);
      assert.equal(keypairs.verify(xrpl.encodeForMultiSigning(unsigned, key.address), Signer.TxnSignature, key.publicKey), true);
      const v = K.verifySignedBlob(multi.tx_blob);
      assert.equal(v.valid, true);
      assert.deepEqual(v.signers, [key.address]);
    });
  }

  test('verifySignedBlob rejects a tampered blob', () => {
    const r = K.signTx(V.ED25519_TX.tx, K.keyFromSeed(V.ED25519_TX.seed));
    // Change the Amount (1000000 drops -> 1000001) without re-signing.
    const tampered = r.tx_blob.replace('6140000000000F4240', '6140000000000F4241');
    assert.notEqual(tampered, r.tx_blob);
    assert.equal(K.verifySignedBlob(tampered).valid, false);
  });

  for (const alg of K.ALGORITHMS) {
    test(`${alg}: generateKey takes its entropy from crypto.getRandomValues only`, () => {
      const origGRV = globalThis.crypto.getRandomValues;
      const origRandom = Math.random;
      const sizes = [];
      // Every byte of randomness now comes out as 7s; Math.random must never be touched.
      globalThis.crypto.getRandomValues = (buf) => { sizes.push(buf.length); buf.fill(7); return buf; };
      Math.random = () => { throw new Error('Math.random must not be used'); };
      try {
        const k = K.generateKey(alg);
        const libAlg = alg === 'ed25519' ? 'ed25519' : 'ecdsa-secp256k1';
        const expected = keypairs.generateSeed({ entropy: new Uint8Array(16).fill(7), algorithm: libAlg });
        // The seed is exactly the first 16 bytes drawn. Later draws, if any, are
        // @noble/curves side-channel blinding, also from getRandomValues.
        assert.equal(sizes[0], 16);
        assert.equal(k.seed, expected);
      } finally {
        globalThis.crypto.getRandomValues = origGRV;
        Math.random = origRandom;
      }
    });
  }

  test('generateKey defaults to Ed25519 (sEd seed); secp256k1 is selectable', () => {
    const ed = K.generateKey();
    assert.equal(ed.algorithm, 'ed25519');
    assert.match(ed.seed, /^sEd/);
    const sec = K.generateKey('secp256k1');
    assert.equal(sec.algorithm, 'secp256k1');
    assert.doesNotMatch(sec.seed, /^sEd/);
    assert.throws(() => K.generateKey('rsa'), /Unsupported algorithm/);
  });

  test('a seed with a bad checksum is rejected', () => {
    const good = V.DERIVATION[1].seed;
    const bad = good.slice(0, -1) + (good.endsWith('r') ? 's' : 'r');
    assert.throws(() => K.keyFromSeed(bad), /checksum/i);
  });

  test('already-signed input is refused', () => {
    const key = K.keyFromSeed(V.ED25519_TX.seed);
    assert.throws(() => K.signTx({ ...V.ED25519_TX.tx, TxnSignature: 'AB' }, key), /already signed/);
    assert.throws(() => K.multisignTx({ ...V.MULTISIGN_TX.tx, Signers: [] }, key), /already signed/);
  });

  test('wipeKey clears secret fields', () => {
    const k = K.generateKey();
    K.wipeKey(k);
    assert.equal(k.seed, '');
    assert.equal(k.privateKey, '');
  });
});
