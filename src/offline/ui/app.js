// The offline signer's screens (SPEC §4). One screen at a time in #screen.
import { h, replace } from './dom.js';
import { session, lock, onLock, onWipe, startIdleLock, wipeStale, markRender } from './session.js';
import { button, note, errorBox, okBox, warnBox, vaultOpener, newPassphrase, saveVault, progress, passphraseStep } from './widgets.js';
import { scanner } from './qr.js';
import { Assembler, MultipartError } from '../core/multipart.js';
import { emptyPayload } from '../core/vault.js';
import { isValidAddress } from '../core/keys.js';
import { shortAddress } from '../core/describe.js';
import { NETWORKS } from '../core/config.js';
import { signFlow } from './flows/sign.js';
import { rotateFlow } from './flows/rotate.js';
import { recoveryFlow } from './flows/recovery.js';
import { estateFlow } from './flows/estate.js';
import { replaceSpareFlow } from './flows/replace.js';
import { migrationFlow } from './flows/migration.js';
import { generateKeypairTool, decodeVerifyTool, seedRepairTool } from './tools.js';

let screenEl;
let networkEl;
let signingOk = false;
// The network a flow is working on, from its envelope; cleared at Home.
let flowNetwork = null;
let onHome = false;

/** Header banner: red MAINNET or blue TESTNET (SPEC §4.4 step 4). */
export function setNetwork(network) {
  flowNetwork = network || null;
  paintNetwork(network);
}

function paintNetwork(network) {
  networkEl.className = `network-banner ${network || 'none'}`;
  networkEl.textContent = network === 'mainnet' ? 'MAINNET' : network === 'testnet' ? 'TESTNET' : 'No network selected';
}

/** Show a screen. Every screen change wipes secrets left by the last one. */
export function show(title, ...content) {
  onHome = title === 'Home';
  wipeStale();
  paintNetwork(flowNetwork || (session.vault ? session.vault.network : null));
  render(title, content);
}

/**
 * Next step inside the same flow: keeps the flow's secrets (and network
 * banner); Home or Lock still wipe everything.
 */
export function showStep(title, ...content) {
  onHome = false;
  render(title, content);
}

function render(title, content) {
  replace(screenEl,
    h('div', { class: 'screen-head' },
      h('h2', { text: title }),
      title !== 'Home' ? button('Home', () => home(), 'secondary') : null,
      session.vault ? button('Lock vault', () => { lock('manual'); }, 'secondary') : null),
    ...content);
  markRender();
  window.scrollTo(0, 0);
}

export function home(message) {
  flowNetwork = null;
  const v = session.vault;
  show('Home',
    message ? okBox(message) : null,
    signingOk ? null : errorBox('Signing is disabled because the startup checks failed. Do not use this file.'),
    h('div', { class: 'card' },
      v
        ? h('p', {}, 'Vault open: ', h('strong', { text: v.fileName }), ` (${v.network.toUpperCase()}, ${v.payload.accounts.length} account(s))`)
        : h('p', { text: 'No vault open.' }),
      h('div', { class: 'buttons' },
        signingOk ? button('Scan an envelope', scanEnvelope, 'primary big') : null,
        v ? button('Vault: accounts and address book', vaultScreen) : button('Open vault', openVaultScreen),
        v ? null : button('New vault', newVaultScreen))),
    h('div', { class: 'card' },
      h('h3', { text: 'Tools' }),
      h('div', { class: 'buttons' },
        button('Generate keypair', generateKeypairTool),
        button('Decode / verify a signed transaction', decodeVerifyTool),
        button('Seed repair', seedRepairTool))),
    note('Every action starts from an envelope made by the Online Builder: Send, Send & Rotate, Rotate, AccountSet, Recovery, Replace Spare, Migration and Estate Transfer.'));
}

function openVaultScreen() {
  show('Open vault', vaultOpener(() => home('Vault unlocked.')));
}

function newVaultScreen() {
  let network = null;
  const pick = h('div', { class: 'buttons' });
  const body = h('div');
  const choose = (n) => {
    network = n;
    setNetwork(n);
    replace(body,
      h('p', {}, 'New ', h('strong', { text: n.toUpperCase() }), ' vault. Accounts are added by Migration or Recovery.'),
      newPassphrase(async (pass, msg) => {
        const prog = progress('Encrypting (this takes a few seconds)…');
        msg.append(prog.el);
        try {
          const payload = emptyPayload(network);
          const out = await saveVault(payload, pass, prog);
          session.vault = { network, fileName: out.filename, fileText: out.text, payload };
          home(`New ${network} vault saved as ${out.filename}.`);
        } catch (e) {
          replace(msg, errorBox(String(e.message || e)));
        }
      }));
  };
  for (const n of NETWORKS) pick.append(button(n.toUpperCase(), () => choose(n), `net-${n}`));
  show('New vault', h('div', { class: 'card' }, h('p', { text: 'Which network is this vault for? Each network has its own vault.' }), pick), body);
}

/** Vault contents: labels and the per-account address book (SPEC §4.2). */
function vaultScreen() {
  const v = session.vault;
  if (!v) return openVaultScreen();
  const draft = structuredClone(v.payload);
  onWipe(() => {
    for (const a of draft.accounts) for (const k of [a.regularKey, a.pendingKey]) if (k) k.seed = '';
  });
  const msg = h('div');
  let dirty = false;
  const markDirty = () => { dirty = true; replace(msg, warnBox('Changes are not saved yet. Save a new vault file below.')); };
  const accounts = draft.accounts.map((a) => {
    const label = h('input', { type: 'text', value: a.label });
    label.addEventListener('input', () => { a.label = label.value.trim(); markDirty(); });
    const book = h('table', { class: 'fields' });
    const renderBook = () => replace(book,
      h('tr', {}, h('th', { text: 'Label' }), h('th', { text: 'Address' }), h('th', { text: 'Exchange' }), h('th', { text: 'Needs tag' }), h('th')),
      a.addressBook.map((b, i) => h('tr', {},
        h('td', { text: b.label }), h('td', { class: 'mono', text: b.address }),
        h('td', { text: b.isExchange ? 'yes' : 'no' }), h('td', { text: b.requiresTag ? 'yes' : 'no' }),
        h('td', {}, button('Remove', () => { a.addressBook.splice(i, 1); renderBook(); markDirty(); }, 'small')))));
    renderBook();
    const nl = h('input', { type: 'text', placeholder: 'Label' });
    const na = h('input', { type: 'text', placeholder: 'r…', class: 'mono' });
    const ne = h('input', { type: 'checkbox' });
    const nt = h('input', { type: 'checkbox' });
    const addMsg = h('div');
    const add = button('Add destination', () => {
      const addr = na.value.trim();
      if (!nl.value.trim() || !isValidAddress(addr)) { replace(addMsg, errorBox('Enter a label and a valid address.')); return; }
      if (a.addressBook.some((b) => b.address === addr)) { replace(addMsg, errorBox('That address is already in the address book.')); return; }
      a.addressBook.push({ label: nl.value.trim(), address: addr, isExchange: ne.checked, requiresTag: nt.checked });
      nl.value = ''; na.value = ''; ne.checked = false; nt.checked = false;
      replace(addMsg);
      renderBook();
      markDirty();
    });
    return h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', { text: 'Label' }), label),
      h('p', {}, 'Address: ', h('span', { class: 'mono', text: a.address })),
      h('p', {}, 'Current key: ', h('span', { class: 'mono', text: a.regularKey ? a.regularKey.address : 'none' })),
      a.pendingKey ? h('p', {}, 'Pending key: ', h('span', { class: 'mono', text: a.pendingKey.address })) : null,
      a.retiredKeys.length ? note(`Retired keys: ${a.retiredKeys.map(shortAddress).join(', ')}`) : null,
      h('h4', { text: 'Address book' }), book,
      h('div', { class: 'row' }, nl, na, h('label', { class: 'check' }, ne, ' exchange'), h('label', { class: 'check' }, nt, ' needs tag'), add),
      addMsg);
  });
  const savePanel = h('div');
  const saveBtn = button('Save a new vault file', () => {
    if (!dirty) { replace(msg, note('Nothing has changed.')); return; }
    if (draft.accounts.some((a) => !a.label)) { replace(msg, errorBox('Every account needs a label.')); return; }
    replace(savePanel, savePrompt(draft, 'Vault saved with your changes.'));
  }, 'primary');
  show('Vault', h('p', {}, h('strong', { text: v.fileName }), ` — ${v.network.toUpperCase()}`),
    draft.accounts.length ? accounts : note('This vault has no accounts yet. Migration or Recovery adds them.'),
    saveBtn, msg, savePanel);
}

/** Ask for the passphrase, then save `payload` as a new vault file and keep it open. */
export function savePrompt(payload, doneMessage) {
  const step = passphraseStep(async (pass, { progress: prog, msg }) => {
    try {
      const out = await saveVault(payload, pass, prog);
      session.vault = { network: payload.network, fileName: out.filename, fileText: out.text, payload };
      home(`${doneMessage} New file: ${out.filename}. Keep it; older files still open but lack the change.`);
    } catch (e) {
      replace(msg, errorBox(String(e.message || e)));
    }
  }, { label: 'Save vault', intro: 'Enter the vault passphrase to save the new file.' });
  return step.el;
}

/** Scan an envelope (one or more QR parts, A16), then go to its flow. */
function scanEnvelope() {
  const asm = new Assembler();
  const progressText = h('p', { class: 'parts', text: 'Waiting for the first QR code…' });
  const msg = h('div');
  const sc = scanner((text) => {
    try {
      const r = asm.add(text);
      if (r.status === 'need') {
        replace(progressText, `Scanned ${r.have} of ${r.total}. Still needed: part ${r.missing.join(', ')}.`);
        replace(msg);
        return false;
      }
      let env;
      try { env = JSON.parse(r.text); } catch { throw new MultipartError('format', 'the envelope is not valid JSON'); }
      routeEnvelope(env);
      return true;
    } catch (e) {
      if (e instanceof MultipartError && e.code !== 'format') asm.reset();
      replace(msg, errorBox(e.message));
      return false;
    }
  }, { hint: 'Hold each envelope QR code up to the webcam. Parts can be scanned in any order.' });
  show('Scan an envelope', h('div', { class: 'card' }, sc.el, progressText, msg));
}

const FLOWS = {
  sign: signFlow,
  'send-rotate': rotateFlow,
  rotate: rotateFlow,
  recovery: recoveryFlow,
  estate: estateFlow,
  'replace-spare': replaceSpareFlow,
  migration: migrationFlow,
};
// Purposes that sign with a key from the vault, so need it open first.
const NEEDS_VAULT = new Set(['sign', 'send-rotate', 'rotate', 'replace-spare']);

export function routeEnvelope(env) {
  if (!signingOk) { home(); return; }
  const flow = env && FLOWS[env.purpose];
  if (!flow) {
    show('Envelope', errorBox(`Unknown envelope purpose ${JSON.stringify(env && env.purpose)}. Nothing was signed.`));
    return;
  }
  if (NEEDS_VAULT.has(env.purpose) && (!session.vault || session.vault.network !== env.network)) {
    show('Open vault',
      session.vault ? errorBox(`This envelope is for ${String(env.network).toUpperCase()} but the open vault is ${session.vault.network.toUpperCase()}. Lock it and open the right vault.`) : null,
      note(`This ${env.purpose} envelope needs your ${String(env.network).toUpperCase()} vault.`),
      session.vault ? null : vaultOpener(() => flow(env), { network: NETWORKS.includes(env.network) ? env.network : undefined }));
    setNetwork(env.network);
    return;
  }
  flow(env);
}

/** Start the app once the startup checks have run. */
export function startApp({ allOk, idleWarn }) {
  signingOk = allOk;
  screenEl = document.getElementById('screen');
  networkEl = document.getElementById('network-banner');
  onLock((reason, hadVault) => home(reason === 'idle'
    ? 'Locked after 5 minutes idle. Secrets were wiped.'
    : hadVault ? 'Vault locked. Secrets were wiped.' : 'Done. Secrets were wiped.'));
  startIdleLock(idleWarn, undefined, () => !!session.vault || !onHome);
  home();
}
