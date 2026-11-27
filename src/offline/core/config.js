// Policy constants for the offline signer. Values marked with an open item
// (O-n) are provisional until the owner closes that item in SPEC.md.

export const NETWORKS = Object.freeze(['mainnet', 'testnet']);

// SPEC §5.3 purposes.
export const PURPOSES = Object.freeze([
  'sign', 'send-rotate', 'rotate', 'migration', 'recovery', 'estate', 'replace-spare',
]);

// SPEC §3 supported transaction types.
export const SUPPORTED_TX_TYPES = Object.freeze([
  'Payment', 'SetRegularKey', 'SignerListSet', 'AccountSet', 'AccountDelete',
]);

// SPEC §4.8 fee caps, in drops (O-5: final values pending).
export const FEE_CAP_SINGLE_DROPS = 1000n;   // 0.001 XRP
export const FEE_CAP_MULTI_DROPS = 2000n;    // 0.002 XRP
export const FEE_CAP_ACCOUNT_DELETE_EXTRA_DROPS = 1000n; // owner reserve + 0.001 XRP
// DECISIONS A4: the owner reserve comes from the untrusted online side, so it
// has a hard ceiling here. 2 XRP was the owner reserve before the 2024 cut to
// 0.2 XRP. An envelope claiming more is refused.
export const MAX_OWNER_RESERVE_DROPS = 2_000_000n;

// SPEC §4.2 vault KDF. N is stored in each vault file, so the default can be
// retuned after measuring on the signing machine without breaking old vaults.
// N = 2^16 measured 4.9 s on the signing machine (DECISIONS O-1, 2026-11-27).
export const VAULT_KDF_DEFAULT = Object.freeze({ N: 2 ** 16, r: 8, p: 1 });
// Bounds accepted when opening a vault (guards against absurd header values).
export const VAULT_KDF_MIN_LOG2N = 14;
export const VAULT_KDF_MAX_LOG2N = 20;

// SPEC §4.2 session idle auto-lock.
export const IDLE_LOCK_MS = 5 * 60 * 1000;

// DECISIONS A6: rough ledger close interval for the expiry estimate.
export const LEDGER_INTERVAL_ESTIMATE_S = 4;

// Payment flag that must never be set (SPEC §3, §4.8).
export const TF_PARTIAL_PAYMENT = 0x00020000;
// Historical flag that is harmless and may be present.
export const TF_FULLY_CANONICAL_SIG = 0x80000000;

// Typed confirmation required to delete a signer list (SPEC §3).
export const DELETE_SIGNER_LIST_PHRASE = 'DELETE SIGNER LIST';

// Minimum vault passphrase length (DECISIONS: vault passphrase).
export const MIN_PASSPHRASE_LENGTH = 12;
