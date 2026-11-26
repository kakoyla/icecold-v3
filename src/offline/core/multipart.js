// DECISIONS A16: envelope QR framing across the air gap.
//
//   IC3E:<id>:<i>/<n>:<chunk>
//
// <id> is the first 16 hex characters of SHA-256(envelope JSON, UTF-8).
// Chunks are consecutive substrings of the JSON; parts may arrive in any
// order; a part with a different id is refused, and the joined text must
// hash back to <id>.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const MAX_PARTS = 64;
export const DEFAULT_CHUNK = 800;
const PART_RE = /^IC3E:([0-9a-f]{16}):([1-9]\d{0,1})\/([1-9]\d{0,1}):([\s\S]*)$/;

export class MultipartError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const envelopeId = (text) => bytesToHex(sha256(new TextEncoder().encode(text))).slice(0, 16);

/** Split an envelope JSON string into QR texts (used by tests and Phase 3). */
export function frameEnvelope(text, chunk = DEFAULT_CHUNK) {
  const id = envelopeId(text);
  const n = Math.max(1, Math.ceil(text.length / chunk));
  if (n > MAX_PARTS) throw new MultipartError('too-big', `envelope needs ${n} parts; the limit is ${MAX_PARTS}`);
  return Array.from({ length: n }, (_, i) => `IC3E:${id}:${i + 1}/${n}:${text.slice(i * chunk, (i + 1) * chunk)}`);
}

/** Parse one scanned QR text. Throws MultipartError('format') if it is not an envelope part. */
export function parsePart(text) {
  const m = typeof text === 'string' && PART_RE.exec(text);
  if (!m) throw new MultipartError('format', 'this QR code is not an ICE COLD envelope');
  const i = Number(m[2]);
  const n = Number(m[3]);
  if (n > MAX_PARTS || i > n) throw new MultipartError('format', 'bad part number');
  return { id: m[1], i, n, chunk: m[4] };
}

/**
 * Collects parts of one envelope.
 * add(text) returns { status: 'need', have, total, missing } or
 * { status: 'done', text }. Throws MultipartError with code
 * 'format' | 'mixed' | 'hash'.
 */
export class Assembler {
  constructor() { this.reset(); }

  reset() { this.id = null; this.n = 0; this.parts = new Map(); }

  add(text) {
    const p = parsePart(text);
    if (this.id === null) { this.id = p.id; this.n = p.n; }
    if (p.id !== this.id || p.n !== this.n) {
      throw new MultipartError('mixed', 'this QR code belongs to a different envelope; start again');
    }
    if (this.parts.has(p.i) && this.parts.get(p.i) !== p.chunk) {
      throw new MultipartError('mixed', `part ${p.i} was scanned twice with different content`);
    }
    this.parts.set(p.i, p.chunk);
    if (this.parts.size < this.n) {
      const missing = [];
      for (let k = 1; k <= this.n; k++) if (!this.parts.has(k)) missing.push(k);
      return { status: 'need', have: this.parts.size, total: this.n, missing };
    }
    let joined = '';
    for (let k = 1; k <= this.n; k++) joined += this.parts.get(k);
    if (envelopeId(joined) !== this.id) {
      const id = this.id;
      this.reset();
      throw new MultipartError('hash', `the joined envelope does not match its id ${id}; scan again`);
    }
    return { status: 'done', text: joined };
  }
}
