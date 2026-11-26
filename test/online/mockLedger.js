// A small fake XRP Ledger for tests: no network. It answers the rippled
// commands the Online Builder uses and applies submitted transactions well
// enough to run the post-checks. Test keys only.
import { decode } from 'ripple-binary-codec';
import { WebSocketServer } from 'ws';
import { hashSignedBlob, verifySignedBlob } from '../../src/offline/core/keys.js';

export const RESERVE_BASE = 1_000_000n;
export const RESERVE_INC = 200_000n;

export class MockLedger {
  constructor({ ledgerIndex = 5000, openLedgerFee = '12' } = {}) {
    this.ledgerIndex = ledgerIndex;
    this.openLedgerFee = openLedgerFee;
    this.accounts = new Map();
    this.objects = new Map();
    this.txs = new Map();
    this.results = []; // queue of forced TransactionResult codes
    this.submitted = [];
  }

  addAccount(address, { balance = '50000000', sequence = 10, regularKey = null, spare = null, flags = 0x00100000, objects = [] } = {}) {
    this.accounts.set(address, {
      Account: address, Balance: balance, Sequence: sequence, Flags: flags,
      OwnerCount: (spare ? 1 : 0) + objects.length, ...(regularKey ? { RegularKey: regularKey } : {}),
      signerList: spare ? { SignerQuorum: 1, SignerEntries: [{ SignerEntry: { Account: spare, SignerWeight: 1 } }] } : null,
    });
    this.objects.set(address, objects);
    return this;
  }

  err(code, message) { const e = new Error(message || code); e.code = code; e.data = { error: code }; return e; }

  async rpc(req) {
    switch (req.command) {
      case 'server_state':
        return { state: { validated_ledger: { seq: this.ledgerIndex, close_time: 838000000, reserve_base: Number(RESERVE_BASE), reserve_inc: Number(RESERVE_INC), base_fee: 10 } } };
      case 'fee':
        return { drops: { open_ledger_fee: this.openLedgerFee, base_fee: '10' } };
      case 'account_info': {
        const a = this.accounts.get(req.account);
        if (!a) throw this.err('actNotFound', 'Account not found.');
        const { signerList, ...data } = a;
        return { account_data: { ...data }, signer_lists: signerList ? [signerList] : [] };
      }
      case 'account_objects': {
        if (!this.accounts.has(req.account)) throw this.err('actNotFound');
        const a = this.accounts.get(req.account);
        const list = [...(this.objects.get(req.account) || [])];
        if (a.signerList) list.push({ LedgerEntryType: 'SignerList', ...a.signerList });
        return { account_objects: list };
      }
      case 'submit': return this.submit(req.tx_blob);
      case 'tx': {
        const t = this.txs.get(req.transaction);
        // Time passes while a client waits: close some ledgers.
        if (!t) { this.ledgerIndex += 500; throw this.err('txnNotFound'); }
        return t;
      }
      default: throw this.err('unknownCmd', req.command);
    }
  }

  submit(blob) {
    const v = verifySignedBlob(blob);
    const tx = decode(blob);
    const hash = hashSignedBlob(blob);
    this.submitted.push(tx);
    const a = this.accounts.get(tx.Account);
    if (!v.valid) return { engine_result: 'temBAD_SIGNATURE' };
    if (!a) return { engine_result: 'terNO_ACCOUNT' };
    if (tx.Sequence !== a.Sequence) return { engine_result: tx.Sequence < a.Sequence ? 'tefPAST_SEQ' : 'terPRE_SEQ' };
    // Authorisation: single-signed by the regular key; multi-signed by the spare.
    const signer = v.signers[0];
    const authorised = tx.Signers
      ? !!(a.signerList && a.signerList.SignerEntries.some((e) => e.SignerEntry.Account === signer))
      : signer === a.RegularKey;
    if (!authorised) return { engine_result: 'tefBAD_AUTH' };
    const forced = this.results.shift();
    const code = forced || 'tesSUCCESS';
    a.Sequence += 1;
    a.Balance = String(BigInt(a.Balance) - BigInt(tx.Fee));
    if (code === 'tesSUCCESS') this.apply(tx, a);
    this.ledgerIndex += 1;
    this.txs.set(hash, { hash, validated: true, ledger_index: this.ledgerIndex, meta: { TransactionResult: code }, ...tx });
    return { engine_result: 'tesSUCCESS', tx_json: { hash } };
  }

  apply(tx, a) {
    switch (tx.TransactionType) {
      case 'SetRegularKey': if (tx.RegularKey) a.RegularKey = tx.RegularKey; else delete a.RegularKey; break;
      case 'SignerListSet':
        a.signerList = tx.SignerQuorum ? { SignerQuorum: tx.SignerQuorum, SignerEntries: tx.SignerEntries } : null;
        a.OwnerCount = (a.signerList ? 1 : 0) + (this.objects.get(tx.Account) || []).length;
        break;
      case 'Payment': {
        a.Balance = String(BigInt(a.Balance) - BigInt(tx.Amount));
        const d = this.accounts.get(tx.Destination);
        if (d) d.Balance = String(BigInt(d.Balance) + BigInt(tx.Amount));
        break;
      }
      case 'AccountDelete': {
        const d = this.accounts.get(tx.Destination);
        if (d) d.Balance = String(BigInt(d.Balance) + BigInt(a.Balance));
        this.accounts.delete(tx.Account);
        break;
      }
      default:
    }
  }

  /** Serve this ledger over WebSocket (rippled JSON protocol) on 127.0.0.1. */
  async listen() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => this.wss.on('listening', r));
    this.wss.on('connection', (ws) => {
      ws.on('message', async (raw) => {
        const req = JSON.parse(String(raw));
        try {
          const result = await this.rpc(req);
          ws.send(JSON.stringify({ id: req.id, type: 'response', status: 'success', api_version: 2, result }));
        } catch (e) {
          ws.send(JSON.stringify({ id: req.id, type: 'response', status: 'error', error: e.code || 'unknown', error_message: e.message, request: req }));
        }
      });
    });
    return `ws://127.0.0.1:${this.wss.address().port}`;
  }

  close() { return new Promise((r) => (this.wss ? this.wss.close(r) : r())); }
}
