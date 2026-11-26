// SPEC §4.3 startup self-test. Runs known-answer vectors before anything
// else. Any failure disables every signing function for the session.
import * as keypairs from 'ripple-keypairs';
import * as codec from 'ripple-binary-codec';
import * as V from './vectors.js';
import { keyFromSeed, _signUnchecked, _multisignUnchecked, verifySignedBlob } from './keys.js';
import { markSelfTest } from './gate.js';

function sameJson(a, b) {
  const norm = (o) => JSON.stringify(o, Object.keys(o).sort());
  return norm(a) === norm(b);
}

/**
 * @param vectors defaults to the built-in set; tests pass a corrupted copy.
 * @returns {{passed: boolean, results: {name: string, ok: boolean, detail?: string}[]}}
 */
export function runSelfTest(vectors = V) {
  const results = [];
  const check = (name, fn) => {
    try {
      const ok = fn() === true;
      results.push({ name, ok });
    } catch (e) {
      results.push({ name, ok: false, detail: String(e && e.message ? e.message : e) });
    }
  };

  for (const d of vectors.DERIVATION) {
    check(`${d.algorithm}: seed → keypair → address`, () => {
      const k = keyFromSeed(d.seed);
      return k.algorithm === d.algorithm && k.publicKey === d.publicKey &&
        k.privateKey === d.privateKey && k.address === d.address;
    });
    check(`${d.algorithm}: deterministic message signature`, () => {
      const sig = keypairs.sign(d.messageHex, d.privateKey);
      return sig === d.signature && keypairs.verify(d.messageHex, sig, d.publicKey);
    });
  }

  for (const [label, vec] of [['secp256k1', vectors.SECP_TX], ['ed25519', vectors.ED25519_TX]]) {
    check(`${label}: deterministic transaction signature`, () => {
      const { tx_blob, hash } = _signUnchecked(vec.tx, keyFromSeed(vec.seed));
      return tx_blob === vec.blob && hash === vec.hash && verifySignedBlob(tx_blob).valid;
    });
  }

  for (const [label, vec] of [['secp256k1', vectors.MULTISIGN_TX], ['ed25519', vectors.ED25519_MULTISIGN_TX]]) {
    check(`${label}: multisign signature`, () => {
      const { tx_blob, hash } = _multisignUnchecked(vec.tx, keyFromSeed(vec.seed));
      return tx_blob === vec.blob && hash === vec.hash && verifySignedBlob(tx_blob).valid;
    });
  }

  check('binary codec round-trip', () => {
    const tx = vectors.ED25519_TX.tx;
    const decoded = codec.decode(codec.encode(tx));
    return sameJson(decoded, tx) && codec.encode(codec.decode(vectors.SECP_TX.blob)) === vectors.SECP_TX.blob;
  });

  const passed = results.length > 0 && results.every((r) => r.ok);
  markSelfTest(passed);
  return { passed, results };
}
