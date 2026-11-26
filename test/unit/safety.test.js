// SPEC §4.8: each hard safety check has a test where it fails. SPEC §3:
// refusals per type. Each test starts from a transaction that passes, then
// breaks exactly one thing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkTransaction, canSign } from '../../src/offline/core/safety.js';
import { DELETE_SIGNER_LIST_PHRASE } from '../../src/offline/core/config.js';
import { makeWorld, OWNER_RESERVE } from './helpers.js';

const W = makeWorld();
const ctx = (extra = {}) => ({
  multisigned: false, template: false, ownerReserveDrops: OWNER_RESERVE,
  addressBook: W.vault.accounts[0].addressBook, vaultAddresses: W.vault.accounts.map((a) => a.address), ...extra,
});
const codes = (r) => r.errors.map((e) => e.code);
const ackCodes = (r) => r.acks.map((a) => a.code);

function passes(tx, c = ctx()) {
  const r = checkTransaction(tx, c);
  assert.deepEqual(r.errors, [], `expected no errors, got ${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.acks, [], `expected no acks, got ${JSON.stringify(r.acks)}`);
  assert.equal(canSign(r), true);
}
function failsWith(tx, code, c = ctx()) {
  const r = checkTransaction(tx, c);
  assert.ok(codes(r).includes(code), `expected error ${code}, got ${JSON.stringify(codes(r))}`);
  assert.equal(canSign(r, new Proxy({}, { get: () => true })), false, 'an error must block signing even with every ack given');
}
function needsAck(tx, code, c = ctx()) {
  const r = checkTransaction(tx, c);
  assert.deepEqual(r.errors, []);
  assert.ok(ackCodes(r).includes(code), `expected ack ${code}, got ${JSON.stringify(ackCodes(r))}`);
  assert.equal(canSign(r), false, 'must not sign before the ack');
  return r;
}

describe('baseline: valid transactions pass', () => {
  test('XRP payment to a known non-exchange destination', () => passes(W.payment()));
  test('SetRegularKey with a key', () => passes(W.base(W.personal.address, { TransactionType: 'SetRegularKey', RegularKey: W.reg.managed.address })));
  test('SignerListSet quorum 1, one entry weight 1', () => passes(W.base(W.personal.address, {
    TransactionType: 'SignerListSet', SignerQuorum: 1,
    SignerEntries: [{ SignerEntry: { Account: W.spare.personal.address, SignerWeight: 1 } }],
  })));
  test('AccountDelete to a vault account, fee = owner reserve', () => passes(W.base(W.friend.address, {
    TransactionType: 'AccountDelete', Destination: W.personal.address, Fee: OWNER_RESERVE,
  })));
  test('AccountSet with a known field', () => passes(W.base(W.personal.address, { TransactionType: 'AccountSet', SetFlag: 8 })));
  test('multisigned payment at the multisign fee cap', () => passes(W.payment({ SigningPubKey: '', Fee: '2000' }), ctx({ multisigned: true })));
});

describe('§4.8 fee caps', () => {
  test('single-signed: fee over 0.001 XRP fails', () => failsWith(W.payment({ Fee: '1001' }), 'fee-over-cap'));
  test('single-signed: fee at exactly 0.001 XRP passes', () => passes(W.payment({ Fee: '1000' })));
  test('multi-signed: fee over 0.002 XRP fails', () => failsWith(W.payment({ SigningPubKey: '', Fee: '2001' }), 'fee-over-cap', ctx({ multisigned: true })));
  test('AccountDelete: fee over owner reserve + 0.001 XRP fails', () => failsWith(
    W.base(W.friend.address, { TransactionType: 'AccountDelete', Destination: W.personal.address, Fee: String(BigInt(OWNER_RESERVE) + 1001n) }),
    'fee-over-cap'));
  test('AccountDelete: missing owner reserve fails closed', () => failsWith(
    W.base(W.friend.address, { TransactionType: 'AccountDelete', Destination: W.personal.address, Fee: '12' }),
    'fee-cap-unknown', ctx({ ownerReserveDrops: undefined })));
  test('AccountDelete: an owner reserve over the 2 XRP ceiling fails closed (A4)', () => failsWith(
    W.base(W.friend.address, { TransactionType: 'AccountDelete', Destination: W.personal.address, Fee: '50000000000' }),
    'fee-cap-unknown', ctx({ ownerReserveDrops: '50000000000' })));
  test('fee that is not a drops string fails', () => failsWith(W.payment({ Fee: 12 }), 'fee-missing'));
  test('fee in decimal XRP fails', () => failsWith(W.payment({ Fee: '0.00001' }), 'fee-missing'));
});

describe('§4.8 payment', () => {
  test('non-XRP (issued currency) Amount fails', () => failsWith(
    W.payment({ Amount: { currency: 'USD', issuer: W.exchange.address, value: '1' } }), 'payment-not-xrp'));
  test('Amount that is not a drops integer fails', () => failsWith(W.payment({ Amount: '1.5' }), 'payment-amount'));
  test('zero Amount fails', () => failsWith(W.payment({ Amount: '0' }), 'payment-amount'));
  test('tfPartialPayment flag fails', () => failsWith(W.payment({ Flags: 0x00020000 }), 'payment-partial'));
  test('tfPartialPayment combined with tfFullyCanonicalSig still fails', () => failsWith(W.payment({ Flags: 0x80020000 }), 'payment-partial'));
  test('Paths fails', () => failsWith(W.payment({ Paths: [[]] }), 'forbidden-field'));
  test('SendMax fails', () => failsWith(W.payment({ SendMax: '1000000' }), 'forbidden-field'));
  test('DeliverMin fails', () => failsWith(W.payment({ DeliverMin: '1' }), 'forbidden-field'));
  test('DeliverMax fails', () => failsWith(W.payment({ DeliverMax: '1000000' }), 'forbidden-field'));
  test('Destination equal to Account fails', () => failsWith(W.payment({ Destination: W.personal.address }), 'payment-self'));
  test('invalid Destination fails', () => failsWith(W.payment({ Destination: 'rNotAnAddress' }), 'destination'));
  test('other Payment flags need an ack', () => needsAck(W.payment({ Flags: 0x00010000 }), 'unknown-flags'));
});

describe('§4.8 destination tags', () => {
  test('destination labelled as an exchange without a tag fails', () => failsWith(W.payment({ Destination: W.exchange.address }), 'dest-tag-required'));
  test('exchange destination with a tag passes', () => passes(W.payment({ Destination: W.exchange.address, DestinationTag: 123456 })));
  test('destination the user marked as needing a tag fails without one', () => {
    const book = [{ label: 'Tagged', address: W.friend.address, isExchange: false, requiresTag: true }];
    failsWith(W.payment(), 'dest-tag-required', ctx({ addressBook: book }));
  });
  test('non-integer DestinationTag fails', () => failsWith(W.payment({ DestinationTag: '12' }), 'destination-tag'));
  test('estate payment with no tag needs an ack (DECISIONS A7)', () => needsAck(
    W.payment({ SigningPubKey: '', Fee: '2000' }), 'no-destination-tag', ctx({ multisigned: true, requireTag: true, addressBook: [] })));
});

describe('§4.8 SetRegularKey', () => {
  test('SetRegularKey without RegularKey (removes the key) fails', () => failsWith(
    W.base(W.personal.address, { TransactionType: 'SetRegularKey' }), 'srk-removes-key'));
  test('a template is allowed to lack RegularKey until filled', () => passes(
    W.base(W.personal.address, { TransactionType: 'SetRegularKey' }), ctx({ template: true })));
  test('a template that already carries a RegularKey fails', () => failsWith(
    W.base(W.personal.address, { TransactionType: 'SetRegularKey', RegularKey: W.reg.managed.address }), 'template-filled', ctx({ template: true })));
  test('RegularKey equal to Account fails', () => failsWith(
    W.base(W.personal.address, { TransactionType: 'SetRegularKey', RegularKey: W.personal.address }), 'regular-key'));
});

describe('§4.8 expiry', () => {
  test('missing LastLedgerSequence fails', () => {
    const tx = W.payment();
    delete tx.LastLedgerSequence;
    failsWith(tx, 'lls-missing');
  });
  test('missing Sequence fails', () => {
    const tx = W.payment();
    delete tx.Sequence;
    failsWith(tx, 'sequence-missing');
  });
});

describe('§4.8 unknown fields', () => {
  test('an unknown field blocks signing until acknowledged', () => {
    const r = needsAck(W.payment({ Memos: [{ Memo: { MemoData: '00' } }] }), 'unknown-field');
    const key = r.acks.find((a) => a.code === 'unknown-field').key;
    assert.equal(canSign(r, { [key]: true }), true);
  });
  test('each unknown field needs its own ack', () => {
    const r = needsAck(W.payment({ Memos: [], TicketSequence: 5 }), 'unknown-field');
    assert.equal(r.acks.length, 2);
    assert.equal(canSign(r, { [r.acks[0].key]: true }), false);
  });
  test('NetworkID is refused outright', () => failsWith(W.payment({ NetworkID: 1 }), 'forbidden-field'));
  test('already-signed input is refused', () => failsWith(W.payment({ TxnSignature: 'AB' }), 'forbidden-field'));
});

describe('§3 types and signer lists', () => {
  test('unsupported transaction type fails', () => failsWith(
    W.base(W.personal.address, { TransactionType: 'TrustSet', LimitAmount: { currency: 'USD', issuer: W.exchange.address, value: '1' } }), 'unsupported-type'));
  test('deleting a signer list (quorum 0) needs the typed phrase', () => {
    const r = needsAck(W.base(W.personal.address, { TransactionType: 'SignerListSet', SignerQuorum: 0 }), 'signerlist-delete');
    const key = r.acks[0].key;
    assert.equal(canSign(r, { [key]: true }), false, 'a checkbox is not enough');
    assert.equal(canSign(r, { [key]: 'delete signer list' }), false, 'phrase must match exactly');
    assert.equal(canSign(r, { [key]: DELETE_SIGNER_LIST_PHRASE }), true);
  });
  test('SignerListSet whose quorum exceeds the total weight fails', () => failsWith(W.base(W.personal.address, {
    TransactionType: 'SignerListSet', SignerQuorum: 2,
    SignerEntries: [{ SignerEntry: { Account: W.spare.personal.address, SignerWeight: 1 } }],
  }), 'signer-quorum'));
  test('AccountDelete to a non-vault destination needs an explicit override', () => needsAck(
    W.base(W.friend.address, { TransactionType: 'AccountDelete', Destination: W.exchange.address, Fee: OWNER_RESERVE }), 'accountdelete-destination'));
  test('single-signed input carrying SigningPubKey fails', () => failsWith(W.payment({ SigningPubKey: 'ED00' }), 'signing-pubkey'));
  test('multisigned input without empty SigningPubKey fails', () => failsWith(W.payment({ Fee: '2000' }), 'signing-pubkey', ctx({ multisigned: true })));
});
