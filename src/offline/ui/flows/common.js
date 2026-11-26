// Shared steps for every signing flow (SPEC §4.4).
import { h, replace } from '../dom.js';
import { session, lock } from '../session.js';
import { validateEnvelope, estimateExpiry } from '../../core/envelope.js';
import { resolveForEnvelope, BLOCKED_MESSAGE } from '../../core/pending.js';
import { checkTransaction, canSign } from '../../core/safety.js';
import { verifySignedBlob } from '../../core/keys.js';
import { button, errorBox, note, txCard, warnBox } from '../widgets.js';
import { show, setNetwork, home } from '../app.js';

/**
 * Validate an envelope against the open vault (or none) and resolve pending
 * keys (SPEC §4.5). Returns { v, payload, resolved } where payload is the
 * vault after resolution (or null).
 */
export function prepare(env, { useVault = true, confirmedNetwork, extraAccounts = [] } = {}) {
  const base = useVault && session.vault ? session.vault.payload : null;
  // For Migration, accounts being added count as vault accounts for the
  // AccountDelete destination check. With no vault open, the user has
  // confirmed the network on screen, and the new vault will be for it.
  const extra = extraAccounts.map((address) => ({ address, addressBook: [] }));
  let vault = base;
  if (extra.length && base) vault = { ...base, accounts: [...base.accounts, ...extra] };
  else if (extra.length && confirmedNetwork) vault = { network: confirmedNetwork, accounts: extra };
  const v = validateEnvelope(env, { vault, confirmedNetwork });
  let resolved = null;
  if (base && v.ok) resolved = resolveForEnvelope(base, env);
  return { v, payload: resolved ? resolved.payload : base, resolved };
}

/** Describe-context for an account: vault labels plus its address book. */
export function ctxFor(payload, address) {
  if (!payload) return {};
  const acct = payload.accounts.find((a) => a.address === address);
  return { accounts: payload.accounts, addressBook: acct ? acct.addressBook : [] };
}

/** Show why an envelope cannot be signed. */
export function showRefused(env, v, payload) {
  setNetwork(env.network);
  show('Cannot sign this envelope',
    errorBox('This envelope fails the safety checks. Nothing was signed.'),
    v.errors.map((e) => errorBox(e.message)),
    v.txs.map((t, i) => txCard(t.tx, { index: i, total: v.txs.length, errors: t.errors, ctx: ctxFor(payload, t.tx && t.tx.Account) })));
}

/** Returns true (and shows the blocked screen) if pending-key resolution blocked. */
export function blockedByPending(env, resolved) {
  if (!resolved || resolved.blocked.length === 0) return false;
  setNetwork(env.network);
  show('Signing blocked', errorBox(BLOCKED_MESSAGE),
    note(`Account(s): ${resolved.blocked.join(', ')}`));
  return true;
}

/** Notes about pending-key resolution that the user should see. */
export function resolutionNotes(resolved) {
  if (!resolved) return [];
  const out = [];
  for (const [addr, status] of Object.entries(resolved.results)) {
    if (status === 'promoted') out.push(warnBox(`The ledger shows the last key rotation of ${addr} landed. The new key is now current; you will be asked to save the updated vault.`));
    if (status === 'discarded') out.push(warnBox(`The ledger shows the last key rotation of ${addr} did not land. The unused pending key is discarded; you will be asked to save the updated vault.`));
  }
  return out;
}

export function expiryNote(env) {
  const t = env.txs.map((tx) => estimateExpiry(env, tx)).sort((a, b) => a - b)[0];
  return note(`Estimated expiry: ${t.toISOString().replace('T', ' ').replace(/\..*$/, '')} UTC (estimate; the ledger decides). Sign and submit before then.`);
}

/**
 * Final check before signing a filled transaction: no errors, and every ack
 * the user gave still covers it (Gemini review: re-run in non-template mode).
 */
export function finalCheck(tx, ctx, given) {
  const r = checkTransaction(tx, { ...ctx, template: false });
  if (!canSign(r, given)) {
    const why = [...r.errors.map((e) => e.message), ...r.acks.filter((a) => !(a.phrase ? given.get(a.key) === a.phrase : given.get(a.key) === true)).map((a) => a.message)];
    throw new Error(`Final check failed: ${why.join('; ')}`);
  }
}

/** Verify every signed result before it is shown (SPEC §7.1 spirit, at runtime). */
export function assertVerified(results) {
  for (const r of results) {
    const v = verifySignedBlob(r.tx_blob);
    if (!v.valid) throw new Error(`internal check failed: signature does not verify (${v.reason})`);
  }
}

/** "Done" button: wipe everything and lock the vault (SPEC §4.2). */
export function doneButton(label = 'Done: wipe and lock') {
  return button(label, () => lock('done'), 'primary');
}

export { h, replace, home };
