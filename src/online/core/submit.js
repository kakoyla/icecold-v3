// SPEC §5.5 submit: send each signed blob, wait for validation, report in
// plain English. Send & Rotate gating: the SetRegularKey goes only if the
// Payment validated with tesSUCCESS or any tec code.
import { hashSignedBlob } from '../../offline/core/keys.js';

export const consumesSequence = (code) => code === 'tesSUCCESS' || /^tec/.test(code);

const PLAIN = {
  tesSUCCESS: 'Done: the transaction succeeded.',
  tecNO_DST_INSUF_XRP: 'Failed: the destination does not exist and the amount is too small to create it.',
  tecUNFUNDED_PAYMENT: 'Failed: not enough XRP above the reserve.',
  tecDST_TAG_NEEDED: 'Failed: the destination requires a destination tag.',
  tecNO_PERMISSION: 'Failed: not permitted.',
  tecHAS_OBLIGATIONS: 'Failed: the account still owns objects that must be removed first.',
  tefPAST_SEQ: 'Not applied: this sequence number was already used.',
  tefBAD_AUTH: 'Not applied: the key that signed is not authorised for this account.',
  tefMAX_LEDGER: 'Not applied: it expired (LastLedgerSequence passed).',
};
export const plainResult = (code) => PLAIN[code] || (consumesSequence(code) ? `Failed with ${code} (the fee was charged).` : `Not applied: ${code}.`);

/**
 * Submit one blob and wait until validated or expired.
 * @returns { hash, code, validated, ledgerIndex?, message }
 */
export async function submitAndWait(rpc, blob, { lastLedgerSequence, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000 }) {
  const hash = hashSignedBlob(blob);
  const sub = await rpc({ command: 'submit', tx_blob: blob });
  const prelim = sub.engine_result;
  if (/^(tem|tef|tel)/.test(prelim) && prelim !== 'telCAN_NOT_QUEUE') {
    // Not applied and will not be retried by the network.
    return { hash, code: prelim, validated: false, message: plainResult(prelim) };
  }
  // Ledgers close every few seconds, so LastLedgerSequence passes long
  // before this limit; it only guards against a server that stops advancing.
  for (let polls = 0; polls < 3000; polls++) {
    await sleep(pollMs);
    let t = null;
    try { t = await rpc({ command: 'tx', transaction: hash }); } catch { t = null; }
    if (t && t.validated) {
      if (t.hash && t.hash !== hash) return { hash, code: 'hash-mismatch', validated: false, message: 'The validated transaction has a different hash. Stop and check.' };
      const code = t.meta && t.meta.TransactionResult;
      return { hash, code, validated: true, ledgerIndex: t.ledger_index, message: plainResult(code) };
    }
    const ss = await rpc({ command: 'server_state' });
    const seq = ss.state && ss.state.validated_ledger && ss.state.validated_ledger.seq;
    if (seq && seq > lastLedgerSequence) return { hash, code: 'tefMAX_LEDGER', validated: false, message: plainResult('tefMAX_LEDGER') };
  }
  return { hash, code: 'unknown', validated: false, message: 'Still not validated after a long wait. Check the transaction hash in an explorer before doing anything else.' };
}

/**
 * Submit a list in order. For send-rotate, stop after the Payment unless it
 * used up its sequence (SPEC §5.5 gating). onProgress(i, result) per item.
 */
export async function submitAll(rpc, purpose, items, opts = {}) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const r = await submitAndWait(rpc, items[i].blob, { ...opts, lastLedgerSequence: items[i].tx.LastLedgerSequence });
    results.push(r);
    if (opts.onProgress) opts.onProgress(i, r);
    if (purpose === 'send-rotate' && i === 0 && !(r.validated && consumesSequence(r.code))) {
      results.push({ hash: null, code: 'skipped', validated: false, message: 'Not submitted: the payment did not go through, so the key change was discarded. Run Rotate-only to change the key.' });
      break;
    }
    // Migration: an account's new regular key goes only after its spare is
    // on the ledger. A tec on SignerListSet still uses up the sequence, so
    // the key change would land with no spare; require tesSUCCESS.
    const next = items[i + 1];
    if (purpose === 'migration' && items[i].tx.TransactionType === 'SignerListSet' && next &&
        next.tx.TransactionType === 'SetRegularKey' && next.tx.Account === items[i].tx.Account &&
        !(r.validated && r.code === 'tesSUCCESS')) {
      results.push({ hash: null, code: 'skipped', validated: false, message: `Not submitted: the spare for ${items[i].tx.Account} did not go on the ledger, so its key change was held back. The shared key still controls it; build a new migration envelope for it.` });
      i++;
      if (opts.onProgress) opts.onProgress(i, results[results.length - 1]);
    }
  }
  return results;
}
