// DECISIONS A16: envelope QR framing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameEnvelope, parsePart, Assembler, envelopeId, MultipartError } from '../../src/offline/core/multipart.js';

const json = JSON.stringify({ version: 1, note: 'x'.repeat(2000) });
const isErr = (code) => (e) => e instanceof MultipartError && e.code === code;

test('a small envelope is one 1/1 part', () => {
  const parts = frameEnvelope('{"a":1}');
  assert.equal(parts.length, 1);
  assert.match(parts[0], /^IC3E:[0-9a-f]{16}:1\/1:\{"a":1\}$/);
});

test('parts reassemble in any order and the id is the SHA-256 prefix', () => {
  const parts = frameEnvelope(json, 500);
  assert.equal(parts.length, 5);
  assert.equal(parsePart(parts[0]).id, envelopeId(json));
  const a = new Assembler();
  for (const p of [parts[3], parts[0], parts[4], parts[1]]) assert.equal(a.add(p).status, 'need');
  assert.deepEqual(a.add(parts[3]), { status: 'need', have: 4, total: 5, missing: [3] }, 'repeat scans are harmless');
  assert.deepEqual(a.add(parts[2]), { status: 'done', text: json });
});

test('a part from a different envelope is refused (no splicing)', () => {
  const a = new Assembler();
  a.add(frameEnvelope(json, 500)[0]);
  const other = frameEnvelope(json.replace('version', 'versioN'), 500);
  assert.throws(() => a.add(other[1]), isErr('mixed'));
});

test('tampered content fails the id check', () => {
  const parts = frameEnvelope(json, 1000);
  const bad = parts[1].replace(/x$/, 'y');
  const a = new Assembler();
  a.add(parts[0]);
  a.add(bad);
  assert.throws(() => a.add(parts[2]), isErr('hash'));
});

test('the same part number with different content is refused', () => {
  const parts = frameEnvelope(json, 1000);
  const a = new Assembler();
  a.add(parts[0]);
  assert.throws(() => a.add(parts[0].replace(/x$/, 'y')), isErr('mixed'));
});

test('non-envelope QR texts are refused', () => {
  for (const s of ['hello', 'IC3E:zz:1/1:{}', 'IC3E:0123456789abcdef:2/1:{}', 'IC3E:0123456789abcdef:0/1:{}', 42]) {
    assert.throws(() => parsePart(s), isErr('format'), String(s));
  }
});

test('an envelope needing more than 64 parts is refused', () => {
  assert.throws(() => frameEnvelope('x'.repeat(65 * 10), 10), isErr('too-big'));
});
