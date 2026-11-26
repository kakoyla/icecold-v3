// SPEC §6 / §4.7 Estate Transfer: no vault, no passphrase, only a spare paper.
// Confirm the network on screen (A3), check the summary twice, type the
// spare (Seed Repair if needed), confirm it is in the signer list, multi-sign.
import { h, replace } from '../dom.js';
import { onWipe } from '../session.js';
import { multisignTx, wipeKey } from '../../core/keys.js';
import { spareInSignerList } from '../../core/envelope.js';
import { describeTx } from '../../core/describe.js';
import { segments } from '../dom.js';
import { button, errorBox, okBox, note, txCard, ackPanel, signedOutput, seedEntry, warnBox } from '../widgets.js';
import { show, showStep, setNetwork } from '../app.js';
import { prepare, showRefused, expiryNote, finalCheck, assertVerified, doneButton } from './common.js';
import { confirmNetwork } from './recovery.js';

export function estateFlow(env) {
  confirmNetwork(env, 'Estate Transfer', (n) => start(env, n));
}

function start(env, confirmedNetwork) {
  setNetwork(env.network);
  const { v } = prepare(env, { useVault: false, confirmedNetwork });
  if (!v.ok) return showRefused(env, v, null);
  const { tx, acks } = v.txs[0];
  const acct = tx.Account;
  const signers = (env.ledger[acct].signerList?.entries || []).map((e) => e.account);
  const d = describeTx(tx, {});
  const ackUi = ackPanel([acks]);
  const msg = h('div');
  let spare = null;
  onWipe(() => { if (spare) wipeKey(spare); spare = null; });

  const check1 = h('input', { type: 'checkbox' });
  const check2 = h('input', { type: 'checkbox' });
  const second = h('div', { class: 'hidden' },
    h('div', { class: 'card summary-again' },
      h('h3', { text: 'Check it a second time' }),
      h('p', { class: 'summary' }, segments(d.summary)),
      h('p', { text: 'Read the destination address and the tag aloud against the letter or the receiving account. A wrong tag on an exchange can lose the funds.' }),
      h('label', { class: 'check' }, check2, ' I checked the amount, the destination and the tag a second time.')));
  const spareBox = h('div', { class: 'hidden' },
    h('div', { class: 'card' },
      h('h3', { text: 'Type the spare seed from the paper' }),
      note('Wi-Fi must be off. Nobody legitimate ever asks for this seed remotely. A "wallet recovery service" that asks for it is theft.'),
      seedEntry((k) => afterSpare(k), { label: 'Spare seed', signerAddresses: signers, confirmLabel: 'Check spare and sign' })));
  check1.addEventListener('change', () => second.classList.toggle('hidden', !check1.checked));
  check2.addEventListener('change', () => spareBox.classList.toggle('hidden', !(check1.checked && check2.checked)));

  function afterSpare(k) {
    spare = k;
    try {
      if (!(check1.checked && check2.checked)) throw new Error('Check the summary twice first.');
      if (!ackUi.ok()) throw new Error('Tick or type every item under "Check these before signing" first.');
      if (!spareInSignerList(env, acct, spare.address)) {
        throw new Error(`This spare (${spare.address}) is not in the signer list of ${acct}. Nothing was signed. Check that this is the right paper for this account.`);
      }
      finalCheck(tx, { multisigned: true, ownerReserveDrops: env.ownerReserveDrops, requireTag: true }, ackUi.givenFor(0));
      const signed = multisignTx(tx, spare);
      assertVerified([signed]);
      wipeKey(spare);
      spare = null;
      show('Estate Transfer signed',
        okBox('Signed. Scan the QR code with the online device and submit it.'),
        signedOutput([signed], {}),
        note('Once the funds arrive at the destination, cold storage for this account is over and the spare paper can be destroyed.'),
        doneButton('Done: wipe'));
    } catch (e) {
      if (spare) wipeKey(spare);
      spare = null;
      replace(msg, errorBox(String(e.message || e)));
    }
  }

  show('Estate Transfer',
    warnBox(`${env.network.toUpperCase()} transfer. This moves the funds out of cold storage.`),
    txCard(tx, {}),
    expiryNote(env),
    ackUi.el,
    h('div', { class: 'card' }, h('label', { class: 'check' }, check1, ' I have read the summary above and it is what I expect.')),
    second,
    spareBox,
    msg);
}
