// The one place to set what browser the offline HTML must run on (SPEC O-1).
//
// The signing machine's stock Firefox 58 has no BigInt, which the §4.1
// libraries need. Target: portable Firefox ESR 140.17.0 (32-bit), which
// passed the probe on the machine (DECISIONS.md, O-1 closed 2026-11-27). esbuild fails the build if the code needs a feature this
// target lacks.
export const BROWSER_TARGET = ['firefox140'];

export const OUT_FILE = 'dist/icecold-v3-offline.html';

// Online Builder (SPEC §5): runs on a normal, up-to-date browser (desktop or
// phone), in the explorer tab or standalone on GitHub Pages.
export const ONLINE_TARGET = ['chrome110', 'firefox115', 'safari16'];
export const ONLINE_OUT_FILE = 'dist/icecold-v3-online.html';
// Test build only: the same page pointed at a local fake ledger. Never published.
export const ONLINE_TEST_OUT_FILE = 'dist-test/icecold-v3-online-test.html';
