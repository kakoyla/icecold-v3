// DECISIONS A24: what stops a small account from being deleted.
import { AUTO_DELETED_OBJECTS, ACCOUNT_DELETE_SEQUENCE_GAP } from './config.js';

const HOW_TO_CLEAR = {
  RippleState: 'remove the trust line (set its limit to 0 and empty its balance)',
  Escrow: 'finish or cancel the escrow',
  PayChannel: 'close the payment channel',
  Check: 'cash or cancel the check',
  NFTokenPage: 'transfer or burn the NFTs',
};

/**
 * @param a { sequence, balance (drops string), ownerCount, objects: [ledger objects], ledgerIndex, ownerReserve (BigInt) }
 * @returns [{ code, message }] — empty when the account can be deleted
 */
export function deleteBlockers(a) {
  const out = [];
  const blocking = a.objects.filter((o) => !AUTO_DELETED_OBJECTS.includes(o.LedgerEntryType));
  const byType = new Map();
  for (const o of blocking) byType.set(o.LedgerEntryType, (byType.get(o.LedgerEntryType) || 0) + 1);
  for (const [type, n] of byType) {
    out.push({ code: 'object', message: `${n} ${type} object(s): ${HOW_TO_CLEAR[type] || 'remove it'}` });
  }
  const autoOnly = a.objects.length - blocking.length;
  if (blocking.length === 0 && a.ownerCount > autoOnly) {
    out.push({ code: 'owner-count', message: `the ledger counts ${a.ownerCount} owned object(s) but only ${autoOnly} can be removed automatically` });
  }
  const ready = a.sequence + ACCOUNT_DELETE_SEQUENCE_GAP;
  if (ready > a.ledgerIndex) {
    out.push({ code: 'too-new', message: `the account can be deleted from ledger ${ready} (now ${a.ledgerIndex}); about ${Math.ceil(((ready - a.ledgerIndex) * 4) / 60)} minutes` });
  }
  if (BigInt(a.balance) <= a.ownerReserve) {
    out.push({ code: 'balance', message: `the balance (${a.balance} drops) does not cover the AccountDelete fee (${a.ownerReserve} drops)` });
  }
  return out;
}
