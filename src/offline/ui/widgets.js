// Reusable screen pieces. Everything renders through dom.h (textContent only).
import { h, replace, segments, secretInput, textInput } from './dom.js';
import { session, onWipe } from './session.js';
import { decryptVault, encryptVault, readHeader, VaultError } from '../core/vault.js';
import { describeTx, shortAddress } from '../core/describe.js';
import { repairSeed, invalidPositions, isValidSeed } from '../core/seedrepair.js';
import { keyFromSeed, wipeKey } from '../core/keys.js';
import { qrCanvas } from './qr.js';
import { MIN_PASSPHRASE_LENGTH } from '../core/config.js';

export const button = (text, onClick, cls = '') =>
  h('button', { type: 'button', class: ['btn', cls], text, on: { click: onClick } });

export const note = (text, cls = '') => h('p', { class: ['note', cls], text });
export const errorBox = (text) => h('div', { class: 'error-box', attrs: { role: 'alert' }, text });
export const warnBox = (text) => h('div', { class: 'warn-box', text });
export const okBox = (text) => h('div', { class: 'ok-box', text });

/** A progress line for scrypt (2-5 s on the signing machine). */
export function progress(label) {
  const bar = h('progress', { max: 100, value: 0 });
  const el = h('div', { class: 'progress hidden' }, h('span', { text: label }), bar);
  // scrypt reports progress about 10,000 times per run; touch the page only
  // when the whole percentage changes.
  let last = -1;
  return {
    el,
    start() { el.classList.remove('hidden'); last = 0; bar.value = 0; },
    update(p) { const v = Math.round(p * 100); if (v !== last) { last = v; bar.value = v; } },
    done() { el.classList.add('hidden'); },
  };
}

/** Pick a file and resolve with its text. */
export function filePicker(label, onText, { accept = '.json,application/json' } = {}) {
  const input = h('input', { type: 'file', accept, class: 'file' });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const text = await f.text();
    onText(text, f.name);
  });
  return h('label', { class: 'file-label' }, h('span', { text: label }), input);
}

/** Save text as a browser download (SPEC §4.2: the vault is saved this way). */
export function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename, class: 'hidden' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

const vaultErrorText = (e) => {
  if (!(e instanceof VaultError)) return String(e.message || e);
  return {
    decrypt: 'Wrong passphrase, or the vault file has been altered.',
    network: e.message,
  }[e.code] || e.message;
};

/**
 * Open a vault file into the session. onOpen() runs when it is open.
 * network: optional; when set, a vault for the other network is refused.
 */
export function vaultOpener(onOpen, { network } = {}) {
  const msg = h('div');
  const pass = secretInput({ placeholder: 'Vault passphrase' });
  const prog = progress('Unlocking (this takes a few seconds)…');
  let picked = null;
  const info = h('p', { class: 'note' });
  const openBtn = button('Unlock vault', async () => {
    if (!picked) { replace(msg, errorBox('Choose the vault file first.')); return; }
    openBtn.disabled = true;
    replace(msg);
    prog.start();
    try {
      const payload = await decryptVault(picked.text, pass.value, network || readHeader(picked.text).network, { onProgress: prog.update });
      session.vault = { network: payload.network, fileName: picked.name, fileText: picked.text, payload };
      pass.value = '';
      prog.done();
      onOpen();
    } catch (e) {
      prog.done();
      replace(msg, errorBox(vaultErrorText(e)));
    } finally {
      openBtn.disabled = false;
    }
  }, 'primary');
  const picker = filePicker('Vault file:', (text, name) => {
    try {
      const hdr = readHeader(text);
      if (network && hdr.network !== network) throw new VaultError('network', `This vault is for ${hdr.network.toUpperCase()}, but this needs a ${network.toUpperCase()} vault.`);
      picked = { text, name };
      replace(info, `${name}: ${hdr.network.toUpperCase()} vault, saved ${hdr.createdAt}`);
      replace(msg);
    } catch (e) {
      picked = null;
      replace(info);
      replace(msg, errorBox(vaultErrorText(e)));
    }
  });
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') openBtn.click(); });
  return h('div', { class: 'card' }, h('h3', { text: 'Open your vault' }), picker, info,
    h('label', { class: 'field' }, h('span', { text: 'Passphrase' }), pass), openBtn, prog.el, msg);
}

/**
 * SPEC §4.4 step 5: enter the passphrase, then sign. The passphrase is checked
 * by decrypting the open vault file again. onOk(passphrase) runs on success;
 * the caller must drop the passphrase when done.
 */
export function passphraseStep(onOk, { label = 'Sign', intro = 'Enter the vault passphrase to sign.' } = {}) {
  const pass = secretInput({ placeholder: 'Vault passphrase' });
  const prog = progress('Checking passphrase…');
  const msg = h('div');
  const btn = button(label, async () => {
    btn.disabled = true;
    replace(msg);
    prog.start();
    try {
      await decryptVault(session.vault.fileText, pass.value, session.vault.network, { onProgress: prog.update });
      const p = pass.value;
      pass.value = '';
      prog.done();
      await onOk(p, { progress: prog, msg });
    } catch (e) {
      prog.done();
      replace(msg, errorBox(vaultErrorText(e)));
    } finally {
      btn.disabled = false;
    }
  }, 'primary');
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
  return { el: h('div', { class: 'card' }, h('p', { text: intro }), h('label', { class: 'field' }, h('span', { text: 'Passphrase' }), pass), btn, prog.el, msg), button: btn };
}

/** A new passphrase, typed twice, for a new vault. onOk(pass). */
export function newPassphrase(onOk, { label = 'Create vault' } = {}) {
  const a = secretInput({ placeholder: `At least ${MIN_PASSPHRASE_LENGTH} characters` });
  const b = secretInput({ placeholder: 'Type it again' });
  const msg = h('div');
  const btn = button(label, () => {
    if (a.value !== b.value) { replace(msg, errorBox('The two passphrases do not match.')); return; }
    if ([...a.value.normalize('NFKC')].length < MIN_PASSPHRASE_LENGTH) {
      replace(msg, errorBox(`The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`));
      return;
    }
    const p = a.value;
    a.value = ''; b.value = '';
    replace(msg);
    onOk(p, msg);
  }, 'primary');
  return h('div', { class: 'card' },
    h('label', { class: 'field' }, h('span', { text: 'New passphrase' }), a),
    h('label', { class: 'field' }, h('span', { text: 'Repeat passphrase' }), b),
    note('There is no way to recover a forgotten passphrase. Your spare is the only way back in.'),
    btn, msg);
}

/** Encrypt and download a vault payload. Returns { filename, text }. */
export async function saveVault(payload, passphrase, prog) {
  prog && prog.start();
  try {
    const out = await encryptVault(payload, passphrase, { onProgress: prog && prog.update });
    download(out.filename, out.text);
    return out;
  } finally {
    prog && prog.done();
  }
}

/**
 * DECISIONS A2 gate: the user picks the vault file they just saved; it must
 * decrypt and contain every expected pending key. onPass() shows the signed
 * output. expected: [{ account, pending }] addresses.
 */
export function savedVaultGate({ filename, passphrase, network, expected, onPass }) {
  const msg = h('div');
  const prog = progress('Checking the saved vault…');
  const picker = filePicker('Saved vault file:', async (text, name) => {
    replace(msg);
    prog.start();
    try {
      const p = await decryptVault(text, passphrase(), network, { onProgress: prog.update });
      prog.done();
      const missing = expected.filter((x) => {
        const a = p.accounts.find((acc) => acc.address === x.account);
        return !(a && a.pendingKey && a.pendingKey.address === x.pending);
      });
      if (missing.length) {
        replace(msg, errorBox(`${name} does not contain the new key for ${missing.map((m) => shortAddress(m.account)).join(', ')}. Pick the file you just saved.`));
        return;
      }
      session.vault = { network, fileName: name, fileText: text, payload: p };
      replace(msg, okBox('Saved vault checked: the new key is in it.'));
      onPass();
    } catch (e) {
      prog.done();
      replace(msg, errorBox(vaultErrorText(e)));
    }
  });
  return h('div', { class: 'card gate' },
    h('h3', { text: 'Check the saved vault' }),
    h('p', {}, 'Your browser has saved ', h('strong', { text: filename }), '. Pick that file now. The signed transactions are only shown once it opens and contains the new key.'),
    note('If the download did not happen, go back and try again. Do not continue without a saved vault.'),
    picker, prog.el, msg);
}

/**
 * Type a seed; Seed Repair (A13) runs if the checksum fails.
 * onKey(key) receives the derived key (the caller owns and wipes it).
 */
export function seedEntry(onKey, { label = 'Seed', signerAddresses = [], confirmLabel = 'Use this seed', repair = true } = {}) {
  const input = secretInput({ placeholder: 's…', class: 'secret seed-input' });
  input.type = 'text';
  input.dataset.seed = '1';
  const show = h('input', { type: 'checkbox' });
  show.checked = true;
  show.addEventListener('change', () => { input.type = show.checked ? 'text' : 'password'; });
  const out = h('div');
  const use = (seed) => {
    let k;
    try { k = keyFromSeed(seed); } catch (e) { replace(out, errorBox(String(e.message || e))); return; }
    input.value = '';
    replace(out);
    onKey(k);
  };
  const btn = button(confirmLabel, () => {
    const s = input.value.trim();
    if (isValidSeed(s)) { use(s); return; }
    const bad = invalidPositions(s);
    const list = h('div', { class: 'candidates', attrs: { 'data-seed': '1' } });
    if (!repair) {
      // Checking a freshly written card: no repair, so a mistake on the
      // paper can't be "fixed" on screen while the card keeps it.
      if (bad.length) list.append(warnBox(`Characters that are never in a seed: ${bad.map((i) => `position ${i + 1} ("${s[i]}")`).join(', ')}.`));
      list.append(errorBox('That does not pass the checksum. Compare the card with the spare, fix the card if needed, and type it again exactly as written.'));
      replace(out, list);
      return;
    }
    const r = repairSeed(s, signerAddresses);
    if (bad.length) list.append(warnBox(`Characters that are never in a seed: ${bad.map((i) => `position ${i + 1} ("${s[i]}")`).join(', ')}. Seeds never contain 0, O, I or l.`));
    if (r.candidates.length === 0) {
      list.append(errorBox('The checksum failed and no single-character fix was found. Check the paper and type it again.'));
    } else {
      list.append(h('p', { text: `The checksum failed. ${r.candidates.length} single-character fix(es) pass the checksum. Pick the one whose address matches your paper or the signer list:` }));
      for (const c of r.candidates) {
        list.append(h('div', { class: ['candidate', c.inSignerList && 'match'] },
          h('div', { class: 'mono', text: c.address }),
          h('div', { class: 'note', text: `${c.edit}${c.inSignerList ? ' — IN THE SIGNER LIST' : ''}` }),
          button('Use this one', () => use(c.seed))));
      }
    }
    replace(out, list);
  }, 'primary');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
  onWipe(() => { input.value = ''; });
  return h('div', { class: 'seed-entry' },
    h('label', { class: 'field' }, h('span', { text: label }), input),
    h('label', { class: 'check' }, show, ' show what I type'),
    btn, out);
}

const caseWord = (c) => (/[0-9]/.test(c) ? 'digit' : c === c.toUpperCase() ? 'UPPER' : 'lower');

/**
 * SPEC §4.7 Spare Key Card display: seed in blocks of 4, each character's
 * case spelled out. onWritten() when the user has copied it.
 */
export function spareCardDisplay(key, { label, onWritten }) {
  const groups = [];
  for (let i = 0; i < key.seed.length; i += 4) groups.push(key.seed.slice(i, i + 4));
  const grid = h('div', { class: 'seed-grid' },
    groups.map((g, gi) => h('div', { class: 'seed-block' },
      h('div', { class: 'block-no', text: String(gi + 1) }),
      [...g].map((c) => h('div', { class: 'seed-cell' }, h('div', { class: 'seed-char', text: c }), h('div', { class: 'seed-case', text: caseWord(c) }))))));
  const el = h('div', { class: 'card spare-card', attrs: { 'data-seed': '1' } },
    h('h3', { text: `Spare key for ${label}` }),
    h('p', { text: 'Copy this onto the blank Spare Key Card, one box per character. Mark upper or lower case under each box.' }),
    grid,
    h('p', {}, 'Spare address (write it on the card): ', h('strong', { class: 'mono', text: key.address })),
    note(`${key.seed.length} characters, ${key.algorithm}.`),
    button('I have written it down', onWritten, 'primary'));
  return el;
}

/**
 * Acknowledgements (SPEC §4.8), one list per transaction, so the same warning
 * on two transactions needs two answers (Gemini Phase 2 review).
 * Returns { el, ok(), givenFor(i) } where givenFor(i) is the Map for
 * transaction i, keyed like checkTransaction's acks.
 */
export function ackPanel(perTx) {
  const lists = perTx.map((acks, i) => acks.map((a) => ({ ...a, tx: i })));
  const all = lists.flat();
  const given = perTx.map(() => new Map());
  const givenFor = (i) => given[i] || new Map();
  if (!all.length) return { el: h('div'), ok: () => true, givenFor };
  const prefix = (a) => (perTx.length > 1 ? `Transaction ${a.tx + 1}: ` : '');
  const rows = all.map((a) => {
    if (a.phrase) {
      const inp = textInput({ placeholder: a.phrase });
      inp.addEventListener('input', () => given[a.tx].set(a.key, inp.value));
      return h('div', { class: 'ack' }, h('p', { class: 'warn', text: `${prefix(a)}${a.message}` }), h('label', { class: 'field' }, h('span', { text: `Type ${a.phrase} to continue` }), inp));
    }
    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => given[a.tx].set(a.key, cb.checked));
    return h('label', { class: 'ack check' }, cb, h('span', { class: 'warn', text: ` I understand: ${prefix(a)}${a.message}` }));
  });
  const el = h('div', { class: 'card acks' }, h('h3', { text: 'Check these before signing' }), rows);
  const ok = () => all.every((a) => (a.phrase ? given[a.tx].get(a.key) === a.phrase : given[a.tx].get(a.key) === true));
  return { el, ok, givenFor };
}

/**
 * SPEC §4.4 step 3: a destination not in the address book needs an extra
 * confirmation, and may be added. Returns null when not needed, else
 * { el, entry() } where entry() throws if unconfirmed and returns the new
 * address-book entry or null.
 */
export function firstTimeDestination(tx, isFirstTime) {
  if (!isFirstTime) return null;
  const cb = h('input', { type: 'checkbox' });
  const add = h('input', { type: 'checkbox' });
  const label = textInput({ placeholder: 'Label, e.g. Exchange deposit' });
  const ex = h('input', { type: 'checkbox' });
  const tag = h('input', { type: 'checkbox' });
  const el = h('div', { class: 'card first-time' },
    h('h3', { text: 'New destination' }),
    h('p', {}, 'You have not sent to ', h('strong', { class: 'mono', text: tx.Destination }), ' from this account before.'),
    h('label', { class: 'check' }, cb, ' I have checked this address character by character against a trusted source.'),
    h('label', { class: 'check' }, add, ' Add it to the address book'),
    h('div', { class: 'row' }, label, h('label', { class: 'check' }, ex, ' exchange'), h('label', { class: 'check' }, tag, ' needs a destination tag')));
  const entry = () => {
    if (!cb.checked) throw new Error('Confirm the new destination first.');
    if (!add.checked) return null;
    const e = { label: label.value.trim(), address: tx.Destination, isExchange: ex.checked, requiresTag: tag.checked };
    if (!e.label) throw new Error('Give the new destination a label, or untick "Add it to the address book".');
    if ((e.isExchange || e.requiresTag) && tx.DestinationTag === undefined) {
      throw new Error('This destination needs a destination tag, but the transaction has none. Nothing was signed; build a new envelope with the tag.');
    }
    return e;
  };
  return { el, entry };
}

/** Payload with `entry` added to `address`'s address book. */
export function withBookEntry(payload, address, entry) {
  if (!entry) return payload;
  return { ...payload, accounts: payload.accounts.map((a) => (a.address === address ? { ...a, addressBook: [...a.addressBook, entry] } : a)) };
}

/** Summary card and every raw field for one transaction (SPEC §4.4 step 3). */
export function txCard(tx, { index, total, errors = [], ctx = {}, template = false, note: extra } = {}) {
  const d = describeTx(tx, ctx);
  return h('div', { class: 'card tx-card' },
    h('div', { class: 'tx-head' },
      total > 1 ? h('span', { class: 'tx-no', text: `${index + 1} of ${total}` }) : null,
      h('span', { class: 'tx-title', text: d.title })),
    h('p', { class: 'summary' }, segments(d.summary)),
    template ? note('The new key is generated on this machine and filled in before signing.') : null,
    extra ? note(extra) : null,
    errors.length ? h('div', {}, errors.map((e) => errorBox(e.message))) : null,
    h('details', { class: 'raw' }, h('summary', { text: 'Every field' }),
      h('table', { class: 'fields' }, d.fields.map((f) =>
        h('tr', { class: f.known ? '' : 'unknown' }, h('th', { text: f.label }), h('td', { class: 'mono', text: f.value }))))));
}

/** Signed output (SPEC §4.4 step 6): numbered QR codes with hash and summary. */
export function signedOutput(items, ctx = {}) {
  return h('div', { class: 'signed' }, items.map((it, i) => {
    const d = describeTx(it.tx, ctx);
    return h('div', { class: 'card signed-item' },
      h('h3', { text: items.length > 1 ? `Signed transaction ${i + 1} of ${items.length}` : 'Signed transaction' }),
      h('p', { class: 'summary' }, segments(d.summary)),
      qrCanvas(it.tx_blob, { label: `signed transaction ${i + 1}` }),
      h('p', {}, 'Hash: ', h('span', { class: 'mono hash', text: it.hash })),
      h('details', {}, h('summary', { text: 'Signed blob (hex)' }), h('p', { class: 'mono blob', text: it.tx_blob })));
  }));
}

/** New key address in large type: first and last 6 characters (SPEC §4.5 step 5). */
export function bigAddress(addr, caption) {
  return h('div', { class: 'card big-address' },
    h('p', { text: caption }),
    h('p', { class: 'big' }, h('strong', { text: addr.slice(0, 6) }), ' … ', h('strong', { text: addr.slice(-6) })),
    h('p', { class: 'mono', text: addr }));
}

export function wipeKeys(...keys) {
  for (const k of keys.flat()) if (k) wipeKey(k);
}
