// The one place to set what browser the offline HTML must run on (SPEC O-1).
//
// The signing machine's stock Firefox 58 has no BigInt, which the §4.1
// libraries need. Interim target: portable Firefox ESR 140.17.0 (32-bit),
// see DECISIONS.md. esbuild fails the build if the code needs a feature this
// target lacks.
export const BROWSER_TARGET = ['firefox140'];

export const OUT_FILE = 'dist/icecold-v3-offline.html';
