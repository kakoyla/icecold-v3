// SPEC §4.4 step 3 and §3: plain-English summary card plus every raw field.
// Pure: returns text segments; the UI renders them with textContent only.
import { TF_FULLY_CANONICAL_SIG } from './config.js';

// AccountSet SetFlag / ClearFlag values (asf*), in plain English.
export const ACCOUNT_SET_FLAGS = Object.freeze({
  1: ['RequireDest', 'require a destination tag on incoming payments'],
  2: ['RequireAuth', 'require authorisation before others can hold its tokens'],
  3: ['DisallowXRP', 'ask senders not to send XRP'],
  4: ['DisableMaster', 'disable the master key'],
  5: ['AccountTxnID', 'track the ID of its last transaction'],
  6: ['NoFreeze', 'PERMANENTLY give up the ability to freeze tokens'],
  7: ['GlobalFreeze', 'freeze every token this account issues'],
  8: ['DefaultRipple', 'let tokens ripple through it by default'],
  9: ['DepositAuth', 'only accept payments from accounts it pre-authorises'],
  10: ['AuthorizedNFTokenMinter', 'let another account mint NFTs for it'],
  12: ['DisallowIncomingNFTokenOffer', 'block incoming NFT offers'],
  13: ['DisallowIncomingCheck', 'block incoming checks'],
  14: ['DisallowIncomingPayChan', 'block incoming payment channels'],
  15: ['DisallowIncomingTrustline', 'block incoming trust lines'],
  16: ['AllowTrustLineClawback', 'PERMANENTLY allow clawing back tokens it issues'],
});

// Transaction-level Flags bits, by type.
const TX_FLAGS = {
  common: { [TF_FULLY_CANONICAL_SIG >>> 0]: 'tfFullyCanonicalSig (harmless, historical)' },
  Payment: { 0x00010000: 'tfNoRippleDirect', 0x00020000: 'tfPartialPayment (REFUSED)', 0x00040000: 'tfLimitQuality' },
  AccountSet: {
    0x00010000: 'tfRequireDestTag: require a destination tag',
    0x00020000: 'tfOptionalDestTag: stop requiring a destination tag',
    0x00040000: 'tfRequireAuth: require authorisation',
    0x00080000: 'tfOptionalAuth: stop requiring authorisation',
    0x00100000: 'tfDisallowXRP: ask senders not to send XRP',
    0x00200000: 'tfAllowXRP: allow XRP again',
  },
};

const FIELD_LABELS = {
  TransactionType: 'Type', Account: 'From account', Destination: 'To', DestinationTag: 'Destination tag',
  Amount: 'Amount', Fee: 'Network fee', Sequence: 'Sequence', LastLedgerSequence: 'Last ledger (expiry)',
  Flags: 'Flags', SigningPubKey: 'Signing public key', SourceTag: 'Source tag', RegularKey: 'New regular key',
  SignerQuorum: 'Signer quorum', SignerEntries: 'Signers', SetFlag: 'Turn on', ClearFlag: 'Turn off',
  Domain: 'Domain', EmailHash: 'Email hash', MessageKey: 'Message key', TransferRate: 'Transfer fee',
  TickSize: 'Tick size',
};

/** Exact drops -> XRP string with thousands separators, e.g. "1,234.5". */
export function dropsToXrp(drops) {
  const d = BigInt(drops);
  const whole = (d / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (d % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** "rAbc…xyz9": first and last 4 characters (SPEC §4.4 example). */
export const shortAddress = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));

export function describeFlags(type, flags) {
  if (!flags) return ['none'];
  const names = [];
  let rest = flags >>> 0;
  for (const table of [TX_FLAGS.common, TX_FLAGS[type] || {}]) {
    for (const [bit, name] of Object.entries(table)) {
      const b = Number(bit) >>> 0;
      if ((rest & b) >>> 0 === b) { names.push(name); rest = (rest & ~b) >>> 0; }
    }
  }
  if (rest) names.push(`UNKNOWN 0x${rest.toString(16)}`);
  return names;
}

function hexToText(hex) {
  try {
    if (!/^(?:[0-9A-Fa-f]{2})*$/.test(hex)) return null;
    const bytes = new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) || []);
    const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /^[\x20-\x7e]*$/.test(t) ? t : null;
  } catch { return null; }
}

function flagText(v) {
  const f = ACCOUNT_SET_FLAGS[v];
  return f ? `${f[1]} (${f[0]}, ${v})` : `UNKNOWN setting ${v}`;
}

function transferRateText(r) {
  if (r === 0 || r === 1_000_000_000) return 'none';
  const pct = (r - 1_000_000_000) / 10_000_000;
  return `${pct}% on transfers of its tokens (${r})`;
}

function fieldValue(tx, k) {
  const v = tx[k];
  switch (k) {
    case 'Amount': return typeof v === 'string' && /^\d+$/.test(v) ? `${dropsToXrp(v)} XRP (${v} drops)` : JSON.stringify(v);
    case 'Fee': return typeof v === 'string' && /^\d+$/.test(v) ? `${dropsToXrp(v)} XRP (${v} drops)` : JSON.stringify(v);
    case 'Flags': return `${describeFlags(tx.TransactionType, v).join('; ')} (${v})`;
    case 'SetFlag': case 'ClearFlag': return flagText(v);
    case 'Domain': { const t = hexToText(v); return v === '' ? 'REMOVE the domain' : t ? `${t} (hex ${v})` : `hex ${v}`; }
    case 'TransferRate': return transferRateText(v);
    case 'TickSize': return v === 0 ? 'turn off' : String(v);
    case 'SigningPubKey': return v === '' ? '(empty: multi-signed)' : String(v);
    case 'SignerEntries': return Array.isArray(v)
      ? v.map((e) => `${e?.SignerEntry?.Account} (weight ${e?.SignerEntry?.SignerWeight})`).join(', ')
      : JSON.stringify(v);
    default: return typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);
  }
}

/**
 * @param tx  transaction (unsigned or filled)
 * @param ctx { accounts: [{label,address}], addressBook: [{label,address}] }
 * @returns { title, summary: [{ text, strong? }], fields: [{ key, label, value, known }], firstTimeDestination }
 */
export function describeTx(tx, ctx = {}) {
  const accounts = ctx.accounts || [];
  const book = ctx.addressBook || [];
  const labelOf = (a) => accounts.find((x) => x.address === a)?.label || book.find((x) => x.address === a)?.label || null;
  const who = (a) => {
    const l = labelOf(a);
    return l ? [{ text: l, strong: true }, { text: ` (${shortAddress(a)})` }] : [{ text: String(a), strong: true }];
  };
  const S = [];
  const t = (text, strong) => S.push(strong ? { text, strong } : { text });
  let title = tx.TransactionType;
  let firstTimeDestination = false;

  switch (tx.TransactionType) {
    case 'Payment':
      title = 'Send XRP';
      t('Send '); t(`${typeof tx.Amount === 'string' ? dropsToXrp(tx.Amount) : '?'} XRP`, true);
      t(' from '); S.push(...who(tx.Account)); t(' to '); S.push(...who(tx.Destination));
      t(tx.DestinationTag !== undefined ? `, tag ${tx.DestinationTag}` : ', no destination tag');
      firstTimeDestination = !labelOf(tx.Destination);
      break;
    case 'SetRegularKey':
      title = 'Change regular key';
      t('Set the regular key of '); S.push(...who(tx.Account)); t(' to ');
      t(tx.RegularKey ? tx.RegularKey : '(filled in offline)', true);
      break;
    case 'SignerListSet':
      title = 'Set signer list';
      t('Set the signer list of '); S.push(...who(tx.Account)); t(' to ');
      if (Array.isArray(tx.SignerEntries)) {
        tx.SignerEntries.forEach((e, i) => { if (i) t(', '); t(String(e?.SignerEntry?.Account), true); t(` (weight ${e?.SignerEntry?.SignerWeight})`); });
      } else t('(spare filled in offline)', true);
      t(`, quorum ${tx.SignerQuorum}`);
      break;
    case 'AccountSet': {
      title = 'Change account settings';
      t('Change settings of '); S.push(...who(tx.Account)); t(': ');
      const parts = [];
      if (tx.SetFlag !== undefined) parts.push(`turn ON: ${flagText(tx.SetFlag)}`);
      if (tx.ClearFlag !== undefined) parts.push(`turn OFF: ${flagText(tx.ClearFlag)}`);
      if (tx.Domain !== undefined) parts.push(`domain: ${fieldValue(tx, 'Domain')}`);
      if (tx.TransferRate !== undefined) parts.push(`transfer fee: ${transferRateText(tx.TransferRate)}`);
      for (const k of ['EmailHash', 'MessageKey', 'TickSize']) if (tx[k] !== undefined) parts.push(`${FIELD_LABELS[k]}: ${fieldValue(tx, k)}`);
      if (tx.Flags) parts.push(`flags: ${describeFlags('AccountSet', tx.Flags).join('; ')}`);
      t(parts.length ? parts.join('; ') : 'no change', true);
      break;
    }
    case 'AccountDelete':
      title = 'DELETE account';
      t('DELETE ', true); S.push(...who(tx.Account)); t(' and send all its remaining XRP to '); S.push(...who(tx.Destination));
      t(tx.DestinationTag !== undefined ? `, tag ${tx.DestinationTag}` : ', no destination tag');
      firstTimeDestination = !labelOf(tx.Destination);
      break;
    default:
      t(`Unsupported transaction type ${tx.TransactionType}`, true);
  }

  const fields = Object.keys(tx).map((k) => ({
    key: k,
    label: FIELD_LABELS[k] || `UNKNOWN FIELD ${k}`,
    value: fieldValue(tx, k),
    known: k in FIELD_LABELS,
  }));
  return { title, summary: S, fields, firstTimeDestination };
}
