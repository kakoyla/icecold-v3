// SPEC §4.7 tools: Generate Keypair, Decode / Verify, Seed Repair.
import { h, replace } from './dom.js';
import { onWipe } from './session.js';
import { generateKey, verifySignedBlob, wipeKey } from '../core/keys.js';
import { describeTx } from '../core/describe.js';
import { segments } from './dom.js';
import { button, errorBox, okBox, note, seedEntry, spareCardDisplay, txCard } from './widgets.js';
import { scanner } from './qr.js';
import { show, showStep } from './app.js';

export function generateKeypairTool() {
  const out = h('div');
  let key = null;
  onWipe(() => { if (key) wipeKey(key); key = null; });
  const gen = (alg) => {
    if (key) wipeKey(key);
    key = generateKey(alg);
    const card = spareCardDisplay(key, { label: `a new ${alg} key`, onWritten: () => { wipeKey(key); key = null; replace(out, okBox('Cleared from the screen and memory.')); } });
    replace(out, card);
  };
  show('Generate keypair',
    h('div', { class: 'card' },
      h('p', { text: 'For testnet accounts and spares. Randomness comes only from crypto.getRandomValues.' }),
      h('div', { class: 'buttons' }, button('Ed25519 (default)', () => gen('ed25519'), 'primary'), button('secp256k1', () => gen('secp256k1')))),
    out);
}

export function decodeVerifyTool() {
  const area = h('textarea', { class: 'mono', rows: 6, placeholder: 'Signed transaction blob (hex)' });
  area.setAttribute('spellcheck', 'false');
  const out = h('div');
  const run = (hex) => {
    const r = verifySignedBlob(hex.trim());
    if (!r.tx) { replace(out, errorBox(`Not a transaction: ${r.reason}`)); return; }
    const d = describeTx(r.tx, {});
    replace(out,
      r.valid ? okBox(`Signature valid. Signed by: ${r.signers.join(', ')}`) : errorBox(`NOT VALID: ${r.reason}`),
      h('p', {}, 'Hash: ', h('span', { class: 'mono', text: r.hash || '—' })),
      h('p', { class: 'summary' }, segments(d.summary)),
      txCard(r.tx, {}));
  };
  let sc = null;
  const scanBox = h('div');
  show('Decode / verify',
    h('div', { class: 'card' }, area, h('div', { class: 'buttons' },
      button('Decode and verify', () => run(area.value), 'primary'),
      button('Scan with webcam', () => {
        if (sc) return;
        sc = scanner((text) => { area.value = text; sc = null; replace(scanBox); run(text); return true; });
        replace(scanBox, sc.el);
      })), scanBox),
    out);
}

export function seedRepairTool() {
  const out = h('div');
  show('Seed repair',
    h('div', { class: 'card' },
      note('Type a seed. If its checksum fails, every single-character fix is tried and the ones that pass are listed with their addresses.'),
      seedEntry((k) => {
        replace(out, okBox(`This seed is valid. Address: ${k.address} (${k.algorithm})`));
        wipeKey(k);
      }, { label: 'Seed', confirmLabel: 'Check seed' })),
    out);
}

export { showStep };
