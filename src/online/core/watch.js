// DECISIONS A23: watch-only list (labels and public addresses, per network)
// and the secret guard for every input on the online side.
import { isValidAddress } from '../../offline/core/keys.js';
import { isValidSeed } from '../../offline/core/seedrepair.js';

const KEY = (network) => `icecold-watch-v1-${network}`;

export function loadWatch(storage, network) {
  try {
    const list = JSON.parse(storage.getItem(KEY(network)) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.label === 'string' && isValidAddress(x.address)) : [];
  } catch { return []; }
}

export function saveWatch(storage, network, list) {
  storage.setItem(KEY(network), JSON.stringify(list.map(({ label, address }) => ({ label, address }))));
}

export function addWatch(storage, network, label, address) {
  const l = String(label).trim();
  const a = String(address).trim();
  if (!l) throw new Error('give the account a label');
  if (!isValidAddress(a)) throw new Error('that is not a valid XRPL address');
  const list = loadWatch(storage, network);
  if (list.some((x) => x.address === a)) throw new Error('that address is already on the list');
  list.push({ label: l, address: a });
  saveWatch(storage, network, list);
  return list;
}

export function removeWatch(storage, network, address) {
  const list = loadWatch(storage, network).filter((x) => x.address !== address);
  saveWatch(storage, network, list);
  return list;
}

export function clearWatch(storage, network) { storage.removeItem(KEY(network)); }

/** True if any word in the text is a valid seed (SPEC §5.2: never accept a secret). */
export function containsSeed(text) {
  // Split on anything that is not a base58 character, so a seed inside
  // quotes, JSON or punctuation is still found.
  return String(text).split(/[^1-9A-HJ-NP-Za-km-z]+/).some((w) => w.length >= 25 && w.length <= 40 && isValidSeed(w));
}
