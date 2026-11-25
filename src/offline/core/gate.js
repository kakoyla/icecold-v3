// SPEC §4.3: every signing function stays disabled until the startup
// self-test has passed. A failed self-test disables signing for the session.

let state = 'untested'; // 'untested' | 'passed' | 'failed'

export function markSelfTest(passed) {
  // Once failed, stays failed: a later "pass" cannot re-enable signing.
  if (state === 'failed') return;
  state = passed ? 'passed' : 'failed';
}

export function signingEnabled() {
  return state === 'passed';
}

export function assertSigningEnabled() {
  if (state !== 'passed') {
    throw new Error(`Signing disabled: self-test ${state}`);
  }
}

// Test-only hook. Not reachable from the built page (tree-shaken: unused there).
export function _resetGateForTests() {
  state = 'untested';
}
