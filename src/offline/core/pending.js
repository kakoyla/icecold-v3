// SPEC §4.5 "Resolving the pending key". Every envelope carries the account's
// RegularKey as it stands on the ledger. Before signing, compare it with the
// vault's current and pending keys:
//
//   ledger = current          -> keep current; discard any pending key
//                                (the rotation never landed)
//   ledger = pending          -> promote pending to current; retire the old key
//   ledger = neither / unset  -> blocked; the user is pointed to Recovery
//
// Pure functions: the caller saves the returned account into a new vault file.

export const BLOCKED_MESSAGE =
  'Neither the current nor the pending key matches the key on the ledger. ' +
  'Signing is blocked. Use Recovery (spare key) to regain control of this account.';

/**
 * @param account vault account { regularKey, pendingKey, retiredKeys, ... }
 * @param ledgerRegularKey address from the envelope snapshot, or null
 * @returns { status: 'current'|'discarded'|'promoted'|'blocked', account, changed, message? }
 */
export function resolvePendingKey(account, ledgerRegularKey) {
  const cur = account.regularKey;
  const pend = account.pendingKey;

  if (ledgerRegularKey && cur && ledgerRegularKey === cur.address) {
    if (!pend) return { status: 'current', account, changed: false };
    return { status: 'discarded', account: { ...account, pendingKey: null }, changed: true };
  }

  if (ledgerRegularKey && pend && ledgerRegularKey === pend.address) {
    const retired = cur && !account.retiredKeys.includes(cur.address)
      ? [...account.retiredKeys, cur.address]
      : [...account.retiredKeys];
    return {
      status: 'promoted',
      account: { ...account, regularKey: pend, pendingKey: null, retiredKeys: retired },
      changed: true,
    };
  }

  return { status: 'blocked', account, changed: false, message: BLOCKED_MESSAGE };
}

/**
 * Apply resolution to every vault account an envelope's transactions use.
 * @returns { payload, results: { [address]: status }, blocked: string[], changed }
 */
export function resolveForEnvelope(payload, env) {
  const results = {};
  const blocked = [];
  let changed = false;
  const used = new Set(env.txs.map((t) => t.Account));
  const accounts = payload.accounts.map((a) => {
    if (!used.has(a.address) || !(a.address in env.ledger)) return a;
    const r = resolvePendingKey(a, env.ledger[a.address].regularKey);
    results[a.address] = r.status;
    if (r.status === 'blocked') blocked.push(a.address);
    changed = changed || r.changed;
    return r.account;
  });
  return { payload: { ...payload, accounts }, results, blocked, changed };
}
