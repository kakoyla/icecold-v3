// DECISIONS A13: Seed Repair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairSeed, invalidPositions, isValidSeed, ALPHABET } from '../../src/offline/core/seedrepair.js';
import { generateKey } from '../../src/offline/core/keys.js';

const key = generateKey('ed25519');
const secp = generateKey('secp256k1');
const swapAt = (s, i, c) => s.slice(0, i) + c + s.slice(i + 1);
const otherChar = (c) => ALPHABET[(ALPHABET.indexOf(c) + 1) % ALPHABET.length];

function finds(typed, original) {
  const r = repairSeed(typed);
  assert.equal(r.valid, false);
  assert.ok(r.candidates.some((c) => c.seed === original), `original not among ${r.candidates.length} candidates`);
  return r;
}

test('a valid seed needs no repair', () => assert.equal(repairSeed(key.seed).valid, true));

test('one wrong character is found (ed25519 and secp256k1)', () => {
  for (const k of [key, secp]) {
    const i = 10;
    const r = finds(swapAt(k.seed, i, otherChar(k.seed[i])), k.seed);
    assert.equal(r.candidates.find((c) => c.seed === k.seed).address, k.address);
  }
});

test('a wrong case is found', () => {
  const i = [...key.seed].findIndex((c, j) => j > 3 && c.toLowerCase() !== c.toUpperCase() &&
    ALPHABET.includes(c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  const c = key.seed[i];
  finds(swapAt(key.seed, i, c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()), key.seed);
});

test('two swapped neighbours are found', () => {
  const i = [...key.seed].findIndex((c, j) => j > 3 && key.seed[j + 1] && c !== key.seed[j + 1]);
  finds(key.seed.slice(0, i) + key.seed[i + 1] + key.seed[i] + key.seed.slice(i + 2), key.seed);
});

test('a missing character is found', () => finds(key.seed.slice(0, 12) + key.seed.slice(13), key.seed));
test('an extra character is found', () => finds(key.seed.slice(0, 12) + 'z' + key.seed.slice(12), key.seed));

test('characters that are never valid are reported (0, O, I, l)', () => {
  const typed = swapAt(swapAt(key.seed, 5, '0'), 9, 'l');
  assert.deepEqual(invalidPositions(typed), [5, 9]);
  assert.deepEqual(repairSeed(typed).invalid, [5, 9]);
});

test('candidates in the signer list are marked and listed first', () => {
  const typed = swapAt(key.seed, 10, otherChar(key.seed[10]));
  const r = repairSeed(typed, [key.address]);
  assert.equal(r.candidates[0].seed, key.seed);
  assert.equal(r.candidates[0].inSignerList, true);
  assert.ok(r.candidates.slice(1).every((c) => !c.inSignerList));
});

test('every candidate passes its checksum, and repair is fast', () => {
  const t0 = Date.now();
  const r = repairSeed(swapAt(secp.seed, 7, otherChar(secp.seed[7])));
  assert.ok(Date.now() - t0 < 3000, 'repair took too long');
  assert.ok(r.candidates.every((c) => isValidSeed(c.seed)));
});
