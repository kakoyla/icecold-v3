# ICE COLD v3

ICE COLD v3 is a cold-storage system for XRP on the XRP Ledger. It has two parts:

- an **offline signer**: one self-contained HTML file for an air-gapped machine
- an **online builder** that never sees a secret

[SPEC.md](SPEC.md) is the authoritative specification. [DECISIONS.md](DECISIONS.md)
records how its open points were resolved.

> **Status: Phase 3 (Online Builder), under review. Not for real funds.**
> Testnet and test keys only. Next: the Testnet rehearsal (SPEC §7.4).

## Build

Needs Node 20.19+ (see `.nvmrc`).

```sh
npm ci           # exact versions from package-lock.json
npm run build    # -> dist/icecold-v3-offline.html, dist/icecold-v3-online.html, .sha256 files
npm test         # unit tests + headless-browser tests (fake ledger, no network)
npm run test:testnet   # optional: live check on the XRPL Testnet (faucet accounts)
```

The build is reproducible: the same commit always produces the same file.
To check a release yourself:

```sh
sha256sum dist/icecold-v3-offline.html dist/icecold-v3-online.html
```

Compare the result with the release's published SHA-256 and with your paper
hash log. No releases have been published yet.

## Layout

| Path | What |
|---|---|
| `src/offline/core/` | Offline core: key/sign/multisign wrappers, vault, envelope validation, safety checks, pending-key resolution, self-test |
| `src/offline/main.js` | Entry point: network lockdown, code self-hash, self-test, then the screens |
| `src/offline/ui/` | Screens: vault, envelope scanning, every signing flow (`flows/`), tools |
| `src/online/core/` | Online Builder logic: ledger reads, envelope builders, signed-blob checks, submit, watch list, letters |
| `src/online/ui/` | Online Builder screens |
| `.github/workflows/pages.yml` | GitHub Pages publish, manual only (not switched on) |
| `scripts/testnet-check.mjs` | Optional live Testnet check |
| `build.config.js` | Browser target (the single setting for SPEC O-1) |
| `scripts/build.mjs` | One-command single-file build |
| `scripts/privacy-scan.mjs` | Pre-push scan for addresses, seeds, emails and amounts |
| `test/unit/`, `test/e2e/` | Tests (`node:test`; Playwright drives every screen in Chromium and Firefox) |

The e2e suite needs the Playwright browsers: `npx playwright install chromium firefox`.

## License

MIT. See [LICENSE](LICENSE).
