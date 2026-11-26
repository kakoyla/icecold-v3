// SPEC §4.4 step 3: plain-English summary and every raw field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTx, dropsToXrp, shortAddress, describeFlags } from '../../src/offline/core/describe.js';
import { makeWorld } from './helpers.js';

const W = makeWorld();
const ctx = { accounts: W.vault.accounts, addressBook: W.vault.accounts[0].addressBook };
const text = (d) => d.summary.map((s) => s.text).join('');

test('drops convert to exact XRP strings', () => {
  assert.equal(dropsToXrp('500000000'), '500');
  assert.equal(dropsToXrp('1234567890'), '1,234.56789');
  assert.equal(dropsToXrp('1'), '0.000001');
  assert.equal(dropsToXrp('100000000000000000'), '100,000,000,000');
});

test('Payment summary names both sides and the tag', () => {
  const d = describeTx(W.payment({ Amount: '500000000', Destination: W.exchange.address, DestinationTag: 123456 }), ctx);
  assert.equal(text(d), `Send 500 XRP from Personal (${shortAddress(W.personal.address)}) to Exchange deposit (${shortAddress(W.exchange.address)}), tag 123456`);
  assert.equal(d.firstTimeDestination, false);
});

test('a destination not in the address book is a first-time destination', () => {
  const d = describeTx(W.payment({ Destination: W.reg.managed.address }), ctx);
  assert.equal(d.firstTimeDestination, true);
  assert.match(text(d), /no destination tag/);
});

test('every field is listed; unknown fields are called out', () => {
  const d = describeTx(W.payment({ Memos: [{ Memo: { MemoData: '41' } }] }), ctx);
  assert.deepEqual(d.fields.map((f) => f.key).sort(), Object.keys(W.payment({ Memos: [] })).sort());
  const memo = d.fields.find((f) => f.key === 'Memos');
  assert.equal(memo.known, false);
  assert.match(memo.label, /UNKNOWN FIELD Memos/);
});

test('AccountSet flags and fields are in plain English; unknown values are called out', () => {
  const d = describeTx(W.base(W.personal.address, { TransactionType: 'AccountSet', SetFlag: 4, ClearFlag: 99, Domain: '6578616D706C652E636F6D', TransferRate: 1005000000 }), ctx);
  const s = text(d);
  assert.match(s, /turn ON: disable the master key/);
  assert.match(s, /turn OFF: UNKNOWN setting 99/);
  assert.match(s, /domain: example\.com/);
  assert.match(s, /0\.5% on transfers/);
});

test('transaction Flags bits are named, unknown bits called out', () => {
  assert.deepEqual(describeFlags('AccountSet', 0x80010000), ['tfFullyCanonicalSig (harmless, historical)', 'tfRequireDestTag: require a destination tag']);
  assert.deepEqual(describeFlags('Payment', 0x1), ['UNKNOWN 0x1']);
  assert.deepEqual(describeFlags('Payment', 0), ['none']);
});

test('AccountDelete, SetRegularKey and SignerListSet summaries', () => {
  assert.match(text(describeTx(W.base(W.personal.address, { TransactionType: 'AccountDelete', Destination: W.managed.address }), ctx)), /^DELETE Personal .* send all its remaining XRP to Managed/);
  assert.match(text(describeTx(W.base(W.personal.address, { TransactionType: 'SetRegularKey' }), ctx)), /filled in offline/);
  assert.match(text(describeTx(W.base(W.personal.address, { TransactionType: 'SignerListSet', SignerQuorum: 1,
    SignerEntries: [{ SignerEntry: { Account: W.spare.personal.address, SignerWeight: 1 } }] }), ctx)), /weight 1\), quorum 1$/);
});
