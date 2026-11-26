// SPEC §4.7 Replace Spare:
//   1. generate a new spare and display it to be written down
//   2. re-enter it from the paper; it must derive the same address
//   3. sign a SignerListSet with the current regular key
// The spare is never stored (SPEC §4.2).
import { h, replace } from '../dom.js';
import { session, onWipe } from '../session.js';
import { generateKey, keyFromSeed, signTx, wipeKey } from '../../core/keys.js';
import { fillSignerList } from '../../core/envelope.js';
import {
  errorBox, okBox, note, txCard, ackPanel, passphraseStep, saveVault, signedOutput, spareCardDisplay, seedEntry, warnBox,
} from '../widgets.js';
import { show, showStep, setNetwork } from '../app.js';
import {
  prepare, ctxFor, showRefused, blockedByPending, resolutionNotes, expiryNote, finalCheck, assertVerified, doneButton,
} from './common.js';

/**
 * Show a new spare, then have it typed back from the paper (shared with
 * Migration). onVerified(spareAddress) runs once it matches; the seed itself
 * is wiped from the screen and memory before that.
 */
export function spareCeremony({ label, title, before = [], after = [], onVerified }) {
  let spare = generateKey('ed25519');
  onWipe(() => { if (spare) wipeKey(spare); spare = null; });
  const msg = h('div');
  const card = spareCardDisplay(spare, {
    label,
    onWritten: () => {
      card.remove();
      showStep(title, ...before,
        h('div', { class: 'card' },
          h('h3', { text: `Type the spare for ${label} back in from the paper` }),
          note('This proves the card is readable. The screen no longer shows the seed.'),
          seedEntry((k) => {
            const ok = k.address === spare.address;
            wipeKey(k);
            if (!ok) {
              replace(msg, errorBox('That does not match the spare shown. Check the card character by character and type it again.'));
              return;
            }
            const addr = spare.address;
            wipeKey(spare);
            spare = null;
            onVerified(addr);
          }, { label: 'Spare seed (from the paper)', confirmLabel: 'Check' })),
        msg, ...after);
    },
  });
  showStep(title, ...before, card, ...after);
}

export function replaceSpareFlow(env) {
  setNetwork(env.network);
  const { v, payload, resolved } = prepare(env);
  if (!v.ok) return showRefused(env, v, payload);
  if (blockedByPending(env, resolved)) return;
  const { tx, acks } = v.txs[0];
  const acct = tx.Account;
  const account = payload.accounts.find((a) => a.address === acct);
  const ctx = ctxFor(payload, acct);
  const ackUi = ackPanel(acks);

  const intro = [
    resolutionNotes(resolved),
    txCard(tx, { ctx, template: true }),
    expiryNote(env),
    ackUi.el,
  ];

  const begin = () => spareCeremony({
    label: account.label,
    title: 'Replace Spare',
    before: [],
    onVerified: (spareAddr) => signStep(spareAddr),
  });

  function signStep(spareAddr) {
    const msg = h('div');
    const filled = fillSignerList(tx, spareAddr);
    const step = passphraseStep(async (pass, { progress }) => {
      let cur = null;
      try {
        if (!ackUi.ok()) throw new Error('Tick or type every item under "Check these before signing" first.');
        finalCheck(filled, { multisigned: false, ownerReserveDrops: env.ownerReserveDrops }, ackUi.given);
        cur = keyFromSeed(account.regularKey.seed);
        const signed = signTx(filled, cur);
        assertVerified([signed]);
        wipeKey(cur);
        cur = null;
        let saved = null;
        if (resolved && resolved.changed) {
          saved = await saveVault(payload, pass, progress);
          session.vault = { network: payload.network, fileName: saved.filename, fileText: saved.text, payload };
        }
        show('Replace Spare signed',
          saved ? warnBox(`The vault changed (key rotation result). Your browser saved ${saved.filename}.`) : null,
          signedOutput([signed], ctx),
          warnBox('Once this is validated, the OLD spare paper no longer works. Destroy it, and store the new card where the old one was.'),
          doneButton());
      } catch (e) {
        if (cur) wipeKey(cur);
        replace(msg, errorBox(String(e.message || e)));
      }
    });
    showStep('Replace Spare: sign',
      okBox(`New spare checked: ${spareAddr}`),
      txCard(filled, { ctx }),
      step.el, msg);
  }

  show('Replace Spare', ...intro,
    h('div', { class: 'card' },
      h('p', { text: 'A new spare is generated on this machine. Have the blank Spare Key Card and a pen ready.' }),
      h('button', { type: 'button', class: 'btn primary', text: 'Generate the new spare', on: { click: () => {
        if (!ackUi.ok()) { replace(gateMsg, errorBox('Tick or type every item under "Check these before signing" first.')); return; }
        begin();
      } } })));
  const gateMsg = h('div');
  document.getElementById('screen').append(gateMsg);
}
