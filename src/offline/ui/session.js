// SPEC §4.2 session: the open vault, the idle auto-lock and secret cleanup.
// DECISIONS A17: a visible countdown before the lock, and a full wipe on lock
// and after every signing.
import { IDLE_LOCK_MS } from '../core/config.js';

const WARN_MS = 60 * 1000;

// The open vault. fileText is the encrypted file (harmless); payload holds
// the decrypted seeds and is dropped on lock.
export const session = {
  vault: null, // { network, fileName, fileText, payload }
};

// Cleanup functions, each tagged with when it was registered. A screen's
// content is built before show() attaches it, so show() wipes only what was
// registered before the previous render (the old screen), never the new one.
const cleanups = new Map();
let seq = 0;
let renderMark = 0;
let lockListeners = [];
let lastActivity = Date.now();
let timer = null;

/** Register a function that wipes secrets; it runs on lock and on wipeAll(). */
export function onWipe(fn) {
  cleanups.set(fn, ++seq);
  return () => cleanups.delete(fn);
}

function runCleanups(all) {
  for (const [fn, n] of [...cleanups]) {
    if (!all && n > renderMark) continue;
    cleanups.delete(fn);
    try { fn(); } catch { /* keep wiping */ }
  }
}

/** Called by the screen renderer after new content is attached. */
export function markRender() { renderMark = seq; }

/** Screen change: wipe the old screen's secrets, keep the new screen's. */
export function wipeStale() {
  runCleanups(false);
  clearDomSecrets();
}

/** Wipe everything secret: flow state, inputs, displayed seeds, camera. */
export function wipeAll() {
  runCleanups(true);
  clearDomSecrets();
}

/** Clears inputs and displayed seeds currently in the page. */
function clearDomSecrets() {
  for (const i of document.querySelectorAll('input, textarea')) {
    if (i.type === 'checkbox' || i.type === 'radio') i.checked = false;
    else if (i.type === 'file') i.value = '';
    else i.value = '';
  }
  for (const n of document.querySelectorAll('[data-seed]')) n.remove();
}

/** Drop the open vault and wipe. Returns to whatever onLock listeners do. */
export function lock(reason = 'locked') {
  wipeAll();
  if (session.vault && session.vault.payload) {
    for (const a of session.vault.payload.accounts) {
      for (const k of [a.regularKey, a.pendingKey]) if (k) k.seed = '';
    }
  }
  session.vault = null;
  for (const l of lockListeners) l(reason);
}

export function onLock(fn) { lockListeners.push(fn); }

export function touch() { lastActivity = Date.now(); }

/**
 * Start the idle timer. warn(msLeft|null) is called every second during the
 * last minute (null when activity resets it).
 */
export function startIdleLock(warn, idleMs = IDLE_LOCK_MS) {
  for (const ev of ['keydown', 'mousedown', 'mousemove', 'touchstart', 'wheel']) {
    document.addEventListener(ev, () => { touch(); warn(null); }, { capture: true, passive: true });
  }
  clearInterval(timer);
  timer = setInterval(() => {
    const left = idleMs - (Date.now() - lastActivity);
    if (left <= 0) {
      warn(null);
      touch();
      lock('idle');
    } else if (left <= WARN_MS) {
      warn(left);
    }
  }, 1000);
}
