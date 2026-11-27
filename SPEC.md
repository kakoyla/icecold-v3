# ICE COLD v3 — Specification

**Status:** Draft for review · 2026-11-25
**Repo:** `kakoyla/icecold-v3`
**Owner:** the repository owner. Any change to this spec needs the owner's approval.

This document is the referee. Code, reviews (Claude Code, Gemini) and tests are judged against it. If a suggestion conflicts with the spec, the spec wins until the owner changes it.

---

## 0. Purpose and principles

ICE COLD v3 is a cold-storage system for XRP on the XRP Ledger. It has two parts:

- **Online Builder:** a tab in the owner's existing XRPL explorer site (separate repo), plus a standalone copy on GitHub Pages. It reads the ledger, builds unsigned transactions and submits signed ones. It never sees a secret.
- **Offline Signer:** one self-contained HTML file on the air-gapped machine. It holds the keys, signs, and never touches a network.

Principles:

1. **The online side builds and the offline side signs.** There is one exception: in a rotation, the offline side fills in the new `RegularKey` field (§4.5).
2. **Secrets never leave the offline machine,** except as deliberately made paper spares.
3. **Trust comes from passing tests, not from who wrote the code.** Cryptography comes only from established libraries; no crypto is hand-rolled (§7).
4. **Small surface area.** Only the transaction types in §3 are supported. Everything else is refused.
5. **ICE COLD v1 stays in service** until v3 passes acceptance (§7.5).

---

## 1. Environment

### Offline machine
- An old laptop running Linux, with full-disk encryption and no network.
- A USB webcam scans QR codes. A spare USB keyboard is available, and the machine can output to a TV over HDMI.
- **The browser is old.** ICE COLD v2 failed on it with "checksum failed", which an October 2026 build traced to browser compatibility. The exact browser and version are **TBD (open item O-1)**. The build must target that browser and must pass the startup self-test on it.
- Software comes in one way only: on a dedicated USB stick, SHA-256 checked against a paper hash log, mounted read-only. Nothing comes back out on the stick.

### Online side
- The explorer site: Vue 3, Vite and Tailwind v4 (separate repo).
- A standalone static build of the Online Builder is published on GitHub Pages from `kakoyla/icecold-v3`, so the estate path (§6) still works if the domain lapses.

### Data across the gap
- **Unsigned in:** a QR code on the online screen, scanned by the offline webcam.
- **Signed out:** a QR code on the offline screen, scanned by the online device's camera.
- A phone may carry signed blobs. It never sees a secret, and a secret QR is never scanned with a phone.

---

## 2. Accounts and keys (target state)

| Account | Owner | After migration |
|---|---|---|
| Personal | The owner | Kept |
| Managed | Another person (held and managed by the owner) | Kept |
| Small accounts (list TBD, O-2) | The owner | Closed with AccountDelete; leftovers go to Personal |

Each kept account has:
- **Master key disabled** (already true today).
- **Its own regular key:** Ed25519, stored only in the offline vault. No paper copy.
- **Its own signer list:** `SignerQuorum: 1`, one entry with `SignerWeight: 1`.
- **One spare key in that signer list:** Ed25519, never used to sign, never funded, never used for anything else, and kept on paper only. Each account has a different spare.

The current **shared regular key** is retired once migration is done. Its paper backups are destroyed after acceptance (§7.5).

**Key format default:** Ed25519 with a standard family seed (prefix `sEd`). secp256k1 can be chosen when generating a key. Word-list mnemonics are out of scope.

**Backup model:**
- Primary: the encrypted vault on the encrypted disk.
- Disaster or estate: the paper spares.
- There is **no per-rotation USB backup** of the vault. If the disk is lost, recovery uses the spare (§4.6).

---

## 3. Supported transaction types

| Type | Use | Notes |
|---|---|---|
| `Payment` | Sending XRP | XRP only: `Amount` must be a drops string. Refuse `Paths`, `SendMax`, `DeliverMin`, and `tfPartialPayment`. |
| `SetRegularKey` | Rotation, migration, recovery | Refuse any `SetRegularKey` that removes the key (no `RegularKey` field). |
| `SignerListSet` | Migration, replacing a spare | Arrives as a template with `SignerQuorum: 1` and no entries; the offline side fills in the spare. Deleting a list is not supported (DECISIONS A11). |
| `AccountSet` | Occasional settings | Show every flag and field in plain English, with the catch-all from v2. |
| `AccountDelete` | Closing small accounts during migration | Destination must be a vault account, unless the user explicitly overrides. |

Both sides refuse every other type.

---

## 4. Offline Signer

### 4.1 Form
- **One HTML file** with all JS and CSS inline, built from source (§7.3).
- A **Content-Security-Policy meta tag** blocks every network request (`connect-src 'none'`, plus no remote scripts, images or fonts). Tests prove that no network API is reachable.
- The camera works the same way it did in v2.
- **Libraries:**
  - `ripple-keypairs` / `xrpl.js` primitives
  - `ripple-binary-codec`
  - `ripple-address-codec`
  - `@noble/curves`
  - `@noble/hashes`
  - `@noble/ciphers`
  - a QR encoder and decoder

  All are pinned by lockfile.
- **Randomness** comes only from `crypto.getRandomValues`.

### 4.2 Vault
- **A file on disk:** `icecold-vault-<network>-<timestamp>.json`, opened with a file picker and saved with a browser download. There is no browser storage as a source of truth.
- **Encryption:** scrypt from `@noble/hashes`, tuned to about 2–5 seconds on the signing machine (starting point: N=2^17, r=8, p=1), then AES-256-GCM from `@noble/ciphers`. These are pure-JS libraries, so the vault doesn't depend on WebCrypto being available under `file://`.
- **Separate vaults per network.** A testnet vault can never sign a mainnet envelope, and the reverse.
- **Contents, per account:**
  - label and address
  - current regular key: algorithm, seed, public key, derived address
  - pending regular key, if any (§4.5)
  - public addresses of retired keys
  - an address book of labeled destinations
- **Spares are never stored in the vault.**
- **Session:** the vault auto-locks after 5 minutes idle. Secrets are wiped from inputs and memory after each signing.

### 4.3 Startup self-test
- Before anything else, the file runs known test vectors:
  - seed → address for Ed25519 and secp256k1
  - a deterministic signature of a fixed transaction
  - a multisign signature, for Ed25519 and secp256k1
  - a binary codec round-trip
- If any vector fails, a red full-width banner appears and every signing function is disabled.
- The file shows its own build version and the SHA-256 of its embedded application code, and re-checks that hash at startup (red banner on mismatch). A file cannot contain its own SHA-256, so the hash of the whole HTML file is published in the release notes and written on the paper log, and checked with `sha256sum` before opening the file (DECISIONS A1).

### 4.4 Generic signing flow (every signature goes through this)
1. Scan the envelope QR (§5.3).
2. Validate it: supported type, network matches the vault, `LastLedgerSequence` present, fee under the cap (§4.8), and the account is in the vault (except in Recovery, Estate or Migration). With no vault open (Recovery, Estate), the user confirms the network on screen instead (DECISIONS A3).
3. Show a **plain-English summary card** in large type, for example: "Send 500 XRP from **Personal** to **Coinbase deposit** (rAbc…xyz9), tag 123456". First-time destinations get an extra confirmation. Every raw field is listed below the summary.
4. Show a **network banner** in the header: red **MAINNET** or blue **TESTNET**.
5. Enter the passphrase, then sign.
6. Show the signed blob as a QR code, with its hash and the summary.

### 4.5 Send & Rotate (and Rotate-only)
- **Input:** an envelope holding a `Payment` (Sequence N) and a `SetRegularKey` template (Sequence N+1) with no `RegularKey` value.
- **Offline steps, on one screen with one passphrase:**
  1. Generate a new regular key and fill it into the `SetRegularKey`.
  2. Write a new vault file with the new key marked **pending**.
  3. **Gate:** re-open and decrypt the saved vault and confirm the pending key is in it. The signed pair is not shown until this passes.
  4. Sign both transactions with the current key.
  5. Show both signed QR codes, plus the new key's address (first and last 6 characters in large type).
- **Resolving the pending key:** every envelope includes the account's `RegularKey` as it currently stands on the ledger. On the next signing, the offline side uses that to promote the pending key to current, or discard it. If neither the current nor the pending key matches the ledger, signing is blocked and the user is pointed to Recovery.
- **Rotate-only** works the same way without the Payment.

### 4.6 Recovery (guided)
- **When:** the vault or disk is lost, or the regular key is unknown.
- **Input:** an envelope with a multi-sign `SetRegularKey` (`SigningPubKey: ""`, fee = base × 2), plus the account's signer list as it stands on the ledger.
- **Steps:**
  1. Type the spare seed from paper. Seed repair (from v2) runs if the checksum fails.
  2. Show the derived spare address and **confirm it is in the ledger's signer list.** If it isn't, stop.
  3. Generate a new regular key into a new vault.
  4. Multi-sign the transaction with the spare.
  5. Show the signed QR code.
- **Follow-up prompt:** "Your spare is now used. Make a new spare and replace it with SignerListSet." This links to the Replace Spare flow.

### 4.7 Other screens
- **Estate Transfer** (§6): works with no vault and no passphrase. It needs only a spare paper.
- **Migration** (§4.9).
- **Replace Spare:**
  1. Generate a new spare and display it to be written down.
  2. Re-enter it from the paper and check that it derives the same address.
  3. Sign a `SignerListSet` with the current regular key.
- **Spare Key Card** (used by Migration and Replace Spare):
  - **Handwritten (decided):** a blank card the Online Builder prints ahead of time, since a blank card holds no secret. It has the account label, a line for the spare's public address, and one box per seed character with an upper/lowercase mark under each box.
  - The offline screen shows the seed **grouped in blocks of 4 characters**, with each character's case spelled out, to make copying easier.
  - The spare isn't accepted until it has been typed back in from the paper and derives the same address.
  - **Optional:** a printed version with a QR code, only if a dedicated printer that never connects to any network is ever used (based on v2's foldable key card layout). Not part of the default flow.
- **Generate Keypair:** for testnet and for spares.
- **Decode / Verify:** decode any blob and verify its signature.
- **Seed Repair:** carried over from v2.

### 4.8 Hard safety checks (each one must have a failing test)
- **Fee caps:** 0.001 XRP for single-signed transactions, 0.002 XRP for multi-signed, and the owner reserve plus 0.001 XRP for AccountDelete. The owner reserve comes from the envelope and is refused above 2 XRP (DECISIONS A4). Values are open item O-5.
- **Payment:** XRP only, no partial-payment flag, `Destination` ≠ `Account`.
- **Destination tags:** if the destination is labeled as an exchange, or the user marks it as needing a tag, a `DestinationTag` is required.
- **SetRegularKey:** may not remove the key.
- **Network:** the envelope's network must match the vault's.
- **Expiry:** `LastLedgerSequence` must be present and after the envelope's `builtAt` ledger. The estimated expiry time, `closeTime + (LastLedgerSequence − ledgerIndex) × 4 s`, is shown on screen (DECISIONS A6).
- **No unknown fields:** an unknown field or flag blocks signing until the user acknowledges it. The allowed fields per type, and the fields refused outright, are listed in DECISIONS A5.

### 4.9 Migration (one-time)
- **Input:** a migration envelope from the online wizard. For each kept account it holds a `SignerListSet` template at Sequence N, then a `SetRegularKey` template at Sequence N+1; for each small account it holds a single `AccountDelete`. The order matters: once `SetRegularKey` validates, the shared key no longer signs for that account (DECISIONS A10).
- **Steps:**
  1. Enter the shared regular key, typed from paper or scanned from paper with the offline webcam. It is held only for this session.
  2. For each kept account:
     - generate that account's new regular key and store it in the vault as pending
     - generate its spare and display it to be written down
     - re-enter the spare from the paper and check that it derives the same address
     - fill both templates
  3. Sign every transaction with the shared key.
  4. Show the signed QR codes in order, numbered.
  5. Wipe the shared key from memory.

---

## 5. Online Builder

### 5.1 Placement
- A "Cold Storage" tab in the explorer site, plus the standalone GitHub Pages build of the same code.

### 5.2 Data
- **Watch-only:** public addresses and labels are kept in browser storage and can be cleared. *(Confirm: O-4.)*
- **Servers:** public XRPL servers with fallback, and a Testnet/Mainnet switch shown as clearly as on the offline side.
- **Never accepts a secret.** Any pasted input that decodes as a seed is rejected with a warning.

### 5.3 Envelope (what the online side sends across the gap)
- A JSON object with:
  - `version`
  - `network`
  - `purpose` (`sign`, `send-rotate`, `rotate`, `migration`, `recovery`, `estate`, `replace-spare`). `sign` carries exactly one `Payment` or `AccountSet`; key and signer-list changes only travel under their own purposes (DECISIONS A9).
  - `txs[]`: unsigned, with `Sequence`, `Fee` and `LastLedgerSequence` filled in
  - a `ledger` snapshot per account: balance, reserve, current `RegularKey`, `SignerList`, whether the master key is disabled
  - `ownerReserveDrops`: the network's owner reserve, in drops, for the AccountDelete fee cap (DECISIONS A4)
  - `builtAt`: `{ ledgerIndex, closeTime }` of the ledger the envelope was built from, for the expiry estimate (DECISIONS A6)
- Kept compact. If it's too large for one QR that the actual webcam reads reliably, split it into a numbered sequence ("1/3"). The size threshold is set by testing with the real webcam.
- `LastLedgerSequence` window defaults to about 1 hour (about 3 hours for `migration`) and is configurable (DECISIONS A12).

### 5.4 Flows
- **Send:** Payment only.
- **Send & Rotate:** pair, with submission gating (§5.5).
- **Rotate.**
- **AccountSet.**
- **Migration wizard:**
  - lists every account still on the shared key
  - checks each small account for deletion blockers (objects, trust lines, and the `Sequence` + 256 rule) and shows what needs clearing
  - builds the migration envelope
- **Recovery:** builds a multi-sign `SetRegularKey`.
- **Replace Spare.**
- **Estate Transfer** (§6).
- **Estate letter generator** (§6).

### 5.5 Submit
- Scan the signed QR codes, decode them, show a summary, and check that each hash matches what was built.
- Submit, then wait until each transaction is validated, and show the result in plain English.
- **Send & Rotate gating:**
  - Submit the Payment first.
  - Submit the SetRegularKey only if the Payment was validated (`tesSUCCESS` or any `tec`, since both use up the sequence number).
  - Otherwise, discard both and tell the user to run Rotate-only.
- **Post-checks:**
  - after a rotation, the ledger's `RegularKey` equals the new key's address
  - after migration, no kept account still references the shared key, and every signer list holds the expected spare

---

## 6. Estate path
- **Model:** whoever holds an account's estate package can move that account's funds. Each package is a bearer instrument, and where it's stored is the owner's decision, not something the code handles. Seeds never go in a will, because wills become public in probate.
- **One package per kept account, each fully self-contained:**
  - **Personal package:** Personal's spare paper plus its letter. Stored with the owner's estate materials.
  - **Managed package:** the Managed account's spare paper plus its letter. Stored where **that account's beneficial owner can reach it themselves, without going through the owner's estate.** Storage that only opens through the owner's estate does not meet this requirement.
  - Neither package mentions or depends on the other.
- **If the Managed account's beneficial owner dies first:** the owner still holds that account's regular key in the vault, so they can move the funds as that person's estate directs, using normal signing. The Managed package is then retrieved and destroyed, or replaced.
- **Estate letter generator:** runs on the online side and produces one letter per account. Letters contain no secrets. Each letter covers:
  - that account's address and who it belongs to
  - where that account's spare is kept. **Left blank when printed and filled in by hand,** so the location never passes through a printer or computer.
  - the GitHub Pages URLs for both builds, plus the expected SHA-256 of the offline HTML
  - step-by-step Estate Transfer instructions written for a non-technical reader
  - a warning about destination tags
  - "You will probably need someone good with computers. Pick someone you trust in person."
- **Helper appendix** (same letter, its own page, written for the person brought in to help):
  - the exact steps, the commands to check the file hash, and what each screen should look like
  - **Scam warning, printed in bold:** nobody legitimate will ever ask for the spare seed remotely, over the phone or online. "Wallet recovery services" that ask for it are theft. The helper must be physically present, and the spare is typed only into the offline signer on a laptop with Wi-Fi off.
  - Once the funds arrive at the destination, cold storage for that account is over, so the spare paper can be destroyed.
- **Estate Transfer flow:**
  1. **Online:** build a multi-sign Payment of (balance − reserve − fee) to the destination, with `DestinationTag` required by default.
  2. **Offline:** works on any laptop with Wi-Fi off, using the v3 HTML downloaded from GitHub. Type the spare, confirm it's in the signer list, check the summary twice, sign.
  3. **Online:** submit.

  Using the spare doesn't matter here, because the funds leave cold storage.

---

## 7. Testing, build and acceptance

### 7.1 Automated tests
- Key derivation and signing vectors taken from the xrpl.js test suites, for both algorithms.
- Every signature v3 produces is verified by xrpl.js in tests. Multisign output is checked against `xrpl.multisign`.
- Envelope validation, plus every safety check in §4.8 (one failing test each).
- Vault round-trip: a wrong passphrase fails, tampering fails, a mismatched network fails.
- Pending-key resolution in all three cases: ledger matches current, ledger matches pending, ledger matches neither.
- A no-network test: the built HTML makes zero requests in a headless browser.

### 7.2 Old-browser test
- The built HTML passes the self-test and all flows in the same browser and version as the signing machine (O-1).

### 7.3 Reproducible release
- Pinned dependencies, and the single HTML built from source by one command.
- The SHA-256 of each release is published in the README and the release notes, and recorded on the paper hash log.

### 7.4 Testnet rehearsal (manual checklist, run on the actual signing machine and webcam)
1. Create testnet stand-ins: "Personal", "Managed", and 2 small accounts. Fund them, set a shared regular key, disable the master keys.
2. Run the full migration, including closing the small accounts.
3. Send & Rotate three times on each kept account.
4. Delete the vault, then recover each account with its spare.
5. Replace each spare.
6. Estate Transfer from "Managed" to a third testnet account, using a destination tag. **Do this run from the Managed letter alone**, on a laptop other than the signing machine, following only the printed steps.
7. Confirm every post-check passes.

### 7.5 Acceptance (before mainnet)
- §7.1–7.4 all pass. Then the owner runs the mainnet migration in this order:
  1. Managed
  2. Personal
  3. small accounts
  4. post-checks
- After that, destroy the old shared-key papers, and v1 retires.

### 7.6 Review process
- Build in phases, with each phase reviewed by Gemini against this spec before merging:
  1. Offline core (crypto wrappers, vault, envelope validation) and tests
  2. Offline UI
  3. Online Builder tab and standalone build
  4. Testnet rehearsal
  5. Mainnet migration
- Review findings are triaged against the spec. Anything that would change the spec goes to the owner.

---

## 8. Out of scope
Tokens and trust lines, the DEX, escrow, NFTs, AMM, checks, building transactions offline (except the rotation `RegularKey` fill-in), mnemonics, hardware wallets, signing on a phone, and per-rotation USB backups.

---

## 9. Open items
| ID | Item | Owner |
|---|---|---|
| O-1 | ~~Exact browser and version on the signing machine~~ **Resolved 2026-11-27:** portable Firefox ESR 140.17.0, 32-bit Linux. The probe and the signer self-test passed on the machine (DECISIONS O-1). | — |
| O-2 | Addresses of the small accounts (the wizard checks for blockers) | Owner |
| O-3 | ~~Printing path for Spare Key Cards~~ **Resolved 2026-11-25: handwritten.** No printer that stays permanently offline is available. | — |
| O-4 | Confirm watch-only label storage on the online side | Owner |
| O-5 | Final fee-cap values | Owner + review |
| O-6 | Where each estate package is physically kept. The Managed package must be reachable by its beneficial owner without going through the owner's estate. | Owner (not code) |
