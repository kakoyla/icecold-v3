// SPEC §4.4 step 2 and §5.3: validate an envelope from the online side,
// then run the §4.8 checks on each transaction.
//
// Envelope (JSON):
//   { version: 1, network, purpose, txs: [...],
//     ledger: { <address>: { balance, reserve, regularKey, signerList, masterDisabled } },
//     ownerReserveDrops,                    // DECISIONS A4
//     builtAt: { ledgerIndex, closeTime } } // DECISIONS A6
import { isValidAddress } from './keys.js';
import { checkTransaction } from './safety.js';
import { NETWORKS, PURPOSES, LEDGER_INTERVAL_ESTIMATE_S } from './config.js';

const ENVELOPE_FIELDS = ['version', 'network', 'purpose', 'txs', 'ledger', 'ownerReserveDrops', 'builtAt'];
const SNAPSHOT_FIELDS = ['balance', 'reserve', 'regularKey', 'signerList', 'masterDisabled'];
// DECISIONS A3: purposes where the account need not be in the vault.
const VAULT_EXEMPT = new Set(['recovery', 'estate', 'migration']);
const MULTISIGNED = new Set(['recovery', 'estate']);
const DROPS_RE = /^(0|[1-9]\d{0,17})$/;

/** Per-purpose shape: allowed types per position, and which txs are templates. */
function purposeShape(env, err) {
  const t = env.txs.map((x) => x && x.TransactionType);
  const one = (type) => {
    if (t.length !== 1 || t[0] !== type) err('purpose-shape', `${env.purpose} needs exactly one ${type}`);
  };
  switch (env.purpose) {
    case 'sign':
      if (t.length !== 1) err('purpose-shape', 'sign needs exactly one transaction');
      return { templates: [false] };
    case 'rotate':
      one('SetRegularKey');
      return { templates: [true] };
    case 'send-rotate': {
      if (t.length !== 2 || t[0] !== 'Payment' || t[1] !== 'SetRegularKey') {
        err('purpose-shape', 'send-rotate needs a Payment then a SetRegularKey');
        return { templates: [false, true] };
      }
      const [p, s] = env.txs;
      if (p.Account !== s.Account) err('purpose-shape', 'send-rotate transactions must use the same Account');
      if (!(Number.isInteger(p.Sequence) && s.Sequence === p.Sequence + 1)) {
        err('purpose-shape', 'SetRegularKey Sequence must be Payment Sequence + 1');
      }
      return { templates: [false, true] };
    }
    case 'recovery':
      one('SetRegularKey');
      return { templates: [true] };
    case 'estate':
      one('Payment');
      return { templates: [false] };
    case 'replace-spare':
      one('SignerListSet');
      return { templates: [true] };
    case 'migration': {
      const ok = ['SetRegularKey', 'SignerListSet', 'AccountDelete'];
      if (t.length === 0 || t.some((x) => !ok.includes(x))) {
        err('purpose-shape', 'migration holds only SetRegularKey, SignerListSet and AccountDelete');
      }
      return { templates: t.map((x) => x === 'SetRegularKey' || x === 'SignerListSet') };
    }
    default:
      return { templates: t.map(() => false) };
  }
}

function checkSnapshot(addr, s, err) {
  const w = `ledger[${addr}]`;
  if (!isValidAddress(addr)) err('ledger', `${w}: not a valid address`);
  if (!s || typeof s !== 'object') { err('ledger', `${w}: missing`); return; }
  for (const k of Object.keys(s)) if (!SNAPSHOT_FIELDS.includes(k)) err('ledger', `${w}: unexpected field ${k}`);
  for (const k of SNAPSHOT_FIELDS) if (!(k in s)) err('ledger', `${w}: missing ${k}`);
  const isDrops = (v) => typeof v === 'string' && DROPS_RE.test(v);
  if (!isDrops(s.balance) || !isDrops(s.reserve)) err('ledger', `${w}: balance/reserve must be drops strings`);
  if (s.regularKey !== null && !isValidAddress(s.regularKey)) err('ledger', `${w}: bad regularKey`);
  if (typeof s.masterDisabled !== 'boolean') err('ledger', `${w}: masterDisabled must be true/false`);
  if (s.signerList !== null) {
    const l = s.signerList;
    if (!l || !Number.isInteger(l.quorum) || !Array.isArray(l.entries) ||
        !l.entries.every((e) => e && isValidAddress(e.account) && Number.isInteger(e.weight))) {
      err('ledger', `${w}: bad signerList`);
    }
  }
}

/**
 * @param env   parsed envelope
 * @param ctx   { vault: payload|null, confirmedNetwork?: string }
 *              With no vault (estate, recovery), confirmedNetwork must equal
 *              env.network: the user confirmed it on screen (DECISIONS A3).
 * @returns { ok, errors, txs: [{ tx, template, errors, acks }] }
 *          ok = no envelope or transaction errors (acks may still be due).
 */
export function validateEnvelope(env, ctx = {}) {
  const errors = [];
  const err = (code, message) => errors.push({ code, message });
  const result = (txs = []) => ({ ok: errors.length === 0 && txs.every((t) => t.errors.length === 0), errors, txs });

  if (!env || typeof env !== 'object' || Array.isArray(env)) { err('envelope', 'envelope must be an object'); return result(); }
  for (const k of Object.keys(env)) if (!ENVELOPE_FIELDS.includes(k)) err('envelope', `unexpected envelope field ${k}`);
  for (const k of ENVELOPE_FIELDS) if (!(k in env)) err('envelope', `envelope is missing ${k}`);
  if (env.version !== 1) err('version', `unsupported envelope version ${env.version}`);
  if (!NETWORKS.includes(env.network)) err('network', 'envelope network must be mainnet or testnet');
  if (!PURPOSES.includes(env.purpose)) err('purpose', `unknown purpose ${JSON.stringify(env.purpose)}`);
  if (!Array.isArray(env.txs) || env.txs.length === 0) { err('txs', 'envelope has no transactions'); return result(); }
  if (!env.ledger || typeof env.ledger !== 'object') { err('ledger', 'envelope has no ledger snapshot'); return result(); }
  if (typeof env.ownerReserveDrops !== 'string' || !DROPS_RE.test(env.ownerReserveDrops)) {
    err('envelope', 'ownerReserveDrops must be a drops string');
  }
  if (!env.builtAt || !Number.isInteger(env.builtAt.ledgerIndex) || Number.isNaN(Date.parse(env.builtAt.closeTime))) {
    err('envelope', 'builtAt needs ledgerIndex and closeTime');
  }
  if (errors.length) return result();

  // SPEC §4.8 network: the envelope's network must match the vault's.
  const vault = ctx.vault || null;
  if (vault) {
    if (vault.network !== env.network) err('network-mismatch', `envelope is for ${env.network} but the vault is ${vault.network}`);
  } else if (ctx.confirmedNetwork !== env.network) {
    err('network-unconfirmed', `confirm on screen that this is a ${env.network.toUpperCase()} transaction`);
  }

  const { templates } = purposeShape(env, err);
  for (const [addr, snap] of Object.entries(env.ledger)) checkSnapshot(addr, snap, err);

  const vaultAccounts = vault ? vault.accounts : [];
  const vaultAddresses = vaultAccounts.map((a) => a.address);
  const multisigned = MULTISIGNED.has(env.purpose);

  const txs = env.txs.map((tx, i) => {
    const acct = tx && tx.Account;
    const inVault = vaultAccounts.find((a) => a.address === acct);
    const r = checkTransaction(tx, {
      multisigned,
      template: !!templates[i],
      ownerReserveDrops: env.ownerReserveDrops,
      addressBook: inVault ? inVault.addressBook : [],
      vaultAddresses,
      requireTag: env.purpose === 'estate',
    });
    if (acct && !(acct in env.ledger)) r.errors.push({ code: 'ledger-missing', message: `no ledger snapshot for ${acct}` });
    if (!VAULT_EXEMPT.has(env.purpose) && !inVault) {
      r.errors.push({ code: 'account-not-in-vault', message: `${acct} is not in this vault` });
    }
    return { tx, template: !!templates[i], ...r };
  });

  return result(txs);
}

/** DECISIONS A6: estimated expiry time of a transaction. */
export function estimateExpiry(env, tx) {
  const ledgersLeft = tx.LastLedgerSequence - env.builtAt.ledgerIndex;
  return new Date(Date.parse(env.builtAt.closeTime) + ledgersLeft * LEDGER_INTERVAL_ESTIMATE_S * 1000);
}

// ---------- template fill-in (SPEC §0 principle 1 exception, §4.5, §4.9) ----------

/** Fill a SetRegularKey template with the newly generated key's address. */
export function fillRegularKey(tx, newKeyAddress) {
  if (tx.TransactionType !== 'SetRegularKey' || 'RegularKey' in tx) throw new Error('not an empty SetRegularKey template');
  if (!isValidAddress(newKeyAddress)) throw new Error('bad RegularKey address');
  return { ...tx, RegularKey: newKeyAddress };
}

/** Fill a SignerListSet template: quorum 1, one entry (the spare), weight 1 (SPEC §2). */
export function fillSignerList(tx, spareAddress) {
  if (tx.TransactionType !== 'SignerListSet' || 'SignerEntries' in tx || tx.SignerQuorum !== 1) {
    throw new Error('not an empty SignerListSet template with SignerQuorum 1');
  }
  if (!isValidAddress(spareAddress)) throw new Error('bad spare address');
  return { ...tx, SignerEntries: [{ SignerEntry: { Account: spareAddress, SignerWeight: 1 } }] };
}

/** SPEC §4.6 step 2: is this spare address in the account's ledger signer list? */
export function spareInSignerList(env, account, spareAddress) {
  const s = env.ledger[account];
  return !!(s && s.signerList && s.signerList.entries.some((e) => e.account === spareAddress));
}
