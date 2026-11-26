// Connection to the XRP Ledger (SPEC §5.2, DECISIONS A21): the fixed server
// list for the chosen network, tried in order until one connects.
// Only the latest connect() wins: an older attempt that finishes later is
// closed and discarded, so a slow TESTNET connect can never replace a
// MAINNET one the user switched to (Phase 3 review).
import { Client } from 'xrpl';
import { SERVERS } from '../core/config.js';

// A test build replaces the list with a local fake ledger (scripts/build.mjs).
const LIST = __TEST_SERVERS__ || SERVERS;

let client = null;
let current = null;
let seq = 0;

export class Superseded extends Error {}

/**
 * @param makeClient for unit tests: (url) => { connect(), disconnect(), request() }
 */
export async function connect(network, onStatus = () => {}, { makeClient = (url) => new Client(url, { connectionTimeout: 8000 }), list = LIST } = {}) {
  const id = ++seq;
  await disconnect();
  for (const url of list[network]) {
    if (id !== seq) throw new Superseded();
    onStatus(`Connecting to ${url}…`);
    const c = makeClient(url);
    try {
      await c.connect();
    } catch {
      try { await c.disconnect(); } catch { /* ignore */ }
      continue;
    }
    if (id !== seq) {
      try { await c.disconnect(); } catch { /* ignore */ }
      throw new Superseded();
    }
    client = c;
    current = { network, url };
    onStatus(`Connected to ${url}`);
    return current;
  }
  if (id !== seq) throw new Superseded();
  throw new Error(`Could not reach any ${network} server. Check the internet connection and try again.`);
}

export async function disconnect() {
  const c = client;
  client = null;
  current = null;
  if (c) { try { await c.disconnect(); } catch { /* ignore */ } }
}

export const connection = () => current;

/** Throws unless connected to `network` (checked before every build and submit). */
export function requireNetwork(network) {
  if (!current) throw new Error('Not connected to a server yet.');
  if (current.network !== network) throw new Error(`Connected to ${current.network.toUpperCase()}, but ${network.toUpperCase()} is selected. Wait for the connection to switch.`);
}

/** One rippled command -> its result. Errors carry `code` (e.g. actNotFound). */
export async function rpc(req) {
  if (!client) throw new Error('not connected');
  try {
    return (await client.request(req)).result;
  } catch (e) {
    const err = new Error((e.data && (e.data.error_message || e.data.error)) || e.message);
    err.code = e.data && e.data.error;
    throw err;
  }
}
