// Online Builder core (SPEC §5, DECISIONS A21-A25), against a fake ledger.
// Every envelope built here must pass the offline signer's own checks.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import * as xrpl from 'xrpl';
import { MockLedger } from './mockLedger.js';
import { makeWorld } from '../unit/helpers.js';
import { build, feeFor, xrpToDrops, BuildError } from '../../src/online/core/builders.js';
import { networkState, snapshot } from '../../src/online/core/ledger.js';
import { deleteBlockers } from '../../src/online/core/blockers.js';
import { checkSigned, postChecks } from '../../src/online/core/verify.js';
import { submitAll, submitAndWait, plainResult } from '../../src/online/core/submit.js';
import { loadWatch, addWatch, removeWatch, clearWatch, containsSeed } from '../../src/online/core/watch.js';
import { estateLetter, SPARE_CARD_GROUPS } from '../../src/online/core/letter.js';
import { validateEnvelope, fillRegularKey, fillSignerList } from '../../src/offline/core/envelope.js';
import { signTx, multisignTx, generateKey } from '../../src/offline/core/keys.js';
import { runSelfTest } from '../../src/offline/core/selftest.js';
import { _resetGateForTests } from '../../src/offline/core/gate.js';

const noSleep = { sleep: async () => {}, pollMs: 0 };
const rejectsCode = (p, code) => assert.rejects(p, (e) => e instanceof BuildError && e.code === code, `expected ${code}`);

function world() {
  const W = makeWorld('testnet');
  const L = new MockLedger();
  L.addAccount(W.personal.address, { regularKey: W.reg.personal.address, spare: W.spare.personal.address, balance: '100000000' });
  L.addAccount(W.managed.address, { regularKey: W.reg.managed.address, spare: W.spare.managed.address });
  L.addAccount(W.friend.address, { flags: 0 });
  L.addAccount(W.exchange.address, { flags: 0x00020000 }); // lsfRequireDestTag
  return { W, L, rpc: (r) => L.rpc(r) };
}

before(() => { _resetGateForTests(); assert.equal(runSelfTest().passed, true); });

describe('fees, amounts and reserves (A21)', () => {
  const st = (open, inc = 200000n) => ({ openLedgerFee: BigInt(open), ownerReserve: inc });
  test('single fee is the open ledger fee; over 0.001 XRP is refused', () => {
    assert.equal(feeFor('single', st(12)), '12');
    assert.equal(feeFor('single', st(1000)), '1000');
    assert.throws(() => feeFor('single', st(1001)), (e) => e.code === 'fee-too-high' && /Wait/.test(e.message));
  });
  test('multi-signed fee is x2, capped at 0.002 XRP', () => {
    assert.equal(feeFor('multi', st(12)), '24');
    assert.throws(() => feeFor('multi', st(1001)), (e) => e.code === 'fee-too-high');
  });
  test('AccountDelete pays the owner reserve', () => assert.equal(feeFor('delete', st(12)), '200000'));
  test('XRP amounts convert without floating point', () => {
    assert.equal(xrpToDrops('12.5'), '12500000');
    assert.equal(xrpToDrops('0.000001'), '1');
    for (const bad of ['0', '1.1234567', 'abc', '-1', '1e6']) assert.throws(() => xrpToDrops(bad), BuildError, bad);
  });
  test('reserve = base + OwnerCount x owner reserve, in drops', async () => {
    const { W, rpc } = world();
    const s = await snapshot(rpc, W.personal.address, await networkState(rpc));
    assert.equal(s.snap.reserve, '1200000');
    assert.equal(s.snap.masterDisabled, true);
    assert.deepEqual(s.snap.signerList, { quorum: 1, entries: [{ account: W.spare.personal.address, weight: 1 }] });
  });
});

describe('every envelope passes the offline checks', () => {
  test('send', async () => {
    const { W, rpc } = world();
    const { env } = await build(rpc, 'testnet', 'sign', { account: W.personal.address, destination: W.friend.address, amountXrp: '2' });
    assert.equal(validateEnvelope(env, { vault: W.vault }).ok, true);
    assert.equal(env.txs[0].Amount, '2000000');
    assert.equal(env.txs[0].LastLedgerSequence, 5000 + 900);
    assert.deepEqual(env.builtAt, { ledgerIndex: 5000, closeTime: new Date((838000000 + 946684800) * 1000).toISOString() });
  });
  test('a destination that requires a tag needs one', async () => {
    const { W, rpc } = world();
    await rejectsCode(build(rpc, 'testnet', 'sign', { account: W.personal.address, destination: W.exchange.address, amountXrp: '1' }), 'tag-required');
    const { env } = await build(rpc, 'testnet', 'sign', { account: W.personal.address, destination: W.exchange.address, amountXrp: '1', destinationTag: '42' });
    assert.equal(env.txs[0].DestinationTag, 42);
  });
  test('a destination that does not exist is refused', async () => {
    const { W, rpc } = world();
    await rejectsCode(build(rpc, 'testnet', 'sign', { account: W.personal.address, destination: generateKey().address, amountXrp: '1' }), 'destination-missing');
  });
  test('accountset', async () => {
    const { W, rpc } = world();
    const { env } = await build(rpc, 'testnet', 'sign', { account: W.personal.address, accountSet: { SetFlag: 8, Domain: 'example.com' } });
    assert.equal(env.txs[0].Domain, '6578616D706C652E636F6D');
    assert.equal(validateEnvelope(env, { vault: W.vault }).ok, true);
  });
  test('send-rotate, rotate, replace-spare', async () => {
    const { W, rpc } = world();
    for (const [purpose, p] of [
      ['send-rotate', { account: W.personal.address, destination: W.friend.address, amountXrp: '1' }],
      ['rotate', { account: W.personal.address }],
      ['replace-spare', { account: W.personal.address }],
    ]) {
      const { env } = await build(rpc, 'testnet', purpose, p);
      assert.equal(validateEnvelope(env, { vault: W.vault }).ok, true, purpose);
    }
  });
  test('recovery: multi-signed template, fee x2', async () => {
    const { W, rpc } = world();
    const { env } = await build(rpc, 'testnet', 'recovery', { account: W.personal.address });
    assert.equal(env.txs[0].SigningPubKey, '');
    assert.equal(env.txs[0].Fee, '24');
    assert.equal(validateEnvelope(env, { vault: null, confirmedNetwork: 'testnet' }).ok, true);
  });
  test('estate: sends balance - reserve - fee; tag required by default', async () => {
    const { W, rpc } = world();
    await rejectsCode(build(rpc, 'testnet', 'estate', { account: W.personal.address, destination: W.friend.address }), 'tag-required');
    const { env } = await build(rpc, 'testnet', 'estate', { account: W.personal.address, destination: W.friend.address, destinationTag: 5 });
    assert.equal(env.txs[0].Amount, String(100000000n - 1200000n - 24n));
    const ok = await build(rpc, 'testnet', 'estate', { account: W.personal.address, destination: W.friend.address, noTagConfirmed: true });
    assert.equal(ok.env.txs[0].DestinationTag, undefined);
    assert.equal(validateEnvelope(env, { vault: null, confirmedNetwork: 'testnet' }).ok, true);
  });
  test('migration: SignerListSet then SetRegularKey per kept account, AccountDelete for small ones, 3-hour window', async () => {
    const { W, L, rpc } = world();
    const shared = generateKey();
    const small = generateKey();
    L.accounts.get(W.personal.address).RegularKey = shared.address;
    L.addAccount(small.address, { regularKey: shared.address, sequence: 10 });
    const { env } = await build(rpc, 'testnet', 'migration', { kept: [W.personal.address], small: [small.address], leftoversTo: W.personal.address });
    assert.deepEqual(env.txs.map((t) => t.TransactionType), ['SignerListSet', 'SetRegularKey', 'AccountDelete']);
    assert.equal(env.txs[1].Sequence, env.txs[0].Sequence + 1);
    assert.equal(env.txs[0].LastLedgerSequence, 5000 + 2700);
    assert.equal(env.txs[2].Fee, '200000');
    assert.equal(validateEnvelope(env, { vault: { ...W.vault, accounts: [] }, confirmedNetwork: 'testnet' }).ok, true);
  });
  test('migration: accounts on different regular keys are refused', async () => {
    const { W, rpc } = world();
    await rejectsCode(build(rpc, 'testnet', 'migration', { kept: [W.personal.address, W.managed.address], small: [] }), 'not-shared');
  });
  test('migration: a small account with a trust line is blocked, with the reason', async () => {
    const { W, L, rpc } = world();
    const shared = W.reg.personal.address;
    const small = generateKey();
    L.addAccount(small.address, { regularKey: shared, objects: [{ LedgerEntryType: 'RippleState' }] });
    await assert.rejects(build(rpc, 'testnet', 'migration', { kept: [], small: [small.address], leftoversTo: W.personal.address, leftoversKnown: [W.personal.address] }),
      (e) => e.code === 'delete-blocked' && /trust line/.test(e.message));
  });
  test('the network fee over the cap refuses to build (wait, never clamp)', async () => {
    const { W, L, rpc } = world();
    L.openLedgerFee = '5000';
    await rejectsCode(build(rpc, 'testnet', 'rotate', { account: W.personal.address }), 'fee-too-high');
  });
});

describe('AccountDelete blockers (A24)', () => {
  const base = { sequence: 10, balance: '5000000', ownerCount: 0, objects: [], ledgerIndex: 1000, ownerReserve: 200000n };
  test('a clean account can be deleted', () => assert.deepEqual(deleteBlockers(base), []));
  test('objects the ledger removes itself do not block', () => assert.deepEqual(deleteBlockers({ ...base, ownerCount: 2, objects: [{ LedgerEntryType: 'Offer' }, { LedgerEntryType: 'SignerList' }] }), []));
  test('escrow, trust line, too new, too little balance each block', () => {
    const codes = deleteBlockers({ ...base, sequence: 900, balance: '100000', ownerCount: 2, objects: [{ LedgerEntryType: 'Escrow' }, { LedgerEntryType: 'RippleState' }] }).map((b) => b.code);
    assert.deepEqual(codes, ['object', 'object', 'too-new', 'balance']);
  });
  test('owned objects not listed still block', () => assert.equal(deleteBlockers({ ...base, ownerCount: 1 })[0].code, 'owner-count'));
});

describe('signed-blob checks, submission and post-checks (A22, SPEC 5.5)', () => {
  async function signedRotation() {
    const { W, L, rpc } = world();
    const { env } = await build(rpc, 'testnet', 'send-rotate', { account: W.personal.address, destination: W.friend.address, amountXrp: '1' });
    const newKey = generateKey();
    const pay = signTx(env.txs[0], W.reg.personal);
    const srk = signTx(fillRegularKey(env.txs[1], newKey.address), W.reg.personal);
    return { W, L, rpc, env, newKey, pay, srk };
  }

  test('round trip: build, sign offline, check, submit, post-check', async () => {
    const { L, rpc, env, newKey, pay, srk } = await signedRotation();
    const checks = [checkSigned(env.txs[0], pay.tx_blob), checkSigned(env.txs[1], srk.tx_blob)];
    assert.deepEqual(checks.map((c) => c.errors), [[], []]);
    assert.equal(checks[1].filled.regularKey, newKey.address);
    const res = await submitAll(rpc, 'send-rotate', checks.map((c, i) => ({ blob: [pay, srk][i].tx_blob, tx: c.tx })), noSleep);
    assert.deepEqual(res.map((r) => r.code), ['tesSUCCESS', 'tesSUCCESS']);
    assert.equal(res[1].hash, xrpl.hashes.hashSignedTx(srk.tx_blob));
    const state = await networkState(rpc);
    const after = { [env.txs[0].Account]: (await snapshot(rpc, env.txs[0].Account, state)).snap };
    assert.deepEqual(postChecks('send-rotate', checks, after), []);
    assert.equal(L.accounts.get(env.txs[0].Account).RegularKey, newKey.address);
  });

  test('a changed field is refused', async () => {
    const { W, env } = await signedRotation();
    const tampered = signTx({ ...env.txs[0], Amount: '9000000' }, W.reg.personal);
    assert.match(checkSigned(env.txs[0], tampered.tx_blob).errors.join(), /Amount changed/);
  });
  test('an extra field is refused', async () => {
    const { W, env } = await signedRotation();
    const extra = signTx({ ...env.txs[0], Memos: [{ Memo: { MemoData: '41' } }] }, W.reg.personal);
    assert.match(checkSigned(env.txs[0], extra.tx_blob).errors.join(), /unexpected field Memos/);
  });
  test('a template filled with two signers is refused', async () => {
    const { W, rpc } = world();
    const { env } = await build(rpc, 'testnet', 'replace-spare', { account: W.personal.address });
    const two = { ...env.txs[0], SignerQuorum: 1, SignerEntries: [generateKey(), generateKey()].map((k) => ({ SignerEntry: { Account: k.address, SignerWeight: 1 } })) };
    assert.match(checkSigned(env.txs[0], signTx(two, W.reg.personal).tx_blob).errors.join(), /one spare/);
    const spare = generateKey().address;
    const ok = checkSigned(env.txs[0], signTx(fillSignerList(env.txs[0], spare), W.reg.personal).tx_blob);
    assert.equal(ok.filled.spare, spare);
  });
  test('a multi-signed template must come back multi-signed by one signer', async () => {
    const { W, rpc } = world();
    const { env } = await build(rpc, 'testnet', 'recovery', { account: W.personal.address });
    const newKey = generateKey();
    const good = multisignTx(fillRegularKey(env.txs[0], newKey.address), W.spare.personal);
    assert.deepEqual(checkSigned(env.txs[0], good.tx_blob).errors, []);
  });
  test('garbage is reported, not thrown', () => {
    assert.equal(checkSigned({ TransactionType: 'Payment' }, 'zzzz').ok, false);
  });

  test('send & rotate gating: a payment that did not use its sequence stops the key change', async () => {
    const { rpc, env, pay, srk, W } = await signedRotation();
    const badPay = signTx({ ...env.txs[0], Sequence: 999 }, W.reg.personal);
    const res = await submitAll(rpc, 'send-rotate', [{ blob: badPay.tx_blob, tx: { ...env.txs[0], Sequence: 999 } }, { blob: srk.tx_blob, tx: env.txs[1] }], noSleep);
    assert.equal(res[1].code, 'skipped');
    assert.match(res[1].message, /Rotate-only/);
    void pay;
  });
  test('send & rotate gating: a tec payment still lets the key change go (sequence used)', async () => {
    const { L, rpc, env, pay, srk } = await signedRotation();
    L.results.push('tecUNFUNDED_PAYMENT');
    const res = await submitAll(rpc, 'send-rotate', [{ blob: pay.tx_blob, tx: env.txs[0] }, { blob: srk.tx_blob, tx: env.txs[1] }], noSleep);
    assert.deepEqual(res.map((r) => r.code), ['tecUNFUNDED_PAYMENT', 'tesSUCCESS']);
  });
  test('migration gating: a tec SignerListSet holds back that account key change', async () => {
    const { W, L, rpc } = world();
    const shared = generateKey();
    L.accounts.get(W.personal.address).RegularKey = shared.address;
    const { env } = await build(rpc, 'testnet', 'migration', { kept: [W.personal.address], small: [] });
    const sls = signTx(fillSignerList(env.txs[0], generateKey().address), shared);
    const srk = signTx(fillRegularKey(env.txs[1], generateKey().address), shared);
    L.results.push('tecINSUFFICIENT_RESERVE');
    const res = await submitAll(rpc, 'migration', [{ blob: sls.tx_blob, tx: env.txs[0] }, { blob: srk.tx_blob, tx: env.txs[1] }], noSleep);
    assert.deepEqual(res.map((r) => r.code), ['tecINSUFFICIENT_RESERVE', 'skipped']);
    assert.equal(L.accounts.get(W.personal.address).RegularKey, shared.address, 'the shared key still controls the account');
  });
  test('an expired transaction is reported in plain English', async () => {
    const { rpc, pay, env } = await signedRotation();
    const r = await submitAndWait(async (req) => (req.command === 'submit' ? { engine_result: 'terQUEUED' } : req.command === 'tx' ? { validated: false } : rpc(req)),
      pay.tx_blob, { lastLedgerSequence: 10, ...noSleep });
    assert.equal(r.code, 'tefMAX_LEDGER');
    assert.match(plainResult('tefMAX_LEDGER'), /expired/);
    void env;
  });
  test('migration post-check catches an account still on the shared key', () => {
    const shared = generateKey().address;
    const a = generateKey().address;
    assert.match(postChecks('migration', [], { [a]: { regularKey: shared } }, { shared }).join(), /still uses the shared key/);
  });
});

describe('watch-only list and secret guard (A23)', () => {
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
  test('lists are per network, labels and addresses only, and can be cleared', () => {
    const s = store();
    const a = generateKey().address;
    addWatch(s, 'testnet', 'Practice', a);
    assert.deepEqual(loadWatch(s, 'testnet'), [{ label: 'Practice', address: a }]);
    assert.deepEqual(loadWatch(s, 'mainnet'), []);
    assert.throws(() => addWatch(s, 'testnet', 'Again', a), /already/);
    assert.throws(() => addWatch(s, 'testnet', 'Bad', 'rNope'), /not a valid/);
    removeWatch(s, 'testnet', a);
    assert.deepEqual(loadWatch(s, 'testnet'), []);
    addWatch(s, 'testnet', 'X', a);
    clearWatch(s, 'testnet');
    assert.equal(s.m.size, 0);
  });
  test('any seed in typed or pasted text is detected', () => {
    const k = generateKey();
    assert.equal(containsSeed(k.seed), true);
    assert.equal(containsSeed(`my key is ${generateKey('secp256k1').seed} ok`), true);
    assert.equal(containsSeed(k.address), false);
    assert.equal(containsSeed('hello world'), false);
  });
});

describe('estate letter and spare card (A25)', () => {
  test('the letter has the URLs, the offline hash, the tag warning and no secret', () => {
    const a = generateKey().address;
    const L = estateLetter({ address: a, accountLabel: 'Managed', network: 'mainnet', offlineSha256: 'ab'.repeat(32) });
    const text = JSON.stringify(L);
    assert.match(text, /kakoyla\.github\.io\/icecold-v3\/icecold-v3-offline\.html/);
    assert.match(text, /kakoyla\.github\.io\/icecold-v3\/icecold-v3-online\.html/);
    assert.ok(text.includes('ab'.repeat(32)));
    assert.match(text, /destination tag/i);
    assert.match(text, /Pick someone you trust in person/);
    assert.match(text, /recovery services.*theft/i);
    assert.match(text, /kept at: _{10,}/, 'the location is left blank');
    assert.doesNotMatch(text, /\bs[1-9A-HJ-NP-Za-km-z]{24,34}\b/, 'no seed-like text');
  });
  test('the blank card has 31 boxes in groups 4-4-4-4-4-4-4-3', () => {
    assert.equal(SPARE_CARD_GROUPS.reduce((a, b) => a + b, 0), 31);
    assert.deepEqual([...SPARE_CARD_GROUPS], [4, 4, 4, 4, 4, 4, 4, 3]);
  });
});
