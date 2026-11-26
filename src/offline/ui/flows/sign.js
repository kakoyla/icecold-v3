// SPEC §4.4 generic signing flow, for the plain `sign` purpose (Send and
// AccountSet, DECISIONS A9).
import { h, replace } from '../dom.js';
import { session } from '../session.js';
import { keyFromSeed, signTx, wipeKey } from '../../core/keys.js';
import { describeTx } from '../../core/describe.js';
import { errorBox, note, txCard, ackPanel, passphraseStep, saveVault, signedOutput, warnBox, firstTimeDestination, withBookEntry } from '../widgets.js';
import { show, setNetwork } from '../app.js';
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

  // SPEC §4.4 step 3: first-time destinations get an extra confirmation.
  const firstTime = firstTimeDestination(tx, d.firstTimeDestination);

  const ackUi = ackPanel([acks]);
  const step = passphraseStep(async (pass, { progress }) => {
    let key = null;
    try {
      const entry = firstTime ? firstTime.entry() : null;
      if (!ackUi.ok()) throw new Error('Tick or type every item under "Check these before signing" first.');
      const next = withBookEntry(payload, account.address, entry);
      const bookAdded = !!entry;
      finalCheck(tx, { multisigned: false, ownerReserveDrops: env.ownerReserveDrops, addressBook: ctx.addressBook, vaultAddresses: payload.accounts.map((a) => a.address) }, ackUi.givenFor(0));
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
