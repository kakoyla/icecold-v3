// Envelope builders (SPEC §5.3, §5.4, DECISIONS A21). Each returns an
// envelope already checked by the offline signer's own validateEnvelope, so
// a bad envelope never reaches a QR code.
import { validateEnvelope } from '../../offline/core/envelope.js';
import { feeCapDrops } from '../../offline/core/safety.js';
import { isValidAddress } from '../../offline/core/keys.js';
import { networkState, snapshot, destinationNeedsTag, accountObjects, LedgerError } from './ledger.js';
import { deleteBlockers } from './blockers.js';
import { LLS_WINDOW, LLS_WINDOW_MIGRATION } from './config.js';

export class BuildError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const VAULT_EXEMPT = new Set(['recovery', 'estate', 'migration']);

/** Fee for one transaction, refused if over the offline cap (A21). */
export function feeFor(kind, state) {
  let fee;
  if (kind === 'delete') fee = state.ownerReserve;
  else if (kind === 'multi') fee = state.openLedgerFee * 2n;
  else fee = state.openLedgerFee;
  const cap = feeCapDrops(
    { TransactionType: kind === 'delete' ? 'AccountDelete' : 'Payment' },
    { multisigned: kind === 'multi', ownerReserveDrops: String(state.ownerReserve) },
  );
  if (cap === null || fee > cap) {
    throw new BuildError('fee-too-high', `The network fee is high right now (${fee} drops, cap ${cap} drops). Wait a few minutes and try again.`);
  }
  return String(fee);
}

function checkAddress(a, what) {
  if (!isValidAddress(a)) throw new BuildError('address', `${what} is not a valid XRPL address`);
}

function checkTag(tag) {
  if (tag === undefined || tag === null || tag === '') return undefined;
  const n = Number(tag);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new BuildError('tag', 'the destination tag must be a whole number from 0 to 4294967295');
  return n;
}

/** Positive integer drops from a decimal XRP string like "12.5" (no floats). */
export function xrpToDrops(xrp) {
  const s = String(xrp).trim();
  const m = /^(\d{1,11})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new BuildError('amount', 'enter the amount in XRP, with at most 6 decimal places');
  const d = BigInt(m[1]) * 1_000_000n + BigInt((m[2] || '').padEnd(6, '0') || '0');
  if (d <= 0n) throw new BuildError('amount', 'the amount must be more than zero');
  return String(d);
}

async function destinationTagRule(rpc, destination, tag, { requireTag = false } = {}) {
  const needs = await destinationNeedsTag(rpc, destination);
  if (needs === null) throw new BuildError('destination-missing', 'the destination account does not exist on this network');
  if ((needs || requireTag) && tag === undefined) {
    throw new BuildError('tag-required', needs
      ? 'the destination requires a destination tag'
      : 'a destination tag is required for an estate transfer unless you are sure the destination does not need one');
  }
}

function envelope(network, purpose, state, txs, ledger) {
  const env = {
    version: 1, network, purpose, txs, ledger,
    ownerReserveDrops: String(state.ownerReserve),
    builtAt: { ledgerIndex: state.ledgerIndex, closeTime: state.closeTime },
  };
  // Check with the offline validator. Vault membership is the offline side's
  // job; here a stand-in vault holds the accounts being signed for.
  const accounts = [...new Set(txs.map((t) => t.Account))].map((address) => ({ address, addressBook: [] }));
  const v = VAULT_EXEMPT.has(purpose)
    ? validateEnvelope(env, { vault: purpose === 'migration' ? { network, accounts } : null, confirmedNetwork: network })
    : validateEnvelope(env, { vault: { network, accounts } });
  const errors = [...v.errors, ...v.txs.flatMap((t) => t.errors)];
  if (errors.length) throw new BuildError('invalid', `internal check failed: ${errors.map((e) => e.message).join('; ')}`);
  return { env, acks: v.txs.flatMap((t) => t.acks) };
}

/** Ledgers for the expiry window: SPEC §5.3 default, or the user's minutes. */
const windowLedgers = (p, dflt) => {
  if (p.windowMinutes === undefined || p.windowMinutes === null) return dflt;
  const m = Number(p.windowMinutes);
  if (!Number.isInteger(m) || m < 10 || m > 360) throw new BuildError('window', 'the expiry window must be 10 to 360 minutes');
  return Math.round((m * 60) / 4);
};

/** The account must keep its reserve after the amount and every fee. */
function checkSpendable(snap, amountDrops, fees) {
  const spendable = BigInt(snap.balance) - BigInt(snap.reserve);
  if (BigInt(amountDrops) + fees > spendable) {
    throw new BuildError('insufficient', `not enough XRP: at most ${spendable - fees > 0n ? spendable - fees : 0n} drops can be sent while keeping the ${snap.reserve}-drop reserve`);
  }
}

const base = (TransactionType, account, s, state, fee, lls, extra = {}) => ({
  TransactionType, Account: account, Fee: fee, Sequence: s, LastLedgerSequence: state.ledgerIndex + lls, ...extra,
});

/**
 * Build an envelope. params by purpose:
 *   sign (Payment):    { account, destination, amountXrp, destinationTag? }
 *   sign (AccountSet): { account, accountSet: { SetFlag?, ClearFlag?, Domain? (text) } }
 *   send-rotate:       { account, destination, amountXrp, destinationTag? }
 *   rotate / recovery / replace-spare: { account }
 *   estate:            { account, destination, destinationTag?, noTagConfirmed? }
 *   migration:         { kept: [address], small: [address], leftoversTo }
 * Returns { env, acks, notes }.
 */
export async function build(rpc, network, purpose, p) {
  const state = await networkState(rpc);
  const notes = [];
  const W1 = windowLedgers(p, LLS_WINDOW);
  const W3 = windowLedgers(p, LLS_WINDOW_MIGRATION);
  const snap = async (a) => snapshot(rpc, a, state);

  switch (purpose) {
    case 'sign': {
      checkAddress(p.account, 'The account');
      const s = await snap(p.account);
      let tx;
      if (p.accountSet) {
        const extra = {};
        for (const k of ['SetFlag', 'ClearFlag']) if (p.accountSet[k] !== undefined && p.accountSet[k] !== '') extra[k] = Number(p.accountSet[k]);
        if (p.accountSet.Domain !== undefined) extra.Domain = Array.from(new TextEncoder().encode(p.accountSet.Domain)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        if (!Object.keys(extra).length) throw new BuildError('accountset', 'choose a setting to change');
        tx = base('AccountSet', p.account, s.sequence, state, feeFor('single', state), W1, extra);
      } else {
        checkAddress(p.destination, 'The destination');
        const tag = checkTag(p.destinationTag);
        await destinationTagRule(rpc, p.destination, tag);
        const fee = feeFor('single', state);
        const amount = xrpToDrops(p.amountXrp);
        checkSpendable(s.snap, amount, BigInt(fee));
        tx = base('Payment', p.account, s.sequence, state, fee, W1,
          { Destination: p.destination, Amount: amount, ...(tag !== undefined ? { DestinationTag: tag } : {}) });
      }
      return { ...envelope(network, 'sign', state, [tx], { [p.account]: s.snap }), notes };
    }
    case 'send-rotate': {
      checkAddress(p.account, 'The account');
      checkAddress(p.destination, 'The destination');
      const s = await snap(p.account);
      const tag = checkTag(p.destinationTag);
      await destinationTagRule(rpc, p.destination, tag);
      const fee = feeFor('single', state);
      const amount = xrpToDrops(p.amountXrp);
      checkSpendable(s.snap, amount, 2n * BigInt(fee)); // payment + key change
      const pay = base('Payment', p.account, s.sequence, state, fee, W1,
        { Destination: p.destination, Amount: amount, ...(tag !== undefined ? { DestinationTag: tag } : {}) });
      const srk = base('SetRegularKey', p.account, s.sequence + 1, state, fee, W1);
      return { ...envelope(network, 'send-rotate', state, [pay, srk], { [p.account]: s.snap }), notes };
    }
    case 'rotate': {
      checkAddress(p.account, 'The account');
      const s = await snap(p.account);
      const srk = base('SetRegularKey', p.account, s.sequence, state, feeFor('single', state), W1);
      return { ...envelope(network, 'rotate', state, [srk], { [p.account]: s.snap }), notes };
    }
    case 'recovery': {
      checkAddress(p.account, 'The account');
      const s = await snap(p.account);
      if (!s.snap.signerList) throw new BuildError('no-signer-list', 'this account has no signer list, so a spare cannot recover it');
      const srk = base('SetRegularKey', p.account, s.sequence, state, feeFor('multi', state), W1, { SigningPubKey: '' });
      return { ...envelope(network, 'recovery', state, [srk], { [p.account]: s.snap }), notes };
    }
    case 'replace-spare': {
      checkAddress(p.account, 'The account');
      const s = await snap(p.account);
      const sls = base('SignerListSet', p.account, s.sequence, state, feeFor('single', state), W1, { SignerQuorum: 1 });
      return { ...envelope(network, 'replace-spare', state, [sls], { [p.account]: s.snap }), notes };
    }
    case 'estate': {
      checkAddress(p.account, 'The account');
      checkAddress(p.destination, 'The destination');
      const s = await snap(p.account);
      if (!s.snap.signerList) throw new BuildError('no-signer-list', 'this account has no signer list, so a spare cannot sign for it');
      const tag = checkTag(p.destinationTag);
      await destinationTagRule(rpc, p.destination, tag, { requireTag: !p.noTagConfirmed });
      const fee = feeFor('multi', state);
      // A21: balance - reserve (base + OwnerCount x owner reserve) - fee.
      const amount = BigInt(s.snap.balance) - BigInt(s.snap.reserve) - BigInt(fee);
      if (amount <= 0n) throw new BuildError('nothing-to-send', 'after the reserve and fee there is nothing to send');
      notes.push(`Sends everything above the reserve: ${amount} drops. The reserve (${s.snap.reserve} drops) stays in the account.`);
      const pay = base('Payment', p.account, s.sequence, state, fee, W1,
        { SigningPubKey: '', Destination: p.destination, Amount: String(amount), ...(tag !== undefined ? { DestinationTag: tag } : {}) });
      return { ...envelope(network, 'estate', state, [pay], { [p.account]: s.snap }), notes };
    }
    case 'migration': {
      const kept = p.kept || [];
      const small = p.small || [];
      if (!kept.length && !small.length) throw new BuildError('migration-empty', 'add at least one account');
      for (const a of [...kept, ...small]) checkAddress(a, `Account ${a}`);
      if (new Set([...kept, ...small]).size !== kept.length + small.length) throw new BuildError('migration-duplicate', 'an account is listed twice');
      if (small.length) {
        checkAddress(p.leftoversTo, 'The account for leftovers');
        if (small.includes(p.leftoversTo)) throw new BuildError('leftovers', 'leftovers cannot go to an account being closed');
        if (!kept.includes(p.leftoversTo) && !(p.leftoversKnown || []).includes(p.leftoversTo)) {
          throw new BuildError('leftovers', 'leftovers must go to a kept account');
        }
        const needs = await destinationNeedsTag(rpc, p.leftoversTo);
        if (needs === null) throw new BuildError('leftovers', 'the account for leftovers does not exist on this network');
        if (needs) throw new BuildError('leftovers', 'the account for leftovers requires a destination tag; choose a kept account');
      }
      const txs = [];
      const ledger = {};
      let shared = null;
      for (const a of kept) {
        const s = await snap(a);
        if (!s.snap.regularKey) throw new BuildError('no-regular-key', `${a} has no regular key to migrate from`);
        if (shared && s.snap.regularKey !== shared) throw new BuildError('not-shared', `${a} uses a different regular key from the other accounts`);
        shared = s.snap.regularKey;
        ledger[a] = s.snap;
        const fee = feeFor('single', state);
        // A10: spare first (Sequence N), then the new regular key (N+1).
        txs.push(base('SignerListSet', a, s.sequence, state, fee, W3, { SignerQuorum: 1 }));
        txs.push(base('SetRegularKey', a, s.sequence + 1, state, fee, W3));
      }
      // Collect every small account's blockers before refusing (SPEC §5.4).
      const blocked = [];
      for (const a of small) {
        const s = await snap(a);
        if (!s.snap.regularKey) throw new BuildError('no-regular-key', `${a} has no regular key to sign its AccountDelete`);
        if (shared && s.snap.regularKey !== shared) throw new BuildError('not-shared', `${a} does not use the shared regular key`);
        shared = shared || s.snap.regularKey;
        const objects = await accountObjects(rpc, a);
        const blockers = deleteBlockers({ sequence: s.sequence, balance: s.snap.balance, ownerCount: s.ownerCount, objects, ledgerIndex: state.ledgerIndex, ownerReserve: state.ownerReserve });
        if (blockers.length) { blocked.push(`${a}: ${blockers.map((b) => b.message).join('; ')}`); continue; }
        ledger[a] = s.snap;
        txs.push(base('AccountDelete', a, s.sequence, state, feeFor('delete', state), W3, { Destination: p.leftoversTo }));
      }
      if (blocked.length) throw new BuildError('delete-blocked', `These accounts cannot be deleted yet. ${blocked.join(' | ')}`);
      return { ...envelope(network, 'migration', state, txs, ledger), notes, shared };
    }
    default:
      throw new BuildError('purpose', `unknown purpose ${purpose}`);
  }
}

export { LedgerError };
