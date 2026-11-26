// Reads from the ledger (SPEC §5.3 snapshot, DECISIONS A21). Every function
// takes `rpc(command)`, an async function that sends one rippled command and
// returns its `result`, so tests can run without a network.
import { LSF_DISABLE_MASTER, LSF_REQUIRE_DEST_TAG, RIPPLE_EPOCH_OFFSET } from './config.js';

export class LedgerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const drops = (v) => {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new LedgerError('bad-response', `expected an integer drops value, got ${s}`);
  return BigInt(s);
};

/** Validated ledger, reserves and fees, all in drops (A21). */
export async function networkState(rpc) {
  const ss = await rpc({ command: 'server_state' });
  const vl = ss.state && ss.state.validated_ledger;
  if (!vl) throw new LedgerError('no-validated-ledger', 'the server has no validated ledger yet; try again shortly');
  const fee = await rpc({ command: 'fee' });
  const open = drops(fee.drops.open_ledger_fee);
  const base = drops(fee.drops.base_fee);
  return {
    ledgerIndex: vl.seq,
    closeTime: new Date((vl.close_time + RIPPLE_EPOCH_OFFSET) * 1000).toISOString(),
    baseReserve: drops(vl.reserve_base),
    ownerReserve: drops(vl.reserve_inc),
    baseFee: base,
    openLedgerFee: open > base ? open : base,
  };
}

/** account_info, or null if the account does not exist. */
export async function accountInfo(rpc, address) {
  try {
    const r = await rpc({ command: 'account_info', account: address, ledger_index: 'validated', signer_lists: true });
    const signerLists = r.signer_lists || (r.account_data && r.account_data.signer_lists) || [];
    return { data: r.account_data, signerLists };
  } catch (e) {
    if (e && (e.code === 'actNotFound' || /actNotFound|Account not found/i.test(String(e.message || e.data?.error)))) return null;
    throw e;
  }
}

/** The §5.3 ledger snapshot for one account, plus raw fields the builders need. */
export async function snapshot(rpc, address, state) {
  const info = await accountInfo(rpc, address);
  if (!info) throw new LedgerError('not-found', `account ${address} was not found on this network`);
  const d = info.data;
  const list = info.signerLists[0];
  const owners = BigInt(d.OwnerCount || 0);
  return {
    snap: {
      balance: String(drops(d.Balance)),
      reserve: String(state.baseReserve + owners * state.ownerReserve),
      regularKey: d.RegularKey || null,
      signerList: list ? {
        quorum: list.SignerQuorum,
        entries: list.SignerEntries.map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })),
      } : null,
      masterDisabled: ((d.Flags || 0) & LSF_DISABLE_MASTER) !== 0,
    },
    sequence: d.Sequence,
    ownerCount: Number(owners),
    flags: d.Flags || 0,
  };
}

/** Does the destination require a destination tag (lsfRequireDestTag)? null if it does not exist. */
export async function destinationNeedsTag(rpc, address) {
  const info = await accountInfo(rpc, address);
  if (!info) return null;
  return ((info.data.Flags || 0) & LSF_REQUIRE_DEST_TAG) !== 0;
}

/** Every ledger object an account owns, all types (A24). */
export async function accountObjects(rpc, address) {
  const out = [];
  let marker;
  for (let page = 0; page < 50; page++) {
    const r = await rpc({ command: 'account_objects', account: address, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
    out.push(...(r.account_objects || []));
    marker = r.marker;
    if (!marker) return out;
  }
  throw new LedgerError('too-many-objects', 'too many ledger objects to list');
}
