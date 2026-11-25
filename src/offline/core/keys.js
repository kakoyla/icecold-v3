// Thin wrappers over ripple-keypairs and ripple-binary-codec (SPEC §4.1).
// No cryptography is implemented here: keys, signatures and hashes all come
// from the pinned libraries. This module only assembles transactions.
import * as keypairs from 'ripple-keypairs';
import * as codec from 'ripple-binary-codec';
import { decodeSeed, isValidClassicAddress } from 'ripple-address-codec';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes, wipe } from './random.js';
import { assertSigningEnabled } from './gate.js';

export const ALGORITHMS = Object.freeze(['ed25519', 'secp256k1']);
const LIB_ALG = { ed25519: 'ed25519', secp256k1: 'ecdsa-secp256k1' };
// Transaction ID prefix "TXN\0" (rippled HashPrefix::transactionID).
const TXN_PREFIX = Uint8Array.of(0x54, 0x58, 0x4e, 0x00);

const upper = (b) => bytesToHex(b).toUpperCase();

/** Algorithm encoded in a family seed. Throws on a bad checksum. */
export function seedAlgorithm(seed) {
  const { type } = decodeSeed(String(seed).trim());
  return type === 'ed25519' ? 'ed25519' : 'secp256k1';
}

/** Derive {algorithm, seed, publicKey, privateKey, address} from a seed. */
export function keyFromSeed(seed) {
  const s = String(seed).trim();
  const algorithm = seedAlgorithm(s);
  const { publicKey, privateKey } = keypairs.deriveKeypair(s);
  return { algorithm, seed: s, publicKey, privateKey, address: keypairs.deriveAddress(publicKey) };
}

/** Public part only, safe to show or store as metadata. */
export function publicPart(key) {
  return { algorithm: key.algorithm, publicKey: key.publicKey, address: key.address };
}

/** New key from 16 bytes of crypto.getRandomValues entropy. Ed25519 by default. */
export function generateKey(algorithm = 'ed25519') {
  if (!ALGORITHMS.includes(algorithm)) throw new Error(`Unsupported algorithm: ${algorithm}`);
  const entropy = randomBytes(16);
  try {
    const seed = keypairs.generateSeed({ entropy, algorithm: LIB_ALG[algorithm] });
    return keyFromSeed(seed);
  } finally {
    wipe(entropy);
  }
}

/** Best-effort wipe of a key object's secret fields. */
export function wipeKey(key) {
  if (key && typeof key === 'object') {
    key.seed = '';
    key.privateKey = '';
  }
}

export function isValidAddress(a) {
  return typeof a === 'string' && isValidClassicAddress(a);
}

/** Transaction ID of a signed blob: SHA-512Half("TXN\0" || blob). */
export function hashSignedBlob(blobHex) {
  const blob = hexToBytes(blobHex);
  const msg = new Uint8Array(TXN_PREFIX.length + blob.length);
  msg.set(TXN_PREFIX);
  msg.set(blob, TXN_PREFIX.length);
  return upper(sha512(msg).slice(0, 32));
}

function cloneUnsigned(tx) {
  if (!tx || typeof tx !== 'object') throw new Error('Transaction must be an object');
  if ('TxnSignature' in tx || 'Signers' in tx) {
    throw new Error('Input transaction is already signed');
  }
  return JSON.parse(JSON.stringify(tx));
}

// Unchecked signers: used only by the self-test, which must run before the
// gate opens. Everything else goes through the gated exports below.
export function _signUnchecked(tx, key) {
  const t = cloneUnsigned(tx);
  t.SigningPubKey = key.publicKey;
  t.TxnSignature = keypairs.sign(codec.encodeForSigning(t), key.privateKey);
  const tx_blob = codec.encode(t);
  return { tx_blob, hash: hashSignedBlob(tx_blob), tx: t };
}

export function _multisignUnchecked(tx, signerKey) {
  const t = cloneUnsigned(tx);
  if (t.SigningPubKey !== undefined && t.SigningPubKey !== '') {
    throw new Error('Multi-signed transaction must have an empty SigningPubKey');
  }
  t.SigningPubKey = '';
  const sig = keypairs.sign(codec.encodeForMultisigning(t, signerKey.address), signerKey.privateKey);
  t.Signers = [{ Signer: { Account: signerKey.address, SigningPubKey: signerKey.publicKey, TxnSignature: sig } }];
  const tx_blob = codec.encode(t);
  return { tx_blob, hash: hashSignedBlob(tx_blob), tx: t };
}

/** Single-sign. Gated by the startup self-test (SPEC §4.3). */
export function signTx(tx, key) {
  assertSigningEnabled();
  return _signUnchecked(tx, key);
}

/** Multi-sign with one signer (SPEC §2: quorum 1, one entry). Gated. */
export function multisignTx(tx, signerKey) {
  assertSigningEnabled();
  return _multisignUnchecked(tx, signerKey);
}

/**
 * Decode a signed blob and verify every signature in it.
 * Returns { valid, tx, hash, signers } where signers lists signing addresses.
 */
export function verifySignedBlob(blobHex) {
  const tx = codec.decode(blobHex);
  const hash = hashSignedBlob(blobHex);
  const fail = (reason) => ({ valid: false, reason, tx, hash, signers: [] });

  if (Array.isArray(tx.Signers) && tx.Signers.length > 0) {
    if (tx.SigningPubKey !== '') return fail('multisigned tx must have empty SigningPubKey');
    const { Signers, ...unsigned } = tx;
    const signers = [];
    for (const { Signer } of Signers) {
      if (keypairs.deriveAddress(Signer.SigningPubKey) !== Signer.Account) {
        return fail(`signer key does not match ${Signer.Account}`);
      }
      const msg = codec.encodeForMultisigning(unsigned, Signer.Account);
      if (!keypairs.verify(msg, Signer.TxnSignature, Signer.SigningPubKey)) {
        return fail(`bad signature from ${Signer.Account}`);
      }
      signers.push(Signer.Account);
    }
    return { valid: true, tx, hash, signers };
  }

  if (!tx.TxnSignature || !tx.SigningPubKey) return fail('not signed');
  const { TxnSignature, ...unsigned } = tx;
  if (!keypairs.verify(codec.encodeForSigning(unsigned), TxnSignature, tx.SigningPubKey)) {
    return fail('bad signature');
  }
  return { valid: true, tx, hash, signers: [keypairs.deriveAddress(tx.SigningPubKey)] };
}

export const decodeBlob = (hex) => codec.decode(hex);
export const encodeTx = (tx) => codec.encode(tx);
