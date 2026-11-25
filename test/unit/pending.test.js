// SPEC §7.1: pending-key resolution in all three cases: ledger matches
// current, ledger matches pending, ledger matches neither.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePendingKey, resolveForEnvelope, BLOCKED_MESSAGE } from '../../src/offline/core/pending.js';
import { storedKey, validatePayload } from '../../src/offline/core/vault.js';
import { generateKey } from '../../src/offline/core/keys.js';
import { makeWorld } from './helpers.js';

function accountWithPending() {
  const W = makeWorld();
  const pending = storedKey(generateKey());
  const acct = { ...W.vault.accounts[0], pendingKey: pending };
  return { W, acct, current: acct.regularKey, pending };
}

describe('resolvePendingKey', () => {
  test('ledger matches current: keep current, discard the pending key', () => {
    const { acct, current } = accountWithPending();
    const r = resolvePendingKey(acct, current.address);
    assert.equal(r.status, 'discarded');
    assert.equal(r.changed, true);
    assert.equal(r.account.regularKey, current);
    assert.equal(r.account.pendingKey, null);
    assert.deepEqual(r.account.retiredKeys, []);
  });

  test('ledger matches current with no pending key: nothing changes', () => {
    const { W } = accountWithPending();
    const a = W.vault.accounts[0];
    const r = resolvePendingKey(a, a.regularKey.address);
    assert.equal(r.status, 'current');
    assert.equal(r.changed, false);
    assert.equal(r.account, a);
  });

  test('ledger matches pending: promote pending to current and retire the old key', () => {
    const { acct, current, pending } = accountWithPending();
    const r = resolvePendingKey(acct, pending.address);
    assert.equal(r.status, 'promoted');
    assert.equal(r.changed, true);
    assert.equal(r.account.regularKey, pending);
    assert.equal(r.account.pendingKey, null);
    assert.deepEqual(r.account.retiredKeys, [current.address]);
  });

  test('ledger matches neither: signing is blocked and points to Recovery', () => {
    const { acct } = accountWithPending();
    const r = resolvePendingKey(acct, generateKey().address);
    assert.equal(r.status, 'blocked');
    assert.equal(r.changed, false);
    assert.equal(r.message, BLOCKED_MESSAGE);
    assert.match(r.message, /Recovery/);
  });

  test('ledger has no regular key at all: blocked', () => {
    const { acct } = accountWithPending();
    assert.equal(resolvePendingKey(acct, null).status, 'blocked');
  });

  test('migration: no current key yet, ledger matches pending -> promoted', () => {
    const { acct, pending } = accountWithPending();
    const r = resolvePendingKey({ ...acct, regularKey: null }, pending.address);
    assert.equal(r.status, 'promoted');
    assert.deepEqual(r.account.retiredKeys, []);
  });
});

describe('resolveForEnvelope', () => {
  test('applies to the accounts the envelope uses, and the result is still a valid vault', () => {
    const { W, acct, pending } = accountWithPending();
    const payload = { ...W.vault, accounts: [acct, W.vault.accounts[1]] };
    const env = W.envelope('sign', [W.payment()]);
    env.ledger = { ...env.ledger, [acct.address]: { ...env.ledger[acct.address], regularKey: pending.address } };
    const r = resolveForEnvelope(payload, env);
    assert.equal(r.results[acct.address], 'promoted');
    assert.equal(r.results[W.managed.address], undefined, 'accounts not in the envelope are left alone');
    assert.deepEqual(r.blocked, []);
    assert.equal(r.changed, true);
    assert.doesNotThrow(() => validatePayload(r.payload, 'testnet'));
  });

  test('reports blocked accounts', () => {
    const { W } = accountWithPending();
    const env = W.envelope('sign', [W.payment()]);
    env.ledger = { ...env.ledger, [W.personal.address]: { ...env.ledger[W.personal.address], regularKey: generateKey().address } };
    const r = resolveForEnvelope(W.vault, env);
    assert.deepEqual(r.blocked, [W.personal.address]);
  });
});
