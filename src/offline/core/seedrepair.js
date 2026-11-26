// DECISIONS A13: Seed Repair. When a typed seed fails its checksum, try every
// single-character fix and keep the ones whose checksum passes. The checksum
// is checked by the pinned ripple-address-codec (no cryptography here).
import { decodeSeed } from 'ripple-address-codec';
import { keyFromSeed } from './keys.js';

// XRPL base58 alphabet. It has no 0, O, I or l.
export const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const IN_ALPHABET = new Set(ALPHABET);

export function isValidSeed(s) {
  try { decodeSeed(s); return true; } catch { return false; }
}

/** Indices of characters that can never appear in a seed. */
export function invalidPositions(s) {
  const out = [];
  [...s].forEach((c, i) => { if (!IN_ALPHABET.has(c)) out.push(i); });
  return out;
}

/** Every string one edit away from s (substitute, swap adjacent, delete, insert). */
function* oneEditAway(s) {
  for (let i = 0; i < s.length; i++) {
    for (const c of ALPHABET) {
      if (c !== s[i]) yield { seed: s.slice(0, i) + c + s.slice(i + 1), edit: `position ${i + 1}: "${s[i]}" -> "${c}"` };
    }
  }
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i] !== s[i + 1]) {
      yield { seed: s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2), edit: `positions ${i + 1}-${i + 2} swapped` };
    }
  }
  for (let i = 0; i < s.length; i++) {
    yield { seed: s.slice(0, i) + s.slice(i + 1), edit: `position ${i + 1}: "${s[i]}" removed` };
  }
  for (let i = 0; i <= s.length; i++) {
    for (const c of ALPHABET) yield { seed: s.slice(0, i) + c + s.slice(i), edit: `"${c}" inserted at position ${i + 1}` };
  }
}

/**
 * @param typed the seed as typed (surrounding spaces are ignored)
 * @param signerAddresses optional: addresses in the ledger's signer list, to
 *        mark matching candidates (Recovery, Estate)
 * @returns { valid, invalid: number[], candidates: [{ seed, address, algorithm, edit, inSignerList }] }
 *          valid = the typed seed already passes its checksum (no repair needed)
 */
export function repairSeed(typed, signerAddresses = []) {
  const s = String(typed).trim();
  if (isValidSeed(s)) return { valid: true, invalid: [], candidates: [] };
  // Seeds are 29 (secp256k1) or 31 (Ed25519) characters. One edit away from
  // those means 28-32; anything else cannot be repaired (and would be slow).
  if (s.length < 28 || s.length > 32) return { valid: false, invalid: invalidPositions(s), candidates: [] };
  const seen = new Set();
  const candidates = [];
  for (const c of oneEditAway(s)) {
    if (seen.has(c.seed)) continue;
    seen.add(c.seed);
    if (!isValidSeed(c.seed)) continue;
    const k = keyFromSeed(c.seed);
    candidates.push({
      seed: c.seed, address: k.address, algorithm: k.algorithm, edit: c.edit,
      inSignerList: signerAddresses.includes(k.address),
    });
    k.seed = ''; k.privateKey = '';
  }
  candidates.sort((a, b) => Number(b.inSignerList) - Number(a.inSignerList));
  return { valid: false, invalid: invalidPositions(s), candidates };
}
