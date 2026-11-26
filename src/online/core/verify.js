// DECISIONS A22: check a scanned signed blob against what was built, and the
// post-checks after submission (SPEC §5.5).
import { verifySignedBlob, isValidAddress } from '../../offline/core/keys.js';

const SIGNATURE_FIELDS = new Set(['SigningPubKey', 'TxnSignature', 'Signers']);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param built  the unsigned transaction from the envelope
 * @param blob   scanned signed hex
 * @returns { ok, errors: string[], tx, hash, filled: { regularKey?, spare? } }
 */
export function checkSigned(built, blob) {
  const v = verifySignedBlob(blob);
  const errors = [];
  if (!v.tx) return { ok: false, errors: [`not a signed transaction (${v.reason})`], tx: null, hash: null, filled: {} };
  if (!v.valid) errors.push(`signature check failed: ${v.reason}`);
  const tx = v.tx;
  const filled = {};
  const templateSrk = built.TransactionType === 'SetRegularKey' && !('RegularKey' in built);
  const templateSls = built.TransactionType === 'SignerListSet' && !('SignerEntries' in built);

  for (const [k, val] of Object.entries(built)) {
    if (k === 'SigningPubKey' && val === '') {
      if (tx.SigningPubKey !== '') errors.push('a multi-signed transaction came back single-signed');
      continue;
    }
    if (!same(tx[k], val)) errors.push(`${k} changed: built ${JSON.stringify(val)}, signed ${JSON.stringify(tx[k])}`);
  }
  for (const k of Object.keys(tx)) {
    if (k in built || SIGNATURE_FIELDS.has(k)) continue;
    if (k === 'RegularKey' && templateSrk) {
      if (!isValidAddress(tx.RegularKey) || tx.RegularKey === tx.Account) errors.push('the filled-in RegularKey is not valid');
      else filled.regularKey = tx.RegularKey;
      continue;
    }
    if (k === 'SignerEntries' && templateSls) {
      const e = tx.SignerEntries;
      const one = Array.isArray(e) && e.length === 1 && e[0].SignerEntry && e[0].SignerEntry.SignerWeight === 1 &&
        isValidAddress(e[0].SignerEntry.Account) && e[0].SignerEntry.Account !== tx.Account;
      if (!one) errors.push('the filled-in signer list is not one spare with weight 1');
      else filled.spare = e[0].SignerEntry.Account;
      continue;
    }
    errors.push(`unexpected field ${k} in the signed transaction`);
  }
  if (templateSrk && !filled.regularKey && !errors.length) errors.push('the RegularKey was not filled in');
  if (templateSls && !filled.spare && !errors.length) errors.push('the spare was not filled in');
  if (built.SigningPubKey === '' && !(Array.isArray(tx.Signers) && tx.Signers.length === 1)) errors.push('expected exactly one multi-signature');
  return { ok: errors.length === 0, errors, tx, hash: v.hash, filled };
}

/**
 * Post-checks (A22). `snaps` maps address -> ledger snapshot after validation
 * (null if the account no longer exists).
 */
export function postChecks(purpose, results, snaps, { shared } = {}) {
  const problems = [];
  const by = (a) => snaps[a];
  for (const r of results) {
    const a = r.tx.Account;
    if (r.filled.regularKey) {
      const s = by(a);
      if (!s || s.regularKey !== r.filled.regularKey) problems.push(`${a}: the ledger's RegularKey is not the new key`);
    }
    if (r.filled.spare) {
      const s = by(a);
      const ok = s && s.signerList && s.signerList.quorum === 1 && s.signerList.entries.length === 1 && s.signerList.entries[0].account === r.filled.spare;
      if (!ok) problems.push(`${a}: the signer list does not hold the new spare`);
    }
    if (r.tx.TransactionType === 'AccountDelete' && by(a) !== null) problems.push(`${a}: still exists after AccountDelete`);
  }
  if (purpose === 'migration' && shared) {
    for (const [a, s] of Object.entries(snaps)) if (s && s.regularKey === shared) problems.push(`${a}: still uses the shared key`);
  }
  return problems;
}
