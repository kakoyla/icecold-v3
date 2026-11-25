// Second layer behind the Content-Security-Policy (SPEC §4.1): remove the
// browser's network APIs before any other code runs, so nothing in this page,
// including bundled libraries, can even attempt a request.
// The camera (navigator.mediaDevices) is left alone; SPEC §4.1 needs it.

const GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
  'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel',
  'Worker', 'SharedWorker', 'ServiceWorker',
];
const NAVIGATOR = ['sendBeacon', 'serviceWorker'];

function kill(obj, name) {
  try {
    Object.defineProperty(obj, name, { value: undefined, writable: false, configurable: false, enumerable: false });
    return obj[name] === undefined;
  } catch {
    return obj[name] === undefined;
  }
}

/** Returns { removed: string[], failed: string[] }. */
export function lockdownNetwork(g = globalThis) {
  const removed = [];
  const failed = [];
  for (const n of GLOBALS) (kill(g, n) ? removed : failed).push(n);
  if (g.navigator) for (const n of NAVIGATOR) (kill(g.navigator, n) ? removed : failed).push(`navigator.${n}`);
  return { removed, failed };
}

/**
 * SPEC §4.1: randomness only from crypto.getRandomValues. bignumber.js (a
 * dependency of ripple-binary-codec) calls Math.random once while loading,
 * for a helper we never use. Run this after the bundle has loaded so any
 * later use throws instead of quietly producing weak randomness.
 */
export function forbidMathRandom(g = globalThis) {
  const thrower = () => { throw new Error('Math.random is forbidden in ICE COLD (use crypto.getRandomValues)'); };
  try {
    Object.defineProperty(g.Math, 'random', { value: thrower, writable: false, configurable: false });
  } catch { /* checked by the caller */ }
  try { g.Math.random(); return false; } catch { return true; }
}
