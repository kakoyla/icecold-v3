// SPEC §7.1: envelope validation. SPEC §4.4 step 2, §4.8 network, §5.3 shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEnvelope, estimateExpiry, fillRegularKey, fillSignerList, spareInSignerList,
} from '../../src/offline/core/envelope.js';
import { checkTransaction } from '../../src/offline/core/safety.js';
import { generateKey } from '../../src/offline/core/keys.js';
import { makeWorld } from './helpers.js';

const W = makeWorld('testnet');
const srkTemplate = (acct = W.personal.address, seq = 11) =>
  W.base(acct, { TransactionType: 'SetRegularKey', Sequence: seq });
const errCodes = (r) => [...r.errors, ...r.txs.flatMap((t) => t.errors)].map((e) => e.code);

function ok(env, ctx = { vault: W.vault }) {
  const r = validateEnvelope(env, ctx);
  assert.equal(r.ok, true, JSON.stringify(errCodes(r)));
  return r;
}
function bad(env, code, ctx = { vault: W.vault }) {
  const r = validateEnvelope(env, ctx);
  assert.equal(r.ok, false);
  assert.ok(errCodes(r).includes(code), `expected ${code}, got ${JSON.stringify(errCodes(r))}`);
}

describe('valid envelopes for each purpose', () => {
  test('sign: one Payment', () => ok(W.envelope('sign', [W.payment()])));
  test('send-rotate: Payment (N) + SetRegularKey template (N+1)', () => {
    const r = ok(W.envelope('send-rotate', [W.payment({ Sequence: 10 }), srkTemplate(W.personal.address, 11)]));
    assert.deepEqual(r.txs.map((t) => t.template), [false, true]);
  });
  test('rotate: one SetRegularKey template', () => ok(W.envelope('rotate', [srkTemplate()])));
  test('replace-spare: one SignerListSet template', () => ok(W.envelope('replace-spare', [
    W.base(W.personal.address, { TransactionType: 'SignerListSet', SignerQuorum: 1 })])));
  test('recovery: multisigned SetRegularKey template, no vault, network confirmed', () => ok(
    W.envelope('recovery', [W.base(W.personal.address, { TransactionType: 'SetRegularKey', SigningPubKey: '', Fee: '24' })]),
    { vault: null, confirmedNetwork: 'testnet' }));
  test('estate: multisigned Payment with tag, no vault, network confirmed', () => ok(
    W.envelope('estate', [W.payment({ SigningPubKey: '', Fee: '24', DestinationTag: 7 })]),
    { vault: null, confirmedNetwork: 'testnet' }));
  test('migration: accounts not yet in the (new, empty) vault are allowed', () => {
    const fresh = { ...W.vault, accounts: [] };
    ok(W.envelope('migration', [
      srkTemplate(W.personal.address, 10),
      W.base(W.personal.address, { TransactionType: 'SignerListSet', SignerQuorum: 1, Sequence: 11 }),
    ]), { vault: fresh });
  });
});

describe('envelope structure', () => {
  test('unknown purpose fails', () => bad(W.envelope('sweep', [W.payment()]), 'purpose'));
  test('unsupported envelope version fails', () => bad(W.envelope('sign', [W.payment()], { version: 2 }), 'version'));
  test('unknown envelope field fails', () => bad(W.envelope('sign', [W.payment()], { extra: 1 }), 'envelope'));
  test('missing builtAt fails', () => {
    const e = W.envelope('sign', [W.payment()]);
    delete e.builtAt;
    bad(e, 'envelope');
  });
  test('empty txs fails', () => bad(W.envelope('sign', []), 'txs'));
  test('unsupported transaction type fails', () => bad(W.envelope('sign', [
    W.base(W.personal.address, { TransactionType: 'OfferCreate' })]), 'unsupported-type'));
  test('missing ledger snapshot for the account fails', () => {
    const e = W.envelope('sign', [W.payment()]);
    e.ledger = { [W.managed.address]: e.ledger[W.managed.address] };
    bad(e, 'ledger-missing');
  });
  test('malformed ledger snapshot fails', () => {
    const e = W.envelope('sign', [W.payment()]);
    e.ledger = { ...e.ledger, [W.personal.address]: { ...e.ledger[W.personal.address], balance: 5 } };
    bad(e, 'ledger');
  });
});

describe('purpose shapes', () => {
  test('send-rotate with wrong sequence order fails', () => bad(
    W.envelope('send-rotate', [W.payment({ Sequence: 10 }), srkTemplate(W.personal.address, 12)]), 'purpose-shape'));
  test('send-rotate with different accounts fails', () => bad(
    W.envelope('send-rotate', [W.payment({ Sequence: 10 }), srkTemplate(W.managed.address, 11)]), 'purpose-shape'));
  test('send-rotate whose SetRegularKey already has a key fails', () => bad(
    W.envelope('send-rotate', [W.payment({ Sequence: 10 }), { ...srkTemplate(), RegularKey: generateKey().address }]), 'template-filled'));
  test('rotate with a Payment fails', () => bad(W.envelope('rotate', [W.payment()]), 'purpose-shape'));
  test('sign with two transactions fails', () => bad(W.envelope('sign', [W.payment(), W.payment({ Sequence: 11 })]), 'purpose-shape'));
  test('migration containing a Payment fails', () => bad(W.envelope('migration', [W.payment()]), 'purpose-shape'));
  test('estate that is not multisigned fails', () => bad(
    W.envelope('estate', [W.payment({ DestinationTag: 7 })]), 'signing-pubkey', { vault: null, confirmedNetwork: 'testnet' }));
});

describe('§4.8 network and §4.4 vault membership', () => {
  test('envelope network different from the vault network fails', () => {
    bad(W.envelope('sign', [W.payment()], { network: 'mainnet' }), 'network-mismatch');
  });
  test('a mainnet vault cannot sign a testnet envelope', () => {
    bad(W.envelope('sign', [W.payment()]), 'network-mismatch', { vault: { ...W.vault, network: 'mainnet' } });
  });
  test('no vault and no network confirmation fails (estate, DECISIONS A3)', () => bad(
    W.envelope('estate', [W.payment({ SigningPubKey: '', Fee: '24', DestinationTag: 7 })]), 'network-unconfirmed', { vault: null }));
  test('no vault and a confirmation for the other network fails', () => bad(
    W.envelope('estate', [W.payment({ SigningPubKey: '', Fee: '24', DestinationTag: 7 })]), 'network-unconfirmed',
    { vault: null, confirmedNetwork: 'mainnet' }));
  test('account not in the vault fails for sign', () => {
    const stranger = generateKey().address;
    const e = W.envelope('sign', [W.payment({ Account: stranger })]);
    e.ledger = { ...e.ledger, [stranger]: W.snapshot(generateKey().address) };
    bad(e, 'account-not-in-vault');
  });
});

describe('expiry estimate and template filling', () => {
  test('estimated expiry = closeTime + (LLS - ledgerIndex) x 4 s', () => {
    const e = W.envelope('sign', [W.payment({ LastLedgerSequence: 1100 + 900 })]);
    assert.equal(estimateExpiry(e, e.txs[0]).toISOString(), '2026-11-25T13:00:00.000Z');
  });

  test('filled SetRegularKey passes the final checks; empty one would be refused', () => {
    const tmpl = srkTemplate();
    assert.ok(checkTransaction(tmpl, { template: false }).errors.some((x) => x.code === 'srk-removes-key'));
    const filled = fillRegularKey(tmpl, generateKey().address);
    assert.deepEqual(checkTransaction(filled, { template: false }).errors, []);
    assert.throws(() => fillRegularKey(filled, generateKey().address), /template/);
  });

  test('filled SignerListSet has quorum 1 and one weight-1 entry', () => {
    const spare = generateKey().address;
    const filled = fillSignerList(W.base(W.personal.address, { TransactionType: 'SignerListSet', SignerQuorum: 1 }), spare);
    assert.deepEqual(filled.SignerEntries, [{ SignerEntry: { Account: spare, SignerWeight: 1 } }]);
    assert.deepEqual(checkTransaction(filled, { template: false }).errors, []);
  });

  test('spareInSignerList (SPEC §4.6 step 2)', () => {
    const e = W.envelope('recovery', []);
    assert.equal(spareInSignerList(e, W.personal.address, W.spare.personal.address), true);
    assert.equal(spareInSignerList(e, W.personal.address, W.spare.managed.address), false);
    assert.equal(spareInSignerList(e, W.personal.address, generateKey().address), false);
  });
});
