// Online Builder settings (SPEC §5, DECISIONS A21).

// Public servers per network, tried in order (A21). The page's CSP allows
// connections to these addresses only. A test build may replace the list
// (see scripts/build.mjs); the published build never does.
export const SERVERS = Object.freeze({
  mainnet: Object.freeze(['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com']),
  testnet: Object.freeze(['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com']),
});

// DECISIONS A21 / A12: LastLedgerSequence windows (about 4 s per ledger).
export const LLS_WINDOW = 900; // about 1 hour
export const LLS_WINDOW_MIGRATION = 2700; // about 3 hours

// Ledger account flags (lsf*).
export const LSF_DISABLE_MASTER = 0x00100000;
export const LSF_REQUIRE_DEST_TAG = 0x00020000;

// Seconds between the Unix epoch and the XRPL ("Ripple") epoch, 2000-01-01.
export const RIPPLE_EPOCH_OFFSET = 946684800;

// Ledger objects the ledger removes itself when an account is deleted (A24).
export const AUTO_DELETED_OBJECTS = Object.freeze(['Offer', 'Ticket', 'SignerList', 'DepositPreauth']);

// AccountDelete needs Sequence + 256 <= the current ledger index.
export const ACCOUNT_DELETE_SEQUENCE_GAP = 256;

// Published URLs (A20). Used in estate letters (A25).
export const PAGES_BASE = 'https://kakoyla.github.io/icecold-v3/';
export const PAGES_OFFLINE = `${PAGES_BASE}icecold-v3-offline.html`;
export const PAGES_ONLINE = `${PAGES_BASE}icecold-v3-online.html`;
