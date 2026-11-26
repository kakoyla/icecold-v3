#!/usr/bin/env node
// Optional live check on the XRPL TESTNET (never mainnet): `npm run test:testnet`.
// Funds throwaway accounts from the public Testnet faucet, sets them up like
// ICE COLD accounts (regular key, master disabled, signer list with a spare),
// then runs Send & Rotate and Recovery through the real builders, the offline
// signing core, the A22 checks, submission and the post-checks.
// Keys are generated fresh in memory and thrown away; nothing is written.
import { Client, Wallet } from 'xrpl';
import { SERVERS } from '../src/online/core/config.js';
import { build } from '../src/online/core/builders.js';
import { networkState, snapshot } from '../src/online/core/ledger.js';
import { checkSigned, postChecks } from '../src/online/core/verify.js';
import { submitAll } from '../src/online/core/submit.js';
import { generateKey, signTx, multisignTx } from '../src/offline/core/keys.js';
import { fillRegularKey } from '../src/offline/core/envelope.js';
import { runSelfTest } from '../src/offline/core/selftest.js';

const step = (s) => console.log(`- ${s}`);
if (!runSelfTest().passed) throw new Error('offline self-test failed');

const client = new Client(SERVERS.testnet[0]);
await client.connect();
const rpc = async (req) => {
  try { return (await client.request(req)).result; } catch (e) { const x = new Error(e.data?.error_message || e.message); x.code = e.data?.error; throw x; }
};

try {
  step('funding two throwaway Testnet accounts from the faucet');
  const { wallet: acct } = await client.fundWallet();
  const { wallet: dest } = await client.fundWallet();
  const reg = generateKey();
  const spare = generateKey();
  step('setting a regular key, a signer list with a spare, and disabling the master key');
  for (const tx of [
    { TransactionType: 'SetRegularKey', Account: acct.address, RegularKey: reg.address },
    { TransactionType: 'SignerListSet', Account: acct.address, SignerQuorum: 1, SignerEntries: [{ SignerEntry: { Account: spare.address, SignerWeight: 1 } }] },
    { TransactionType: 'AccountSet', Account: acct.address, SetFlag: 4 },
  ]) {
    const r = await client.submitAndWait(tx, { wallet: acct });
    if (r.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error(`setup ${tx.TransactionType}: ${r.result.meta.TransactionResult}`);
  }
  void Wallet;

  const run = async (purpose, params, signAll) => {
    const { env } = await build(rpc, 'testnet', purpose, params);
    const signed = signAll(env);
    const checks = env.txs.map((t, i) => checkSigned(t, signed[i]));
    for (const c of checks) if (!c.ok) throw new Error(`${purpose}: ${c.errors.join('; ')}`);
    const res = await submitAll(rpc, purpose, checks.map((c, i) => ({ blob: signed[i], tx: c.tx })));
    console.log(`  ${purpose}: ${res.map((r) => r.code).join(', ')}`);
    const st = await networkState(rpc);
    const problems = postChecks(purpose, checks, { [params.account]: (await snapshot(rpc, params.account, st)).snap });
    if (problems.length) throw new Error(`${purpose} post-checks: ${problems.join('; ')}`);
    return checks;
  };

  step('Send & Rotate: build, sign with the offline core, check, submit, post-check');
  const next = generateKey();
  await run('send-rotate', { account: acct.address, destination: dest.address, amountXrp: '1' },
    (env) => [signTx(env.txs[0], reg).tx_blob, signTx(fillRegularKey(env.txs[1], next.address), reg).tx_blob]);

  step('Recovery: the spare multi-signs a new regular key');
  const rec = generateKey();
  await run('recovery', { account: acct.address }, (env) => [multisignTx(fillRegularKey(env.txs[0], rec.address), spare).tx_blob]);

  console.log('Testnet check passed.');
} finally {
  await client.disconnect();
}
