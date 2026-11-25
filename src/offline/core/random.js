// SPEC §4.1: randomness comes only from crypto.getRandomValues.

export function randomBytes(n) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is not available');
  }
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

// Best-effort wipe of byte buffers we own (see DECISIONS: known limitations).
export function wipe(...bufs) {
  for (const b of bufs) if (b instanceof Uint8Array) b.fill(0);
}
