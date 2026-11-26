// Connection to the XRP Ledger (SPEC §5.2, DECISIONS A21): the fixed server
// list for the chosen network, tried in order until one connects.
import { Client } from 'xrpl';
import { SERVERS } from '../core/config.js';

// A test build replaces the list with a local fake ledger (scripts/build.mjs).
const LIST = __TEST_SERVERS__ || SERVERS;

let client = null;
let current = null;

export async function connect(network, onStatus = () => {}) {
  await disconnect();
  for (const url of LIST[network]) {
    onStatus(`Connecting to ${url}…`);
    const c = new Client(url, { connectionTimeout: 8000 });
    try {
      await c.connect();
      client = c;
      current = { network, url };
      onStatus(`Connected to ${url}`);
      return current;
    } catch {
      try { await c.disconnect(); } catch { /* ignore */ }
    }
  }
  throw new Error(`Could not reach any ${network} server. Check the internet connection and try again.`);
}

export async function disconnect() {
  const c = client;
  client = null;
  current = null;
  if (c) { try { await c.disconnect(); } catch { /* ignore */ } }
}

export const connection = () => current;

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
