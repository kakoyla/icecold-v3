// SPEC §4.4 generic signing flow, for the plain `sign` purpose (Send and
// AccountSet, DECISIONS A9).
import { h, replace } from '../dom.js';
import { session } from '../session.js';
import { keyFromSeed, signTx, wipeKey } from '../../core/keys.js';
import { describeTx } from '../../core/describe.js';
import { button, errorBox, note, txCard, ackPanel, passphraseStep, saveVault, signedOutput, warnBox } from '../widgets.js';
import { show, setNetwork } from '../app.js';
import { textInput } from '../dom.js';
import {
  prepare, ctxFor, showRefused, blockedByPending, resolutionNotes, expiryNote, finalCheck, assertVerified, doneButton,
} from './common.js';

export function signFlow(env) {
  setNetwork(env.network);
  const { v, payload, resolved } = prepare(env);
  if (!v.ok) return showRefused(env, v, payload);
  if (blockedByPending(env, resolved)) return;

  const { tx, acks } = v.txs[0];
  const account = payload.accounts.find((a) => a.address === tx.Account);
  const ctx = ctxFor(payload, tx.Account);
  const d = describeTx(tx, ctx);
  const msg = h('div');

  // SPEC §4.4 step 3: first-time destinations get an extra confirmation, and
  // may be added to the address book.
  let firstTime = null;
  if (d.firstTimeDestination) {
    const cb = h('input', { type: 'checkbox' });
    const add = h('input', { type: 'checkbox' });
    const label = textInput({ placeholder: 'Label, e.g. Exchange deposit' });
    const ex = h('input', { type: 'checkbox' });
    const tag = h('input', { type: 'checkbox' });
    firstTime = { cb, add, label, ex, tag };
    firstTime.el = h('div', { class: 'card first-time' },
      h('h3', { text: 'New destination' }),
      h('p', {}, 'You have not sent to ', h('strong', { class: 'mono', text: tx.Destination }), ' from this account before.'),
      h('label', { class: 'check' }, cb, ' I have checked this address character by character against a trusted source.'),
      h('label', { class: 'check' }, add, ' Add it to the address book'),
      h('div', { class: 'row' }, label, h('label', { class: 'check' }, ex, ' exchange'), h('label', { class: 'check' }, tag, ' needs a destination tag')));
  }

  const ackUi = ackPanel(acks);
  const step = passphraseStep(async (pass, { progress }) => {
    let key = null;
    try {
      if (firstTime && !firstTime.cb.checked) throw new Error('Confirm the new destination first.');
      if (!ackUi.ok()) throw new Error('Tick or type every item under "Check these before signing" first.');
      let next = payload;
      let bookAdded = false;
      if (firstTime && firstTime.add.checked) {
        const entry = { label: firstTime.label.value.trim(), address: tx.Destination, isExchange: firstTime.ex.checked, requiresTag: firstTime.tag.checked };
        if (!entry.label) throw new Error('Give the new destination a label, or untick "Add it to the address book".');
        if ((entry.isExchange || entry.requiresTag) && tx.DestinationTag === undefined) {
          throw new Error('This destination needs a destination tag, but the transaction has none. Nothing was signed; build a new envelope with the tag.');
        }
        next = { ...payload, accounts: payload.accounts.map((a) => (a.address === account.address ? { ...a, addressBook: [...a.addressBook, entry] } : a)) };
        bookAdded = true;
      }
      finalCheck(tx, { multisigned: false, ownerReserveDrops: env.ownerReserveDrops, addressBook: ctx.addressBook, vaultAddresses: payload.accounts.map((a) => a.address) }, ackUi.given);
      key = keyFromSeed(account.regularKey.seed);
      const signed = signTx(tx, key);
      assertVerified([signed]);
      wipeKey(key);
      key = null;

      const saveNeeded = (resolved && resolved.changed) || bookAdded;
      let saved = null;
      if (saveNeeded) {
        saved = await saveVault(next, pass, progress);
        session.vault = { network: next.network, fileName: saved.filename, fileText: saved.text, payload: next };
      }
      show('Signed',
        saved ? warnBox(`The vault changed (${bookAdded ? 'address book' : 'key rotation result'}). Your browser saved ${saved.filename}. Keep it with your vault files.`) : null,
        signedOutput([signed], ctxFor(next, tx.Account)),
        note('Scan the QR code with the online device, then press Done.'),
        doneButton());
    } catch (e) {
      if (key) wipeKey(key);
      replace(msg, errorBox(String(e.message || e)));
      step.button.disabled = false;
    }
  });

  show('Review and sign',
    resolutionNotes(resolved),
    txCard(tx, { ctx }),
    expiryNote(env),
    firstTime ? firstTime.el : null,
    ackUi.el,
    step.el,
    msg);
}
