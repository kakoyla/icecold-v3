// SPEC §4.9 Migration, with DECISIONS A10 (order) and A15 (vault gate).
//   1. enter the shared regular key (typed with Seed Repair, or scanned)
//   2. per kept account: label, new regular key (pending), spare shown,
//      spare typed back, both templates filled
//   3. save the vault with every new key pending; gate checks all of them
//   4. sign every transaction with the shared key, in envelope order
//   5. show the numbered signed QR codes; wipe the shared key
import { h, replace, textInput } from '../dom.js';
import { session, onWipe } from '../session.js';
import { generateKey, keyFromSeed, signTx, wipeKey } from '../../core/keys.js';
import { emptyPayload, storedKey } from '../../core/vault.js';
import { fillRegularKey, fillSignerList } from '../../core/envelope.js';
import { isValidSeed } from '../../core/seedrepair.js';
import {
  button, errorBox, okBox, note, txCard, ackPanel, passphraseStep, newPassphrase, saveVault, signedOutput,
  savedVaultGate, seedEntry, progress, warnBox,
} from '../widgets.js';
import { scanner } from '../qr.js';
import { show, showStep, setNetwork } from '../app.js';
import { prepare, ctxFor, showRefused, expiryNote, finalCheck, assertVerified, doneButton } from './common.js';
import { spareCeremony } from './replace.js';
import { confirmNetwork } from './recovery.js';

export function migrationFlow(env) {
  setNetwork(env.network);
  if (session.vault && session.vault.network !== env.network) {
    show('Migration', errorBox(`The open vault is ${session.vault.network.toUpperCase()} but this envelope is for ${String(env.network).toUpperCase()}. Lock the vault first.`));
    return;
  }
  // No vault open: the new vault's network is confirmed on screen (A3).
  if (session.vault) start(env, undefined);
  else confirmNetwork(env, 'Migration', (n) => start(env, n));
}

function start(env, confirmedNetwork) {
  setNetwork(env.network);
  const txsIn = Array.isArray(env.txs) ? env.txs : [];
  const kept = [...new Set(txsIn.filter((t) => t && t.TransactionType === 'SetRegularKey').map((t) => t.Account))];
  const { v, payload } = prepare(env, { extraAccounts: kept, confirmedNetwork });
  if (!v.ok) return showRefused(env, v, payload);
  const deleted = [...new Set(env.txs.filter((t) => t.TransactionType === 'AccountDelete').map((t) => t.Account))];
  const ackUi = ackPanel(v.txs.flatMap((t) => t.acks));

  // Flow state; every secret is wiped on lock, Home or Done.
  let shared = null;
  let pass = null;
  const newKeys = new Map(); // account -> key
  const spares = new Map(); // account -> spare address
  const labels = new Map();
  const wipe = () => {
    if (shared) wipeKey(shared);
    shared = null;
    for (const k of newKeys.values()) wipeKey(k);
    newKeys.clear();
    pass = null;
  };
  onWipe(wipe);

  // ---- step 1: the shared key ----
  const keyMsg = h('div');
  const useShared = (k) => {
    if (!ackUi.ok()) { wipeKey(k); replace(keyMsg, errorBox('Tick or type every item under "Check these before signing" first.')); return; }
    const notUsing = env.txs.map((t) => t.Account).filter((a, i, all) => all.indexOf(a) === i)
      .filter((a) => env.ledger[a].regularKey !== k.address);
    if (notUsing.length) {
      wipeKey(k);
      replace(keyMsg, errorBox(`That key (${k.address}) is not the regular key of: ${notUsing.join(', ')}. Check the paper.`));
      return;
    }
    shared = k;
    nextAccount(0);
  };
  let sc = null;
  const scanBox = h('div');
  const scanBtn = button('Scan the shared key from paper with the webcam', () => {
    if (sc) return;
    sc = scanner((text) => {
      const s = text.trim();
      if (!isValidSeed(s)) { replace(keyMsg, errorBox('That QR code is not a valid seed.')); return false; }
      sc = null;
      replace(scanBox);
      useShared(keyFromSeed(s));
      return true;
    }, { hint: 'Hold the shared-key paper up to the webcam.' });
    replace(scanBox, sc.el);
  });

  // ---- step 2: each kept account ----
  function nextAccount(i) {
    if (i >= kept.length) return vaultStep();
    const acct = kept[i];
    const existing = session.vault && session.vault.payload.accounts.find((a) => a.address === acct);
    const label = textInput({ placeholder: `Label for ${acct}`, value: existing ? existing.label : '' });
    const msg = h('div');
    showStep(`Migration: account ${i + 1} of ${kept.length}`,
      okBox(`Shared key confirmed: ${shared.address}`),
      h('div', { class: 'card' },
        h('p', {}, 'Account: ', h('strong', { class: 'mono', text: acct })),
        h('label', { class: 'field' }, h('span', { text: 'Label (e.g. Personal, Managed)' }), label),
        button('Make the new key and spare', () => {
          const l = label.value.trim();
          if (!l) { replace(msg, errorBox('Give the account a label.')); return; }
          labels.set(acct, l);
          newKeys.set(acct, generateKey('ed25519'));
          spareCeremony({
            label: l,
            title: `Migration: spare for ${l}`,
            before: [note(`Account ${i + 1} of ${kept.length}. The new regular key is made and will be saved in the vault as pending.`)],
            onVerified: (spareAddr) => { spares.set(acct, spareAddr); nextAccount(i + 1); },
          });
        }, 'primary'),
        msg));
  }

  // ---- step 3: fill, check, save, gate ----
  let filled = null;
  function fillAll() {
    filled = env.txs.map((tx) => {
      if (tx.TransactionType === 'SignerListSet') return fillSignerList(tx, spares.get(tx.Account));
      if (tx.TransactionType === 'SetRegularKey') return fillRegularKey(tx, newKeys.get(tx.Account).address);
      return tx;
    });
    const vaultAddresses = [...(session.vault ? session.vault.payload.accounts.map((a) => a.address) : []), ...kept];
    for (const tx of filled) finalCheck(tx, { multisigned: false, ownerReserveDrops: env.ownerReserveDrops, vaultAddresses }, ackUi.given);
  }

  function nextPayload(base) {
    let accounts = base.accounts.slice();
    for (const acct of kept) {
      const pending = storedKey(newKeys.get(acct));
      const i = accounts.findIndex((a) => a.address === acct);
      if (i >= 0) accounts[i] = { ...accounts[i], label: labels.get(acct), pendingKey: pending };
      else accounts.push({ label: labels.get(acct), address: acct, regularKey: null, pendingKey: pending, retiredKeys: [], addressBook: [] });
    }
    return { ...base, accounts };
  }

  function vaultStep() {
    const msg = h('div');
    const prog = progress('Encrypting…');
    const run = async (p, base) => {
      try {
        pass = p;
        fillAll();
        const next = nextPayload(base);
        const saved = await saveVault(next, pass, prog);
        showStep('Migration: check the saved vault', savedVaultGate({
          filename: saved.filename, passphrase: () => pass, network: env.network,
          expected: kept.map((a) => ({ account: a, pending: newKeys.get(a).address })),
          onPass: finish,
        }));
      } catch (e) {
        replace(msg, errorBox(String(e.message || e)));
      }
    };
    const body = session.vault
      ? passphraseStep((p, { progress: pr }) => run(p, session.vault.payload), { label: 'Save vault with the new keys', intro: `The new keys go into the open vault (${session.vault.fileName}).` }).el
      : h('div', {}, h('p', { text: `A new ${env.network.toUpperCase()} vault is made for the kept accounts.` }), newPassphrase((p) => run(p, emptyPayload(env.network)), { label: 'Create vault with the new keys' }));
    showStep('Migration: save the vault',
      okBox(`All ${kept.length} spare(s) checked.`),
      filledCards(),
      body, prog.el, msg);
  }

  function filledCards() {
    try { fillAll(); } catch (e) { return errorBox(String(e.message || e)); }
    const ctx = { accounts: [...kept.map((a) => ({ address: a, label: labels.get(a) }))] };
    return filled.map((tx, i) => txCard(tx, { index: i, total: filled.length, ctx }));
  }

  // ---- step 4-5: sign with the shared key, show numbered QRs ----
  function finish() {
    try {
      const signed = filled.map((tx) => signTx(tx, shared));
      assertVerified(signed);
      const ctx = { accounts: kept.map((a) => ({ address: a, label: labels.get(a) })) };
      wipe();
      show('Migration signed',
        note('Scan and submit these in order, 1 first. The shared key has been wiped from memory.'),
        signedOutput(signed, ctx),
        warnBox('After the online post-checks pass, the shared regular key is retired. Destroy its paper backups only after acceptance (SPEC §7.5).'),
        doneButton());
    } catch (e) {
      wipe();
      show('Migration failed', errorBox(String(e.message || e)));
    }
  }

  show('Migration',
    h('div', { class: 'card' },
      h('p', { text: `Kept accounts: ${kept.length}. Accounts to delete: ${deleted.length}. Transactions to sign: ${env.txs.length}.` }),
      note('For each kept account, the signer list (spare) is set before the regular key changes (DECISIONS A10).')),
    v.txs.map((t, i) => txCard(t.tx, { index: i, total: v.txs.length, ctx: ctxFor(payload, t.tx.Account), template: t.template })),
    expiryNote(env),
    ackUi.el,
    h('div', { class: 'card' },
      h('h3', { text: 'Step 1: the shared regular key' }),
      note('Type it from the paper, or scan it. It is held only for this session.'),
      seedEntry(useShared, { label: 'Shared regular key', confirmLabel: 'Use this key' }),
      scanBtn, scanBox, keyMsg));
}
