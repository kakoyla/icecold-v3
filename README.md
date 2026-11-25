# ICE COLD v3

ICE COLD v3 is a cold-storage system for XRP on the XRP Ledger. It has two parts:

- an **offline signer**: one self-contained HTML file for an air-gapped machine
- an **online builder** that never sees a secret

[SPEC.md](SPEC.md) is the authoritative specification. [DECISIONS.md](DECISIONS.md)
records how its open points were resolved.

> **Status: Phase 1 (offline core), under review. Not for real funds.**
> Testnet and published test vectors only.

## Build

Needs Node 20.19+ (see `.nvmrc`).

```sh
npm ci           # exact versions from package-lock.json
npm run build    # -> dist/icecold-v3-offline.html and its .sha256
npm test         # unit tests + headless-browser tests
```

The build is reproducible: the same commit always produces the same file.
To check a release yourself:

```sh
sha256sum dist/icecold-v3-offline.html
```

Compare the result with the release's published SHA-256 and with your paper
hash log. No releases have been published yet.

## Layout

| Path | What |
|---|---|
| `src/offline/core/` | Offline core: key/sign/multisign wrappers, vault, envelope validation, safety checks, pending-key resolution, self-test |
| `src/offline/main.js` | Phase 1 page: network lockdown, code self-hash, self-test |
| `build.config.js` | Browser target (the single setting for SPEC O-1) |
| `scripts/build.mjs` | One-command single-file build |
| `scripts/privacy-scan.mjs` | Pre-push scan for addresses, seeds, emails and amounts |
| `test/unit/`, `test/e2e/` | Tests (`node:test`; Playwright for the no-network test) |

The e2e suite needs the Playwright browsers: `npx playwright install chromium firefox`.

## License

MIT. See [LICENSE](LICENSE).
