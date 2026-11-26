// SPEC §4.5 Send & Rotate and Rotate-only: one screen, one passphrase.
//   1. generate a new regular key and fill it into the SetRegularKey
//   2. write a new vault file with the new key marked pending
//   3. gate: re-open the saved vault and confirm the pending key (A2)
//   4. sign every transaction with the current key
//   5. show the signed QR codes and the new key's address
import { h, replace } from '../dom.js';
import { onWipe } from '../session.js';
import { generateKey, keyFromSeed, signTx, wipeKey } from '../../core/keys.js';
import { storedKey } from '../../core/vault.js';
import { fillRegularKey } from '../../core/envelope.js';
import { errorBox, note, txCard, ackPanel, passphraseStep, saveVault, signedOutput, savedVaultGate, bigAddress } from '../widgets.js';
import { show, showStep, setNetwork } from '../app.js';
import {
  prepare, ctxFor, showRefused, blockedByPending, resolutionNotes, expiryNote, finalCheck, assertVerified, doneButton,
} from './common.js';

export function rotateFlow(env) {
  setNetwork(env.network);
  const { v, payload, resolved } = prepare(env);
  if (!v.ok) return showRefused(env, v, payload);
  if (blockedByPending(env, resolved)) return;

  const acctAddr = v.txs[0].tx.Account;
  const account = payload.accounts.find((a) => a.address === acctAddr);
  const ctx = ctxFor(payload, acctAddr);
  const ackUi = ackPanel(v.txs.flatMap((t) => t.acks));
  const msg = h('div');
  const isSend = env.purpose === 'send-rotate';

  let newKey = null;
  let pass = null;
  const wipe = () => { if (newKey) wipeKey(newKey); newKey = null; pass = null; };
  onWipe(wipe);

  const step = passphraseStep(async (p, { progress }) => {
    try {
      if (!ackUi.ok()) throw new Error('Tick or type every item under "Check these before signing" first.');
      pass = p;
      // 1. New key, filled into the template.
      newKey = generateKey('ed25519');
      const txs = v.txs.map((t) => (t.template ? fillRegularKey(t.tx, newKey.address) : t.tx));
      const checkCtx = { multisigned: false, ownerReserveDrops: env.ownerReserveDrops, addressBook: ctx.addressBook, vaultAddresses: payload.accounts.map((a) => a.address) };
      for (const tx of txs) finalCheck(tx, checkCtx, ackUi.given);
      // 2. Vault with the new key pending.
      const next = { ...payload, accounts: payload.accounts.map((a) => (a.address === acctAddr ? { ...a, pendingKey: storedKey(newKey) } : a)) };
      const saved = await saveVault(next, pass, progress);
      // 3. Gate, then 4-5.
      showStep(isSend ? 'Send & Rotate: check the saved vault' : 'Rotate: check the saved vault',
        savedVaultGate({
          filename: saved.filename, passphrase: () => pass, network: env.network,
          expected: [{ account: acctAddr, pending: newKey.address }],
          onPass: () => finish(txs),
        }));
    } catch (e) {
      wipe();
      replace(msg, errorBox(String(e.message || e)));
      step.button.disabled = false;
    }
  }, { label: isSend ? 'Make new key, save vault, sign both' : 'Make new key, save vault, sign' });

  function finish(txs) {
    let cur = null;
    try {
      cur = keyFromSeed(account.regularKey.seed);
      const signed = txs.map((tx) => signTx(tx, cur));
      assertVerified(signed);
      wipeKey(cur);
      const addr = newKey.address;
      wipe();
      show(isSend ? 'Signed: send and rotate' : 'Signed: rotate',
        note(isSend ? 'Submit them in order. The online side submits the key change only if the payment is validated.' : 'Submit this on the online device.'),
        signedOutput(signed, ctxFor(payload, acctAddr)),
        bigAddress(addr, 'New regular key (pending until the ledger shows it):'),
        doneButton());
    } catch (e) {
      if (cur) wipeKey(cur);
      wipe();
      show('Signing failed', errorBox(String(e.message || e)), note('Nothing was shown to scan. The saved vault holds a pending key that will be discarded at the next signing if it never reaches the ledger.'));
    }
  }

  show(isSend ? 'Send & Rotate' : 'Rotate key',
    resolutionNotes(resolved),
    v.txs.map((t, i) => txCard(t.tx, { index: i, total: v.txs.length, ctx, template: t.template })),
    expiryNote(env),
    ackUi.el,
    note('One passphrase does it all: a new key is made here, the vault is saved with it as pending, you pick the saved file back in to prove it is there, and only then are the signed codes shown.'),
    step.el,
    msg);
}
