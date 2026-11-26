// SPEC §3 and §4.8 hard safety checks on a single transaction.
//
// checkTransaction() returns { errors, acks }:
//   errors – block signing outright; nothing the user does can override them.
//   acks   – block signing until the user acknowledges each one. An ack with a
//            `phrase` must be typed exactly (e.g. deleting a signer list).
// canSign(result, given) is the single place that decides.
import { isValidAddress } from './keys.js';
import {
  SUPPORTED_TX_TYPES, FEE_CAP_SINGLE_DROPS, FEE_CAP_MULTI_DROPS, FEE_CAP_ACCOUNT_DELETE_EXTRA_DROPS,
  TF_PARTIAL_PAYMENT, TF_FULLY_CANONICAL_SIG, DELETE_SIGNER_LIST_PHRASE, MAX_OWNER_RESERVE_DROPS,
} from './config.js';

const MAX_DROPS = 100_000_000_000_000_000n; // 100 billion XRP
const DROPS_RE = /^(0|[1-9]\d{0,17})$/;

// DECISIONS A5: allowlists.
const COMMON_FIELDS = ['TransactionType', 'Account', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'SigningPubKey', 'SourceTag'];
const TYPE_FIELDS = {
  Payment: ['Amount', 'Destination', 'DestinationTag'],
  SetRegularKey: ['RegularKey'],
  SignerListSet: ['SignerQuorum', 'SignerEntries'],
  AccountSet: ['SetFlag', 'ClearFlag', 'Domain', 'EmailHash', 'MessageKey', 'TransferRate', 'TickSize', 'NFTokenMinter'],
  AccountDelete: ['Destination', 'DestinationTag'],
};
// Refused outright, whatever the user says.
const FORBIDDEN_FIELDS = {
  Paths: 'Payment paths are not allowed (XRP only)',
  SendMax: 'SendMax is not allowed (XRP only)',
  DeliverMin: 'DeliverMin is not allowed (partial payments only)',
  DeliverMax: 'DeliverMax is not allowed; use Amount in drops',
  NetworkID: 'NetworkID must not be set on mainnet or testnet',
  TxnSignature: 'input must be unsigned',
  Signers: 'input must be unsigned',
};

const isUInt32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const isDrops = (s) => typeof s === 'string' && DROPS_RE.test(s) && BigInt(s) <= MAX_DROPS;

export function feeCapDrops(tx, { multisigned, ownerReserveDrops }) {
  if (tx.TransactionType === 'AccountDelete') {
    if (ownerReserveDrops === undefined || !isDrops(String(ownerReserveDrops))) return null;
    if (BigInt(ownerReserveDrops) > MAX_OWNER_RESERVE_DROPS) return null;
    return BigInt(ownerReserveDrops) + FEE_CAP_ACCOUNT_DELETE_EXTRA_DROPS;
  }
  return multisigned ? FEE_CAP_MULTI_DROPS : FEE_CAP_SINGLE_DROPS;
}

/**
 * @param tx  unsigned transaction JSON
 * @param ctx {
 *   multisigned: boolean,
 *   template: boolean,           // SetRegularKey / SignerListSet still to be filled offline
 *   ownerReserveDrops: string,   // DECISIONS A4
 *   addressBook: [{address,isExchange,requiresTag}],
 *   vaultAddresses: string[],    // accounts in the vault (AccountDelete destination check)
 *   requireTag: boolean,         // DECISIONS A7 (estate)
 * }
 */
export function checkTransaction(tx, ctx = {}) {
  const errors = [];
  const acks = [];
  const err = (code, message, field) => errors.push({ code, message, field });
  const ack = (code, message, extra = {}) => acks.push({ code, message, key: `${code}:${extra.field || ''}`, ...extra });

  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    err('tx-shape', 'transaction must be an object');
    return { errors, acks };
  }
  const type = tx.TransactionType;
  if (!SUPPORTED_TX_TYPES.includes(type)) {
    err('unsupported-type', `transaction type ${JSON.stringify(type)} is not supported`);
    return { errors, acks };
  }

  // Fields: forbidden, then unknown.
  const allowed = new Set([...COMMON_FIELDS, ...TYPE_FIELDS[type]]);
  for (const f of Object.keys(tx)) {
    if (f in FORBIDDEN_FIELDS) err('forbidden-field', FORBIDDEN_FIELDS[f], f);
    else if (!allowed.has(f)) ack('unknown-field', `unknown field ${f} = ${JSON.stringify(tx[f])}`, { field: f });
  }

  // Common required fields.
  if (!isValidAddress(tx.Account)) err('account', 'Account is missing or invalid', 'Account');
  if (!isUInt32(tx.Sequence) || tx.Sequence === 0) err('sequence-missing', 'Sequence must be filled in', 'Sequence');
  if (!isUInt32(tx.LastLedgerSequence) || tx.LastLedgerSequence === 0) {
    err('lls-missing', 'LastLedgerSequence must be present', 'LastLedgerSequence');
  }
  if (tx.Flags !== undefined && !isUInt32(tx.Flags)) err('flags', 'Flags must be a 32-bit unsigned integer', 'Flags');
  if (tx.SourceTag !== undefined && !isUInt32(tx.SourceTag)) err('source-tag', 'SourceTag must be a 32-bit unsigned integer', 'SourceTag');

  // SigningPubKey: empty for multisign, absent for single-sign (we fill it).
  if (ctx.multisigned) {
    if (tx.SigningPubKey !== '') err('signing-pubkey', 'multi-signed transaction must have SigningPubKey ""', 'SigningPubKey');
  } else if (tx.SigningPubKey !== undefined) {
    err('signing-pubkey', 'single-signed input must not carry SigningPubKey', 'SigningPubKey');
  }

  // Fee cap.
  if (!isDrops(tx.Fee)) {
    err('fee-missing', 'Fee must be a drops string', 'Fee');
  } else {
    const cap = feeCapDrops(tx, ctx);
    if (cap === null) err('fee-cap-unknown', 'owner reserve missing or over the ceiling; cannot check AccountDelete fee', 'Fee');
    else if (BigInt(tx.Fee) > cap) err('fee-over-cap', `Fee ${tx.Fee} drops is over the cap of ${cap} drops`, 'Fee');
  }

  const flags = tx.Flags || 0;

  if (type === 'Payment') {
    if (typeof tx.Amount !== 'string') err('payment-not-xrp', 'Amount must be XRP in drops (a string)', 'Amount');
    else if (!isDrops(tx.Amount) || BigInt(tx.Amount) === 0n) err('payment-amount', 'Amount must be a positive drops value', 'Amount');
    if ((flags & TF_PARTIAL_PAYMENT) !== 0) err('payment-partial', 'partial payments (tfPartialPayment) are not allowed', 'Flags');
    const otherFlags = (flags & ~TF_PARTIAL_PAYMENT & ~TF_FULLY_CANONICAL_SIG) >>> 0;
    if (otherFlags !== 0) ack('unknown-flags', `unrecognised Payment flags 0x${otherFlags.toString(16)}`, { field: 'Flags' });
    if (!isValidAddress(tx.Destination)) err('destination', 'Destination is missing or invalid', 'Destination');
    else if (tx.Destination === tx.Account) err('payment-self', 'Destination must differ from Account', 'Destination');
    checkDestinationTag(tx, ctx, err, ack);
  }

  if (type === 'SetRegularKey') {
    if (!('RegularKey' in tx)) {
      if (!ctx.template) err('srk-removes-key', 'SetRegularKey without RegularKey would remove the key', 'RegularKey');
    } else if (ctx.template) {
      err('template-filled', 'rotation template must not carry a RegularKey; the offline side generates it', 'RegularKey');
    } else if (!isValidAddress(tx.RegularKey)) {
      err('regular-key', 'RegularKey is not a valid address', 'RegularKey');
    } else if (tx.RegularKey === tx.Account) {
      err('regular-key', 'RegularKey must differ from Account', 'RegularKey');
    }
  }

  if (type === 'SignerListSet') {
    const q = tx.SignerQuorum;
    if (ctx.template) {
      // A template is filled offline with one spare at weight 1 (SPEC §2), so
      // it must arrive as quorum 1 with no entries. Quorum 0 would turn
      // "replace spare" into "delete signer list".
      if (q !== 1) err('signer-quorum', 'signer-list template must have SignerQuorum 1', 'SignerQuorum');
      if ('SignerEntries' in tx) err('template-filled', 'signer-list template must not carry SignerEntries; the offline side fills the spare', 'SignerEntries');
    } else if (!isUInt32(q)) err('signer-quorum', 'SignerQuorum must be an integer', 'SignerQuorum');
    else if (q === 0) {
      if ('SignerEntries' in tx) err('signer-entries', 'deleting a signer list must not include SignerEntries', 'SignerEntries');
      ack('signerlist-delete', 'this DELETES the signer list (quorum 0)', { field: 'SignerQuorum', phrase: DELETE_SIGNER_LIST_PHRASE });
    } else {
      checkSignerEntries(tx, err);
    }
  }

  if (type === 'AccountDelete') {
    if (!isValidAddress(tx.Destination)) err('destination', 'Destination is missing or invalid', 'Destination');
    else if (tx.Destination === tx.Account) err('accountdelete-self', 'Destination must differ from Account', 'Destination');
    else if (!(ctx.vaultAddresses || []).includes(tx.Destination)) {
      ack('accountdelete-destination', `Destination ${tx.Destination} is not a vault account`, { field: 'Destination' });
    }
    if (tx.DestinationTag !== undefined && !isUInt32(tx.DestinationTag)) err('destination-tag', 'DestinationTag must be a 32-bit unsigned integer', 'DestinationTag');
  }

  if (type === 'AccountSet') {
    for (const f of ['SetFlag', 'ClearFlag', 'TransferRate', 'TickSize']) {
      if (tx[f] !== undefined && !isUInt32(tx[f])) err('accountset-field', `${f} must be an integer`, f);
    }
  }

  return { errors, acks };
}

function checkDestinationTag(tx, ctx, err, ack) {
  if (tx.DestinationTag !== undefined) {
    if (!isUInt32(tx.DestinationTag)) err('destination-tag', 'DestinationTag must be a 32-bit unsigned integer', 'DestinationTag');
    return;
  }
  const entry = (ctx.addressBook || []).find((b) => b.address === tx.Destination);
  if (entry && (entry.isExchange || entry.requiresTag)) {
    err('dest-tag-required', `${entry.label || tx.Destination} needs a DestinationTag`, 'DestinationTag');
  } else if (ctx.requireTag) {
    ack('no-destination-tag', 'no DestinationTag: confirm the destination does not need one', { field: 'DestinationTag' });
  }
}

function checkSignerEntries(tx, err) {
  const e = tx.SignerEntries;
  if (!Array.isArray(e) || e.length === 0) {
    err('signer-entries', 'SignerEntries must be a non-empty list', 'SignerEntries');
    return;
  }
  let total = 0;
  const seen = new Set();
  for (const item of e) {
    const s = item && item.SignerEntry;
    const keys = item ? Object.keys(item) : [];
    if (!s || keys.length !== 1 || !isValidAddress(s.Account) || !Number.isInteger(s.SignerWeight) ||
        s.SignerWeight < 1 || s.SignerWeight > 0xffff || Object.keys(s).some((k) => !['Account', 'SignerWeight'].includes(k))) {
      err('signer-entries', 'each SignerEntry needs only Account and SignerWeight', 'SignerEntries');
      return;
    }
    if (s.Account === tx.Account) err('signer-entries', 'an account cannot list itself as a signer', 'SignerEntries');
    if (seen.has(s.Account)) err('signer-entries', 'duplicate signer', 'SignerEntries');
    seen.add(s.Account);
    total += s.SignerWeight;
  }
  if (total < tx.SignerQuorum) err('signer-quorum', 'SignerQuorum is higher than the total weight; the list could never sign', 'SignerQuorum');
}

/**
 * True only if there are no errors and every ack is given.
 * @param given Map or object: ack.key -> true, or the exact phrase for phrase acks.
 */
export function canSign(result, given = {}) {
  if (result.errors.length > 0) return false;
  const get = (k) => (given instanceof Map ? given.get(k) : given[k]);
  return result.acks.every((a) => (a.phrase ? get(a.key) === a.phrase : get(a.key) === true));
}
