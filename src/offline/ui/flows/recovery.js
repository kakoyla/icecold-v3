// SPEC §4.6 Recovery, with DECISIONS A14 (where the new key goes, A2 gate).
//   1. type the spare (Seed Repair if the checksum fails)
//   2. confirm the spare is in the ledger's signer list; stop if not
//   3. generate a new regular key into the open vault, or a new vault
//   4. multi-sign the SetRegularKey with the spare
//   5. show the signed QR, then prompt to replace the spare
import { h, replace, textInput } from '../dom.js';
import { session, onWipe } from '../session.js';
import { generateKey, multisignTx, wipeKey } from '../../core/keys.js';
import { emptyPayload, storedKey } from '../../core/vault.js';
import { fillRegularKey, spareInSignerList } from '../../core/envelope.js';
import {
  button, errorBox, okBox, note, txCard, ackPanel, passphraseStep, newPassphrase, saveVault, signedOutput,
  savedVaultGate, bigAddress, seedEntry, progress, warnBox,
} from '../widgets.js';
import { show, showStep, setNetwork } from '../app.js';
import { prepare, ctxFor, showRefused, expiryNote, finalCheck, assertVerified, doneButton } from './common.js';

/** No vault open: the user confirms the network on screen (DECISIONS A3). */
export function confirmNetwork(env, title, onConfirmed) {
  setNetwork(env.network);
  const msg = h('div');
  const pick = (n) => {
    if (n !== env.network) {
      replace(msg, errorBox(`This envelope is for ${String(env.network).toUpperCase()}, not ${n.toUpperCase()}. Nothing will be signed. Check where the envelope came from.`));
      return;
    }
    onConfirmed(n);
  };
  show(title,
    h('div', { class: 'card' },
      h('p', { text: 'No vault is open, so confirm the network yourself. Which network is this for? Check the Online Builder screen or the letter.' }),
      h('div', { class: 'buttons' }, button('MAINNET', () => pick('mainnet'), 'net-mainnet big'), button('TESTNET', () => pick('testnet'), 'net-testnet big'))),
    msg);
}

export function recoveryFlow(env) {
  if (session.vault && session.vault.network !== env.network) {
    setNetwork(env.network);
    show('Recovery', errorBox(`The open vault is ${session.vault.network.toUpperCase()} but this envelope is for ${String(env.network).toUpperCase()}. Lock the vault first.`));
    return;
  }
  if (session.vault) start(env, null);
  else confirmNetwork(env, 'Recovery', (n) => start(env, n));
}

function start(env, confirmedNetwork) {
  setNetwork(env.network);
  const { v, payload } = prepare(env, { confirmedNetwork });
  if (!v.ok) return showRefused(env, v, payload);
  const { tx, acks } = v.txs[0];
  const acct = tx.Account;
  const signers = (env.ledger[acct].signerList?.entries || []).map((e) => e.account);
  const ackUi = ackPanel(acks);
  const msg = h('div');
  let spare = null;
  let newKey = null;
  let pass = null;
  const wipe = () => { for (const k of [spare, newKey]) if (k) wipeKey(k); spare = null; newKey = null; pass = null; };
  onWipe(wipe);

  const afterSpare = (k) => {
    spare = k;
    // Step 2: the spare must be in the ledger's signer list.
    if (!spareInSignerList(env, acct, spare.address)) {
      const addr = spare.address;
      wipe();
      showStep('Recovery stopped', errorBox(`The spare's address ${addr} is not in the signer list of ${acct}. Nothing was signed. Check that this is the right spare paper for this account.`));
      return;
    }
    showStep('Recovery: new key and vault',
      okBox(`Spare confirmed: ${spare.address} is in the signer list.`),
      session.vault ? toOpenVault() : toNewVault(),
      msg);
  };

  const existing = () => session.vault && session.vault.payload.accounts.find((a) => a.address === acct);

  const nextPayload = (base, label) => {
    newKey = generateKey('ed25519');
    const pending = storedKey(newKey);
    const accounts = base.accounts.some((a) => a.address === acct)
      ? base.accounts.map((a) => (a.address === acct ? { ...a, pendingKey: pending } : a))
      : [...base.accounts, { label, address: acct, regularKey: null, pendingKey: pending, retiredKeys: [], addressBook: [] }];
    return { ...base, accounts };
  };

  const labelInput = textInput({ placeholder: 'Account label, e.g. Personal' });

  function toOpenVault() {
    const known = existing();
    const step = passphraseStep(async (p, { progress: prog }) => run(p, () => {
      if (!known && !labelInput.value.trim()) throw new Error('Give the account a label.');
      return nextPayload(session.vault.payload, labelInput.value.trim());
    }, prog), { label: 'Make new key, save vault' });
    return h('div', {},
      h('p', { text: `The new key goes into the open vault (${session.vault.fileName}) as a pending key.` }),
      known ? null : h('label', { class: 'field' }, h('span', { text: 'This account is not in the vault yet. Label:' }), labelInput),
      step.el);
  }

  function toNewVault() {
    const prog = progress('Encrypting…');
    return h('div', {},
      h('p', { text: `No vault is open, so a new ${env.network.toUpperCase()} vault is made for the new key.` }),
      h('label', { class: 'field' }, h('span', { text: 'Account label' }), labelInput),
      newPassphrase((p) => run(p, () => {
        if (!labelInput.value.trim()) throw new Error('Give the account a label.');
        return nextPayload(emptyPayload(env.network), labelInput.value.trim());
      }, prog), { label: 'Make new key, create vault' }),
      prog.el);
  }

  async function run(p, makePayload, prog) {
    try {
      if (!ackUi.ok()) throw new Error('Tick or type every item under "Check these before signing" first.');
      pass = p;
      const next = makePayload();
      const filled = fillRegularKey(tx, newKey.address);
      finalCheck(filled, { multisigned: true, ownerReserveDrops: env.ownerReserveDrops, vaultAddresses: [] }, ackUi.given);
      const saved = await saveVault(next, pass, prog);
      showStep('Recovery: check the saved vault', savedVaultGate({
        filename: saved.filename, passphrase: () => pass, network: env.network,
        expected: [{ account: acct, pending: newKey.address }],
        onPass: () => finish(filled),
      }));
    } catch (e) {
      if (newKey) wipeKey(newKey);
      newKey = null;
      replace(msg, errorBox(String(e.message || e)));
    }
  }

  function finish(filled) {
    try {
      const signed = multisignTx(filled, spare);
      assertVerified([signed]);
      const addr = newKey.address;
      wipe();
      show('Recovery signed',
        signedOutput([signed], ctxFor(session.vault && session.vault.payload, acct)),
        bigAddress(addr, 'New regular key (pending until the ledger shows it):'),
        warnBox('Your spare is now used. Make a new spare and replace it with SignerListSet: build a Replace Spare envelope on the Online Builder and scan it here.'),
        doneButton());
    } catch (e) {
      wipe();
      show('Recovery failed', errorBox(String(e.message || e)));
    }
  }

  show('Recovery',
    txCard(tx, { ctx: ctxFor(payload, acct), template: true }),
    expiryNote(env),
    ackUi.el,
    h('div', { class: 'card' },
      h('h3', { text: 'Type the spare seed from the paper card' }),
      note('Wi-Fi must be off. Nobody legitimate ever asks for this seed.'),
      seedEntry(afterSpare, { label: 'Spare seed', signerAddresses: signers, confirmLabel: 'Check spare' })),
    msg);
}
