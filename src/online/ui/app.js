// Online Builder screens (SPEC §5). Never sees a secret: the secret guard
// clears any typed or pasted seed (A23).
import { h, replace, textInput } from '../../offline/ui/dom.js';
import { qrCanvas, scanner } from '../../offline/ui/qr.js';
import { button, note, errorBox, okBox, warnBox, txCard } from '../../offline/ui/widgets.js';
import { ACCOUNT_SET_FLAGS, dropsToXrp, describeTx } from '../../offline/core/describe.js';
import { frameEnvelope } from '../../offline/core/multipart.js';
import { NETWORKS } from '../../offline/core/config.js';
import { connect, connection, rpc } from './net.js';
import { build } from '../core/builders.js';
import { networkState, snapshot } from '../core/ledger.js';
import { checkSigned, postChecks } from '../core/verify.js';
import { submitAll } from '../core/submit.js';
import { loadWatch, addWatch, removeWatch, clearWatch, containsSeed } from '../core/watch.js';
import { estateLetter, SPARE_CARD_GROUPS } from '../core/letter.js';

const state = {
  network: 'testnet',
  built: null, // { purpose, env, notes, shared }
  signed: [], // check results, in envelope order
};

let screenEl;
let listCount = 0;
let netEl;
let statusEl;
const store = () => window.localStorage;

// ---------- frame ----------

function paintNetwork() {
  netEl.className = `network-banner ${state.network}`;
  netEl.textContent = state.network === 'mainnet' ? 'MAINNET' : 'TESTNET';
}

function show(title, ...content) {
  replace(screenEl, h('div', { class: 'screen-head' }, h('h2', { text: title }),
    title !== 'Home' ? button('Home', home, 'secondary') : null), ...content);
  window.scrollTo(0, 0);
}

async function switchNetwork(n) {
  state.network = n;
  state.built = null;
  state.signed = [];
  paintNetwork();
  home();
  try {
    await connect(n, (s) => { statusEl.textContent = s; });
  } catch (e) {
    statusEl.textContent = String(e.message || e);
  }
}

const watched = () => loadWatch(store(), state.network);
const labelOf = (a) => watched().find((w) => w.address === a)?.label;
const describeCtx = () => ({ accounts: watched(), addressBook: watched() });

/** Address input with the watch list as suggestions. */
function addressInput(placeholder) {
  const listId = `watch-list-${++listCount}`;
  const input = textInput({ placeholder, class: 'mono' });
  input.setAttribute('list', listId);
  const dl = h('datalist', { id: listId }, watched().map((w) => h('option', { value: w.address, label: w.label })));
  return { input, el: h('span', {}, input, dl) };
}

// ---------- home ----------

export function home() {
  const conn = connection();
  show('Home',
    h('div', { class: 'card' },
      h('p', {}, conn ? `Connected to ${conn.url}.` : 'Not connected.', ' Watched accounts on this network: ', h('strong', { text: String(watched().length) })),
      h('div', { class: 'buttons' },
        button('Build an envelope', buildMenu, 'primary big'),
        button('Submit signed transactions', submitScreen, state.built ? 'primary big' : 'big'),
        button('Watched accounts', watchScreen),
        button('Print', printMenu))),
    note('This page never sees a secret. Seeds are typed only into the Offline Signer on the laptop with Wi-Fi off.'));
}

// ---------- watch list (A23) ----------

function watchScreen() {
  const list = h('table', { class: 'fields' });
  const msg = h('div');
  const render = () => replace(list,
    h('tr', {}, h('th', { text: 'Label' }), h('th', { text: 'Address' }), h('th')),
    watched().map((w) => h('tr', {}, h('td', { text: w.label }), h('td', { class: 'mono', text: w.address }),
      h('td', {}, button('Remove', () => { removeWatch(store(), state.network, w.address); render(); }, 'small')))));
  render();
  const label = textInput({ placeholder: 'Label, e.g. Personal' });
  const addr = textInput({ placeholder: 'r…', class: 'mono' });
  show(`Watched accounts (${state.network.toUpperCase()})`,
    note('Only labels and public addresses are kept, in this browser, separately for each network.'),
    list,
    h('div', { class: 'card row' }, label, addr, button('Add', () => {
      try { addWatch(store(), state.network, label.value, addr.value); label.value = ''; addr.value = ''; replace(msg); render(); } catch (e) { replace(msg, errorBox(e.message)); }
    }, 'primary')),
    msg,
    button(`Clear the ${state.network} list`, () => {
      if (window.confirm(`Remove every watched ${state.network} account from this browser?`)) { clearWatch(store(), state.network); render(); }
    }, 'secondary'));
}

// ---------- build ----------

function buildMenu() {
  const flows = [
    ['Send & Rotate', () => sendForm('send-rotate'), 'Send XRP and change the regular key in one step (recommended for every send).'],
    ['Send', () => sendForm('sign'), 'Send XRP without changing the key.'],
    ['Rotate key', () => accountForm('rotate', 'Rotate key'), 'Change the regular key without sending.'],
    ['Account settings', accountSetForm, 'AccountSet: turn a setting on or off.'],
    ['Replace spare', () => accountForm('replace-spare', 'Replace spare'), 'Make a new spare and put it in the signer list.'],
    ['Recovery', () => accountForm('recovery', 'Recovery'), 'The vault or key is lost: use the spare to set a new regular key.'],
    ['Estate Transfer', estateForm, 'Move everything above the reserve to a destination, signed with the spare.'],
    ['Migration', migrationForm, 'One-time: give each kept account its own key and spare, close small accounts.'],
  ];
  show('Build an envelope', ...flows.map(([t, fn, d]) => h('div', { class: 'card' }, button(t, fn, 'primary'), note(d))));
}

async function runBuild(purpose, params, msg, btn) {
  replace(msg, note('Reading the ledger…'));
  btn.disabled = true;
  try {
    if (!connection()) throw new Error('Not connected to a server.');
    const r = await build(rpc, state.network, purpose, params);
    state.built = { purpose, env: r.env, notes: r.notes || [], acks: r.acks || [], shared: r.shared };
    state.signed = [];
    envelopeScreen();
  } catch (e) {
    replace(msg, errorBox(String(e.message || e)));
  } finally {
    btn.disabled = false;
  }
}

function formScreen(title, fields, purpose, toParams, intro) {
  const msg = h('div');
  const btn = button('Build envelope', () => {
    let p;
    try { p = toParams(); } catch (e) { replace(msg, errorBox(e.message)); return; }
    runBuild(purpose, p, msg, btn);
  }, 'primary');
  show(title, intro ? note(intro) : null, h('div', { class: 'card' }, ...fields.map(([l, el]) => h('label', { class: 'field' }, h('span', { text: l }), el)), btn), msg);
}

function sendForm(purpose) {
  const acct = addressInput('From account (r…)');
  const dest = addressInput('Destination (r…)');
  const amount = textInput({ placeholder: 'e.g. 25.5' });
  const tag = textInput({ placeholder: 'Number, if the destination needs one' });
  formScreen(purpose === 'send-rotate' ? 'Send & Rotate' : 'Send', [
    ['From', acct.el], ['To', dest.el], ['Amount (XRP)', amount], ['Destination tag', tag],
  ], purpose, () => ({ account: acct.input.value.trim(), destination: dest.input.value.trim(), amountXrp: amount.value, destinationTag: tag.value.trim() || undefined }),
  purpose === 'send-rotate' ? 'The key change is submitted only if the payment goes through.' : null);
}

function accountForm(purpose, title) {
  const acct = addressInput('Account (r…)');
  formScreen(title, [['Account', acct.el]], purpose, () => ({ account: acct.input.value.trim() }),
    purpose === 'recovery' ? 'Builds a multi-signed SetRegularKey for the spare to sign on the offline laptop.' : null);
}

function accountSetForm() {
  const acct = addressInput('Account (r…)');
  const opts = () => [h('option', { value: '', text: '(no change)' }), ...Object.entries(ACCOUNT_SET_FLAGS).map(([v, [n, d]]) => h('option', { value: v, text: `${n}: ${d}` }))];
  const set = h('select', {}, opts());
  const clr = h('select', {}, opts());
  const domain = textInput({ placeholder: 'Leave empty for no change' });
  formScreen('Account settings', [['Account', acct.el], ['Turn on', set], ['Turn off', clr], ['Domain', domain]], 'sign', () => ({
    account: acct.input.value.trim(),
    accountSet: { SetFlag: set.value || undefined, ClearFlag: clr.value || undefined, Domain: domain.value.trim() || undefined },
  }));
}

function estateForm() {
  const acct = addressInput('The account to transfer from (r…)');
  const dest = addressInput('Destination (r…)');
  const tag = textInput({ placeholder: 'Destination tag (exchanges need one)' });
  const noTag = h('input', { type: 'checkbox' });
  formScreen('Estate Transfer', [
    ['From account (from the letter)', acct.el], ['To', dest.el], ['Destination tag', tag],
    ['', h('span', { class: 'check' }, noTag, ' I am sure this destination does not need a tag')],
  ], 'estate', () => ({ account: acct.input.value.trim(), destination: dest.input.value.trim(), destinationTag: tag.value.trim() || undefined, noTagConfirmed: noTag.checked }),
  'Sends everything above the reserve. It is signed on the offline laptop with the spare card.');
}

function migrationForm() {
  const rows = watched().map((w) => {
    const sel = h('select', {}, h('option', { value: '', text: 'not in this envelope' }), h('option', { value: 'kept', text: 'keep (new key + spare)' }), h('option', { value: 'small', text: 'close (AccountDelete)' }));
    return { w, sel, el: h('tr', {}, h('td', { text: w.label }), h('td', { class: 'mono', text: w.address }), h('td', {}, sel)) };
  });
  const leftovers = h('select', {}, watched().map((w) => h('option', { value: w.address, text: `${w.label} (${w.address})` })));
  const msg = h('div');
  const btn = button('Check accounts and build', () => {
    const kept = rows.filter((r) => r.sel.value === 'kept').map((r) => r.w.address);
    const small = rows.filter((r) => r.sel.value === 'small').map((r) => r.w.address);
    runBuild('migration', { kept, small, leftoversTo: leftovers.value, leftoversKnown: watched().map((w) => w.address) }, msg, btn);
  }, 'primary');
  show('Migration',
    note('Add the accounts to Watched accounts first. SPEC §7.5 order on mainnet: Managed, then Personal, then the small accounts.'),
    rows.length ? h('table', { class: 'fields' }, rows.map((r) => r.el)) : warnBox('No watched accounts on this network yet.'),
    h('label', { class: 'field' }, h('span', { text: 'Leftovers from closed accounts go to' }), leftovers),
    btn, msg);
}

// ---------- envelope out (A16) ----------

function envelopeScreen() {
  const { env, notes, acks } = state.built;
  const parts = frameEnvelope(JSON.stringify(env));
  let i = 0;
  let timer = null;
  const holder = h('div', { class: 'qr-holder' });
  const label = h('p', { class: 'parts' });
  const draw = () => { replace(holder, qrCanvas(parts[i], { label: `envelope part ${i + 1}` })); replace(label, `Part ${i + 1} of ${parts.length}`); };
  const auto = h('input', { type: 'checkbox' });
  auto.addEventListener('change', () => {
    clearInterval(timer);
    if (auto.checked) timer = setInterval(() => { i = (i + 1) % parts.length; draw(); }, 1500);
  });
  draw();
  show('Envelope ready',
    h('div', { class: 'card' },
      h('p', { text: `Scan ${parts.length === 1 ? 'this QR code' : `all ${parts.length} QR codes (any order)`} with the Offline Signer's webcam.` }),
      label, holder,
      parts.length > 1 ? h('div', { class: 'buttons' },
        button('Previous', () => { i = (i + parts.length - 1) % parts.length; draw(); }),
        button('Next', () => { i = (i + 1) % parts.length; draw(); }),
        h('label', { class: 'check' }, auto, ' cycle automatically')) : null),
    notes.map((n) => note(n)),
    acks.length ? warnBox(`The Offline Signer will ask you to confirm: ${acks.map((a) => a.message).join('; ')}`) : null,
    env.txs.map((tx, k) => txCard(tx, { index: k, total: env.txs.length, ctx: describeCtx(), template: tx.TransactionType === 'SetRegularKey' && !tx.RegularKey || tx.TransactionType === 'SignerListSet' && !tx.SignerEntries })),
    button('Next: scan the signed QR codes', () => { clearInterval(timer); submitScreen(); }, 'primary big'));
}

// ---------- submit (SPEC §5.5, A22) ----------

function submitScreen() {
  if (!state.built) { show('Submit', warnBox('Build the envelope on this page first; the signed codes are checked against it.')); return; }
  const { env, purpose } = state.built;
  const list = h('div');
  const msg = h('div');
  const action = h('div');
  const render = () => {
    replace(list, env.txs.map((tx, k) => {
      const r = state.signed[k];
      return h('div', { class: ['card', r ? 'ok-card' : ''] },
        h('strong', { text: `${k + 1} of ${env.txs.length}: ${describeTx(tx, describeCtx()).title}` }),
        r ? h('p', { class: 'summary' }, describeTx(r.tx, describeCtx()).summary.map((s) => (s.strong ? h('strong', { text: s.text }) : s.text))) : note('waiting for its signed QR code'),
        r ? h('p', { class: 'mono hash', text: r.hash }) : null);
    }));
    if (state.signed.filter(Boolean).length === env.txs.length) {
      sc.stop();
      replace(action, button('Submit to the ledger', () => doSubmit(action), 'primary big'));
    }
  };
  const sc = scanner((text) => {
    const t = text.trim();
    if (!/^[0-9A-Fa-f]+$/.test(t)) { replace(msg, errorBox('That QR code is not a signed transaction.')); return false; }
    let idx = -1;
    let r = null;
    for (let k = 0; k < env.txs.length; k++) {
      const c = checkSigned(env.txs[k], t);
      if (c.tx && c.tx.Account === env.txs[k].Account && c.tx.Sequence === env.txs[k].Sequence) { idx = k; r = c; break; }
    }
    if (idx < 0) { replace(msg, errorBox('That signed transaction is not one of the transactions in this envelope.')); return false; }
    if (!r.ok) { replace(msg, errorBox(`Refused: ${r.errors.join('; ')}`)); return false; }
    state.signed[idx] = { ...r, blobHex: t.toUpperCase() };
    replace(msg, okBox(`Checked transaction ${idx + 1}.`));
    render();
    return state.signed.filter(Boolean).length === env.txs.length;
  }, { hint: 'Hold each signed QR code from the Offline Signer up to this camera.' });
  render();
  show('Submit signed transactions', sc.el, msg, list, action);

  async function doSubmit(where) {
    replace(where, note('Submitting… keep this page open until every transaction is validated.'));
    try {
      const results = await submitAll(rpc, purpose, state.signed.map((r) => ({ blob: r.blobHex, tx: r.tx })), {
        onProgress: (k, res) => where.append(h('p', { class: res.validated && res.code === 'tesSUCCESS' ? 'ok' : 'warn', text: `${k + 1}: ${res.message}${res.hash ? ` (${res.hash})` : ''}` })),
      });
      // Post-checks on what actually validated (A22).
      const st = await networkState(rpc);
      const snaps = {};
      for (const a of new Set(env.txs.map((t) => t.Account))) {
        try { snaps[a] = (await snapshot(rpc, a, st)).snap; } catch (e) { if (e.code === 'not-found') snaps[a] = null; else throw e; }
      }
      const done = state.signed.filter((r, k) => results[k] && results[k].validated && results[k].code === 'tesSUCCESS');
      const problems = postChecks(purpose, done, snaps, { shared: state.built.shared });
      where.append(problems.length ? errorBox(`Post-checks failed: ${problems.join('; ')}`) : okBox('All post-checks passed.'));
    } catch (e) {
      where.append(errorBox(String(e.message || e)));
    }
  }
}

// ---------- print (A25) ----------

function printMenu() {
  show('Print',
    h('div', { class: 'card' }, button('Blank Spare Key Card', spareCardScreen, 'primary'), note('A blank card holds no secret. The spare is copied onto it by hand on the offline laptop.')),
    h('div', { class: 'card' }, button('Estate letter', letterScreen, 'primary'), note('One letter per account. It contains no secrets.')));
}

function printArea(...content) {
  return h('div', {}, button('Print', () => window.print(), 'primary'), h('div', { class: 'print-area' }, ...content));
}

function spareCardScreen() {
  const label = textInput({ placeholder: 'Account label, e.g. Managed' });
  const out = h('div');
  show('Blank Spare Key Card',
    h('div', { class: 'card row' }, label, button('Make card', () => {
      replace(out, printArea(h('div', { class: 'spare-blank' },
        h('h3', { text: `Spare key: ${label.value.trim() || '____________'}` }),
        h('p', { text: 'Spare address: ______________________________________' }),
        h('div', { class: 'box-row' }, SPARE_CARD_GROUPS.map((n, g) => h('div', { class: 'box-group' },
          h('div', { class: 'group-no', text: String(g + 1) }),
          Array.from({ length: n }, () => h('div', { class: 'box' }, h('div', { class: 'box-char' }), h('div', { class: 'box-case', text: 'U / l' })))))),
        h('p', { class: 'small', text: 'Circle U (upper) or l (lower) under each letter. Keep this card like cash. Never photograph it.' }))));
    }, 'primary')),
    out);
}

function letterScreen() {
  const addr = addressInput('Account address (r…)');
  const label = textInput({ placeholder: 'Account label (optional)' });
  const who = textInput({ placeholder: 'Who it belongs to (optional, or write by hand)' });
  const out = h('div');
  show('Estate letter',
    note('Nothing typed here is saved. Leave a field empty to write it by hand after printing.'),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', { text: 'Account' }), addr.el),
      h('label', { class: 'field' }, h('span', { text: 'Label' }), label),
      h('label', { class: 'field' }, h('span', { text: 'Belongs to' }), who),
      button('Make letter', () => {
        const L = estateLetter({ address: addr.input.value.trim(), accountLabel: label.value || labelOf(addr.input.value.trim()), belongsTo: who.value, network: state.network, offlineSha256: __OFFLINE_SHA256__ });
        const sec = (s) => h('section', {},
          h('h3', { text: s.heading }),
          (s.paragraphs || []).map((p) => (typeof p === 'string' ? h('p', { text: p }) : h('p', {}, h('strong', { text: p.bold })))),
          s.list ? h('ol', {}, s.list.map((x) => h('li', { text: x }))) : null);
        replace(out, printArea(h('article', { class: 'letter' }, h('h2', { text: L.title }), L.sections.map(sec)),
          h('article', { class: 'letter appendix' }, L.appendix.map(sec))));
      }, 'primary')),
    out);
}

// ---------- secret guard (A23) and start ----------

function guard() {
  const banner = document.getElementById('secret-warning');
  const trip = (el) => {
    el.value = '';
    banner.classList.remove('hidden');
    banner.textContent = 'That looked like a secret key, so it was cleared. A seed must never be typed on an online computer: treat that key as compromised and move its funds with a new key.';
  };
  document.addEventListener('paste', (e) => {
    const t = e.clipboardData && e.clipboardData.getData('text');
    if (t && containsSeed(t)) { e.preventDefault(); trip(e.target); }
  }, true);
  document.addEventListener('input', (e) => {
    if (e.target && 'value' in e.target && containsSeed(e.target.value)) trip(e.target);
  }, true);
}

export function startApp() {
  screenEl = document.getElementById('screen');
  netEl = document.getElementById('network-banner');
  statusEl = document.getElementById('conn-status');
  const sw = document.getElementById('network-switch');
  for (const n of NETWORKS) sw.append(button(n.toUpperCase(), () => switchNetwork(n), `net-${n}`));
  guard();
  switchNetwork('testnet');
}

export { dropsToXrp };
