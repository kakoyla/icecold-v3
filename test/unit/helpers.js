// Test fixtures built from freshly generated keys, so no fixed account
// addresses appear in the repo apart from public xrpl.js test vectors.
import { generateKey } from '../../src/offline/core/keys.js';
import { emptyPayload, storedKey } from '../../src/offline/core/vault.js';

export const OWNER_RESERVE = '200000'; // 0.2 XRP, example value

export function makeWorld(network = 'testnet') {
  const personal = generateKey();
  const managed = generateKey();
  const exchange = generateKey();
  const friend = generateKey();
  const reg = { personal: generateKey(), managed: generateKey() };
  const spare = { personal: generateKey(), managed: generateKey() };

  const vault = emptyPayload(network);
  vault.accounts.push(
    {
      label: 'Personal', address: personal.address, regularKey: storedKey(reg.personal), pendingKey: null,
      retiredKeys: [],
      addressBook: [
        { label: 'Exchange deposit', address: exchange.address, isExchange: true, requiresTag: false },
        { label: 'Friend', address: friend.address, isExchange: false, requiresTag: false },
      ],
    },
    {
      label: 'Managed', address: managed.address, regularKey: storedKey(reg.managed), pendingKey: null,
      retiredKeys: [], addressBook: [],
    },
  );

  const snapshot = (regularKey, spareAddr) => ({
    balance: '50000000', reserve: '1200000', regularKey, masterDisabled: true,
    signerList: spareAddr ? { quorum: 1, entries: [{ account: spareAddr, weight: 1 }] } : null,
  });

  const ledger = {
    [personal.address]: snapshot(reg.personal.address, spare.personal.address),
    [managed.address]: snapshot(reg.managed.address, spare.managed.address),
  };

  const base = (Account, extra) => ({ Account, Fee: '12', Sequence: 10, LastLedgerSequence: 2000, ...extra });
  const payment = (extra = {}) => base(personal.address,
    { TransactionType: 'Payment', Destination: friend.address, Amount: '1000000', ...extra });

  const envelope = (purpose, txs, extra = {}) => ({
    version: 1, network, purpose, txs, ledger,
    ownerReserveDrops: OWNER_RESERVE,
    builtAt: { ledgerIndex: 1100, closeTime: '2026-11-25T12:00:00Z' },
    ...extra,
  });

  return { personal, managed, exchange, friend, reg, spare, vault, ledger, base, payment, envelope, snapshot };
}
