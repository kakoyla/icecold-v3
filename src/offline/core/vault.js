// SPEC §4.2 encrypted vault: scrypt (@noble/hashes) → AES-256-GCM (@noble/ciphers).
// Pure JS, so it does not depend on WebCrypto being available under file://.
//
// File layout (JSON):
//   { format, version, network, createdAt, kdf:{name,N,r,p,dkLen},
//     salt, cipher:{name,nonce}, ciphertext }
// Every field except `ciphertext` is bound in as GCM associated data, so
// editing the network, KDF parameters or any other header field makes
// decryption fail.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes, wipe } from './random.js';
import { keyFromSeed, isValidAddress, ALGORITHMS } from './keys.js';
import {
  NETWORKS, VAULT_KDF_DEFAULT, VAULT_KDF_MIN_LOG2N, VAULT_KDF_MAX_LOG2N, MIN_PASSPHRASE_LENGTH,
} from './config.js';

const FORMAT = 'icecold-vault';
const VERSION = 1;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class VaultError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- payload schema ----------

const KEY_FIELDS = ['algorithm', 'seed', 'publicKey', 'address'];
const BOOK_FIELDS = ['label', 'address', 'isExchange', 'requiresTag'];
const ACCOUNT_FIELDS = ['label', 'address', 'regularKey', 'pendingKey', 'retiredKeys', 'addressBook'];
const PAYLOAD_FIELDS = ['format', 'version', 'network', 'accounts'];

function exactKeys(obj, allowed, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new VaultError('schema', `${where}: not an object`);
  for (const k of Object.keys(obj)) {
    if (/spare/i.test(k)) throw new VaultError('spare', `${where}: spares are never stored in the vault`);
    if (!allowed.includes(k)) throw new VaultError('schema', `${where}: unexpected field "${k}"`);
  }
  for (const k of allowed) if (!(k in obj)) throw new VaultError('schema', `${where}: missing field "${k}"`);
}

function checkKey(k, where) {
  exactKeys(k, KEY_FIELDS, where);
  if (!ALGORITHMS.includes(k.algorithm)) throw new VaultError('schema', `${where}: bad algorithm`);
  let derived;
  try { derived = keyFromSeed(k.seed); } catch { throw new VaultError('schema', `${where}: invalid seed`); }
  if (derived.algorithm !== k.algorithm || derived.publicKey !== k.publicKey || derived.address !== k.address) {
    throw new VaultError('schema', `${where}: seed does not derive the stored public key/address`);
  }
}

/** Throws VaultError unless `p` is a well-formed vault payload for `network`. */
export function validatePayload(p, network) {
  exactKeys(p, PAYLOAD_FIELDS, 'vault');
  if (p.format !== `${FORMAT}-payload` || p.version !== VERSION) throw new VaultError('schema', 'vault: unknown payload format');
  if (!NETWORKS.includes(p.network)) throw new VaultError('schema', 'vault: bad network');
  if (network !== undefined && p.network !== network) throw new VaultError('network', `vault is for ${p.network}, not ${network}`);
  if (!Array.isArray(p.accounts)) throw new VaultError('schema', 'vault: accounts must be a list');
  const seen = new Set();
  p.accounts.forEach((a, i) => {
    const w = `account[${i}]`;
    exactKeys(a, ACCOUNT_FIELDS, w);
    if (typeof a.label !== 'string' || !a.label) throw new VaultError('schema', `${w}: label required`);
    if (!isValidAddress(a.address)) throw new VaultError('schema', `${w}: bad address`);
    if (seen.has(a.address)) throw new VaultError('schema', `${w}: duplicate account`);
    seen.add(a.address);
    if (a.regularKey !== null) checkKey(a.regularKey, `${w}.regularKey`);
    if (a.pendingKey !== null) checkKey(a.pendingKey, `${w}.pendingKey`);
    if (a.regularKey === null && a.pendingKey === null) throw new VaultError('schema', `${w}: no key`);
    if (!Array.isArray(a.retiredKeys) || !a.retiredKeys.every(isValidAddress)) {
      throw new VaultError('schema', `${w}: retiredKeys must be a list of addresses`);
    }
    if (!Array.isArray(a.addressBook)) throw new VaultError('schema', `${w}: addressBook must be a list`);
    a.addressBook.forEach((b, j) => {
      exactKeys(b, BOOK_FIELDS, `${w}.addressBook[${j}]`);
      if (typeof b.label !== 'string' || !isValidAddress(b.address) ||
          typeof b.isExchange !== 'boolean' || typeof b.requiresTag !== 'boolean') {
        throw new VaultError('schema', `${w}.addressBook[${j}]: bad entry`);
      }
    });
  });
  return p;
}

export function emptyPayload(network) {
  if (!NETWORKS.includes(network)) throw new VaultError('schema', 'bad network');
  return { format: `${FORMAT}-payload`, version: VERSION, network, accounts: [] };
}

/** Stored form of a key (no private key; it is re-derived from the seed). */
export function storedKey(key) {
  return { algorithm: key.algorithm, seed: key.seed, publicKey: key.publicKey, address: key.address };
}

// ---------- file encryption ----------

const HEADER_ORDER = ['format', 'version', 'network', 'createdAt', 'kdf', 'salt', 'cipher'];
function aad(header) {
  // Fixed key order, nested objects included, so the bytes are canonical.
  const canon = {
    format: header.format, version: header.version, network: header.network, createdAt: header.createdAt,
    kdf: { name: header.kdf.name, N: header.kdf.N, r: header.kdf.r, p: header.kdf.p, dkLen: header.kdf.dkLen },
    salt: header.salt,
    cipher: { name: header.cipher.name, nonce: header.cipher.nonce },
  };
  return enc.encode(JSON.stringify(canon));
}

function checkKdf(kdf) {
  const log2 = Math.log2(kdf.N);
  if (kdf.name !== 'scrypt' || !Number.isInteger(log2) || log2 < VAULT_KDF_MIN_LOG2N || log2 > VAULT_KDF_MAX_LOG2N ||
      kdf.r !== 8 || kdf.p !== 1 || kdf.dkLen !== 32) {
    throw new VaultError('kdf', 'vault: unsupported KDF parameters');
  }
}

const passBytes = (pass) => enc.encode(String(pass).normalize('NFKC'));

async function deriveKey(pass, salt, kdf, onProgress) {
  return scryptAsync(passBytes(pass), salt, { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: kdf.dkLen, onProgress });
}

export function vaultFilename(network, date) {
  const ts = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `icecold-vault-${network}-${ts}.json`;
}

/**
 * Encrypt a payload. Returns { filename, text } for a browser download.
 * opts: { kdf, now, onProgress }. Tests pass a small kdf.N for speed.
 */
export async function encryptVault(payload, passphrase, opts = {}) {
  validatePayload(payload);
  if (String(passphrase).length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError('passphrase', `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const kdf = { name: 'scrypt', ...VAULT_KDF_DEFAULT, ...(opts.kdf || {}), dkLen: 32 };
  checkKdf(kdf);
  const now = opts.now || new Date();
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header = {
    format: FORMAT, version: VERSION, network: payload.network, createdAt: now.toISOString(),
    kdf, salt: bytesToHex(salt), cipher: { name: 'aes-256-gcm', nonce: bytesToHex(nonce) },
  };
  const key = await deriveKey(passphrase, salt, kdf, opts.onProgress);
  const plain = enc.encode(JSON.stringify(payload));
  try {
    const ct = gcm(key, nonce, aad(header)).encrypt(plain);
    const file = { ...header, ciphertext: bytesToHex(ct) };
    return { filename: vaultFilename(payload.network, now), text: JSON.stringify(file, null, 1) };
  } finally {
    wipe(key, plain);
  }
}

/** Parse and check a vault file's header without decrypting it. */
export function readHeader(text) {
  let f;
  try { f = JSON.parse(text); } catch { throw new VaultError('format', 'not a vault file (bad JSON)'); }
  if (!f || f.format !== FORMAT) throw new VaultError('format', 'not an ICE COLD vault file');
  if (f.version !== VERSION) throw new VaultError('format', `unsupported vault version ${f.version}`);
  const allowed = [...HEADER_ORDER, 'ciphertext'];
  for (const k of Object.keys(f)) if (!allowed.includes(k)) throw new VaultError('format', `unexpected field "${k}"`);
  if (!NETWORKS.includes(f.network)) throw new VaultError('format', 'bad network');
  checkKdf(f.kdf || {});
  if (!f.cipher || f.cipher.name !== 'aes-256-gcm' || !/^[0-9a-f]{24}$/.test(f.cipher.nonce)) throw new VaultError('format', 'bad cipher');
  if (!/^[0-9a-f]{32}$/.test(f.salt) || !/^[0-9a-f]+$/.test(f.ciphertext)) throw new VaultError('format', 'bad salt/ciphertext');
  return f;
}

/**
 * Decrypt a vault file for `network`. Throws VaultError with code:
 *   'network' – file is for the other network (checked before the slow KDF)
 *   'decrypt' – wrong passphrase, or the file was altered
 *   'schema' / 'spare' / 'format' / 'kdf' – malformed content
 */
export async function decryptVault(text, passphrase, network, opts = {}) {
  if (!NETWORKS.includes(network)) throw new VaultError('network', 'unknown network');
  const f = readHeader(text);
  if (f.network !== network) throw new VaultError('network', `vault is for ${f.network}, not ${network}`);
  const key = await deriveKey(passphrase, hexToBytes(f.salt), f.kdf, opts.onProgress);
  let plain;
  try {
    plain = gcm(key, hexToBytes(f.cipher.nonce), aad(f)).decrypt(hexToBytes(f.ciphertext));
  } catch {
    throw new VaultError('decrypt', 'wrong passphrase, or the vault file has been altered');
  } finally {
    wipe(key);
  }
  let payload;
  try { payload = JSON.parse(dec.decode(plain)); } finally { wipe(plain); }
  return validatePayload(payload, network);
}

/**
 * SPEC §4.5 step 3 gate (DECISIONS A2): re-open the vault file the user just
 * saved and picked back in, and confirm the pending key is in it.
 */
export async function confirmPendingSaved(text, passphrase, network, accountAddress, pendingAddress, opts) {
  const p = await decryptVault(text, passphrase, network, opts);
  const a = p.accounts.find((x) => x.address === accountAddress);
  return !!(a && a.pendingKey && a.pendingKey.address === pendingAddress);
}
