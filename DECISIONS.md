# Decisions log

SPEC.md is authoritative. This file records how ambiguities in it were resolved
and choices the spec leaves open. Nothing here changes the spec. Approved
wording was folded into SPEC.md on 2026-11-25; entries say where.

## Open item O-1: signing-machine browser (closed 2026-11-27)

- The signing machine's stock browser is Firefox 58, which has no `BigInt`.
  The §4.1 libraries (`@noble/*`, `ripple-keypairs` 3.x) require it, so they
  cannot run there. This also explains the v2 "checksum failed" error.
- **Plan:** run a portable Firefox ESR 140.17.0 (32-bit Linux) next to the
  stock browser, brought in on the read-only USB stick and hash-checked as §1
  requires. It was verified against Mozilla's signed SHA256SUMS before it
  was copied to the machine.
- **Build target:** `firefox140`, set in one place: `build.config.js`.
- **Closed 2026-11-27:** on the machine itself, Firefox ESR 140.17.0 (32-bit,
  hash-checked from a new read-only stick) passed every probe check, and the
  Offline Signer showed "Self-test passed". Its user agent says
  `Linux x86_64` although the build is 32-bit: since Firefox 127, 32-bit x86
  Linux builds report x86_64 on purpose, to reduce fingerprinting (Mozilla
  bug 1873273). The build is identified by its hash, not that string.
- **scrypt timings on the machine (r=8, p=1):** N=2^14 1.2 s, 2^15 2.9 s,
  2^16 4.9 s, 2^17 9.7 s. The vault default is now **N = 2^16**, the strongest
  value inside the §4.2 range of 2–5 s. Owner approved. The probe ran scrypt
  with `asyncTick: 50` and no progress callback, so the vault now passes
  `asyncTick: 50` too, and the progress bar updates only when its whole
  percentage changes (Gemini review).
- **Real unlock on the machine (2026-11-27):** with the rebuilt signer, an
  empty testnet vault took 5.3 s to create and 5.7 s to unlock (hand
  stopwatch, so it includes reaction time). That is just above the 2–5 s
  target, and N = 2^15 would take about 3 s. The owner chose to keep N = 2^16:
  the time does not matter to them, since signing is rare, and it doubles the
  cost of guessing the passphrase.
- **Machine clock:** the clock reads years in the past and the firmware reports
  a clock error, most likely a dead CMOS battery. Signing does not read the
  clock: the expiry estimate (A6) uses the envelope's `builtAt.closeTime`,
  and the idle lock and QR de-duplication measure only elapsed time. The
  clock sets only a new vault file's `createdAt` and the timestamp in its file
  name. With a dead battery the clock can reset at each cold boot, so a newer
  vault can carry an earlier timestamp than an older one, by name and by file
  date. **Before the Phase 4 rehearsal** the owner replaces the battery and
  sets the clock, or else sets the date by hand (`sudo date -s`) at each
  boot. Until then, file names and dates do not show which vault is newest.

## A1: the file cannot show its own SHA-256 (§4.3). Approved by owner.

A file cannot contain its own hash. So:

- The page embeds the SHA-256 of its inlined application code and displays it.
- At startup the page re-hashes that code and shows a red banner on mismatch.
- The SHA-256 of the whole HTML file is published in the README and release
  notes and written on the paper log (§7.3). That is the hash to check before
  opening the file.

## A2: the §4.5 gate re-opens the vault through the file picker. Approved by owner.

A browser cannot read back a file it has just downloaded. The gate asks the
user to pick the saved vault file. It decrypts that file and confirms the
pending key is there before the signed pair is shown.

## A3: purposes exempt from "account is in the vault" (§4.4 step 2). Delegated to Claude.

- **Exempt:** `recovery`, `estate` and `migration`. Migration accounts are not
  in any vault yet.
- **Estate network check:** Estate has no vault to compare against. The signer
  shows the envelope's network, and the user must confirm it explicitly before
  signing.
- The same on-screen confirmation applies to Recovery and Migration when no
  vault is open. The user must pick the right network; picking the other one
  stops the flow.

## A4: AccountDelete fee cap needs the owner reserve (§4.8). Delegated to Claude; ceiling approved by owner.

The envelope (§5.3) carries a network-wide `ownerReserveDrops` field. The
AccountDelete cap is `ownerReserveDrops + 1000` drops. Folded into
SPEC.md §4.8 and §5.3.

The online side is untrusted, so the offline side sets a hard ceiling of
**2 XRP** on `ownerReserveDrops`, in `config.js`. That was the owner reserve
before the 2024 cut to 0.2 XRP. An envelope claiming more is refused. Found in
review: without the ceiling, a compromised builder could claim a huge reserve
and burn the account's balance as the fee.

## A5: definition of "unknown field" (§4.8). Delegated to Claude.

- Each transaction type has an allowlist of fields.
- Common fields: `TransactionType`, `Account`, `Fee`, `Sequence`,
  `LastLedgerSequence`, `Flags`, `SigningPubKey`, `SourceTag`.
- Type-specific fields:

  | Type | Allowed fields |
  |---|---|
  | `Payment` | `Amount`, `Destination`, `DestinationTag` |
  | `SetRegularKey` | `RegularKey` |
  | `SignerListSet` | `SignerQuorum`, `SignerEntries` |
  | `AccountSet` | `SetFlag`, `ClearFlag`, `Domain`, `EmailHash`, `MessageKey`, `TransferRate`, `TickSize` |
  | `AccountDelete` | `Destination`, `DestinationTag` |

- Any other field, including `Memos`, `TicketSequence` and `NFTokenMinter`
  (NFTs are out of scope, §8), blocks signing until the user acknowledges it.
- **Flags:** on every type, any bit other than `tfFullyCanonicalSig` needs an
  acknowledgement. This covers AccountSet's legacy flags such as
  `tfRequireDestTag`, which change settings without `SetFlag`.
- **Risky AccountSet settings** each need an acknowledgement:
  - `ClearFlag 4` re-enables the master key
  - `SetFlag 6` (NoFreeze) is permanent
  - `SetFlag 16` (AllowTrustLineClawback) is permanent
- **AccountDelete** follows the same destination-tag rule as Payment: an
  exchange or tag-required destination with no tag is refused.
- Refused outright, with no acknowledgement possible:
  - `Paths`, `SendMax` and `DeliverMin` (§3)
  - `DeliverMax` (an alias of `Amount`)
  - `NetworkID`, which is invalid on mainnet and testnet
  - `TxnSignature` and `Signers` on an unsigned input

## A6: envelope carries ledger time for the expiry estimate (§4.8). Decided by Claude.

To show an "estimated expiry time", the envelope carries
`builtAt: { ledgerIndex, closeTime }`. Expiry is estimated as
`closeTime + (LastLedgerSequence - ledgerIndex) x 4 s`, which is shown as an
estimate. Folded into SPEC.md §5.3.

## A7: Estate payments without a destination tag need acknowledgement. Decided by Claude.

§6 says `DestinationTag` is required by default for Estate. The offline side
mirrors this: an estate Payment with no tag needs an explicit acknowledgement.

## A8: vault details the spec leaves open (§4.2). Decided by Claude.

- **Minimum passphrase length:** 12 characters, enforced when a vault is
  saved. Passphrases must be text and are Unicode-normalised (NFKC) before
  scrypt. The length is counted after normalisation.
- **Address book:** stored per account, as §4.2 lists it under "per account".
  Each entry has a label, an address, and the flags `isExchange` and
  `requiresTag` (used by the §4.8 destination-tag check).
- **Address book:** each address appears at most once per account, so an
  earlier entry can't hide a later entry's exchange or tag flag.
- **Schema:** the vault payload has a strict schema. Any unexpected field is
  refused, and any field whose name contains "spare" is refused with a
  specific error. On every open, each stored seed must re-derive its stored
  public key and address.

## A9: what the plain `sign` purpose may contain. Approved by owner.

`sign` accepts exactly one `Payment` or `AccountSet`, matching the Send and
AccountSet flows in §5.4. These are refused under `sign`:

| Type | Use this purpose instead |
|---|---|
| `SetRegularKey` | `rotate`, `send-rotate`, `recovery`, `migration` |
| `SignerListSet` | `replace-spare`, `migration` |
| `AccountDelete` | `migration` |

**Why:** if `sign` allowed them, a compromised online machine could send a
plain signing request that sets the regular key or the signer list to an
address it controls. That would bypass §0 principle 1: new keys are generated
offline. The stricter reading is easy to loosen if the owner prefers.
Folded into SPEC.md §5.3.

## A10: order of migration transactions (§4.9). Found in review; approved by owner.

§4.9 signs every migration transaction with the shared regular key. When a
`SetRegularKey` validates, the shared key stops signing for that account. A
later `SignerListSet` signed with it would fail with `tefBAD_AUTH`. So each
kept account must have:

- a `SignerListSet` at Sequence N, then
- a `SetRegularKey` at Sequence N+1.

This also puts the spare on the ledger before the key changes. A small account
has exactly one `AccountDelete`. The offline side refuses any other shape.
Folded into SPEC.md §4.9 and §4.4.

## A11: deleting a signer list is not possible (§3). Approved by owner.

The spare signer list is the only Recovery and Estate path once the master
key is disabled. So no purpose can produce a signer-list deletion:
`replace-spare` and `migration` only accept a quorum-1 template, and `sign`
refuses `SignerListSet` (A9). The §3 typed-confirmation check stays in
`safety.js` as a second line of defence. Folded into SPEC.md §3.

## A12: longer expiry window for migration (§5.3). Approved by owner.

Migration involves writing spare seeds on paper and typing them back. So the
`migration` envelope's `LastLedgerSequence` window defaults to about
**3 hours**. Every other purpose stays at about 1 hour. Both stay
configurable. The online builder applies this in Phase 3. Folded into
SPEC.md §5.3.

## A13: Seed Repair (§4.7). Approved by owner.

v2 has no seed-repair code, so v3 defines it. When a typed seed fails its
checksum:

- Characters that are never valid are highlighted straight away. The XRPL
  alphabet has no `0`, `O`, `I` or `l`.
- Every single-character fix is tried:
  - a substitution, including a case change
  - a swap of two adjacent characters
  - a deleted character
  - an inserted character
- Each candidate is checked with the pinned `ripple-address-codec` checksum.
  That's about 3,600 checks, well under a second.
- Candidates that pass are listed with the address each one derives. A 32-bit
  checksum makes a false match about 1 in 4 billion per candidate.
- In Recovery and Estate, a candidate whose address is in the ledger's signer
  list is highlighted. The user still picks it and confirms.
- Seed Repair is a tool of its own, and it also runs inside Recovery, Estate
  Transfer and Migration whenever a typed seed fails.
- **Not** when typing back a spare that was just written down (Replace Spare,
  Migration). There, the paper itself must be right. A mistake has to be fixed
  on the card, so the card can be shown again and must then match exactly.
  (Phase 2 review.)
- Input shorter than 28 or longer than 32 characters is not repaired, since
  one edit can't turn it into a seed.

## A14: where Recovery puts the new key (§4.6 step 3). Approved by owner.

- If a vault for the same network is open, the new key is added to it.
  Otherwise a new vault is made.
- The new key is stored as `pendingKey`, and the A2 gate runs before the signed
  QR is shown. The user picks the saved file back in, and it must decrypt and
  contain the key. That way, a download that failed can't lead to a key change
  to a key nobody saved.
- The next envelope's ledger snapshot then promotes the pending key (§4.5).

## A15: Migration saves through the A2 gate (§4.9). Approved by owner.

- The shared key can be typed, or scanned from paper with the offline webcam
  (§4.9 step 1).
- Every kept account's new key goes into one new vault, as `pendingKey`, with
  its label.
- The gate checks all the pending keys in a single decrypt before any signed
  QR is shown.

## A16: QR formats across the gap (§1, §5.3). Decided by Claude, reviewed by Gemini.

- **Envelope, online to offline:** each QR holds the text
  `IC3E:<id>:<i>/<n>:<chunk>`.
  - `<id>` is the first 16 hex characters of the SHA-256 of the whole envelope
    JSON (UTF-8).
  - The chunks are consecutive pieces of that JSON. `1 <= i <= n <= 64`.
  - Parts can be scanned in any order. Parts with another `<id>` are refused,
    so two envelopes can never be spliced together.
  - After the last part, the joined text must hash back to `<id>`.
  - A small envelope is a single `1/1` part. The chunk size is set by testing
    the real webcam (§5.3); it starts at 800 characters.
- **Signed transaction, offline to online:** one QR per transaction, holding
  only the signed blob in upper-case hex, so any XRPL tool can read it. The
  screen numbers them ("2 of 3"). The online side matches each one by hash
  (§5.5).
- **Secret on paper, scanned only by the offline webcam:** the seed text
  itself.
- **No paste or typed input for envelopes.** §1 says unsigned data comes in by
  QR, and the offline machine has nothing to paste from. Decode / Verify still
  takes typed hex, because that's what the tool is for.

## A17: idle lock warning (§4.2). Approved by owner.

- Copying a spare by hand can take minutes with no key pressed. So for the last
  60 seconds before the 5-minute lock, a large countdown is shown; any key or
  click resets the timer.
- Locking, and every "done" after signing, does all of this:
  - wipes the key objects
  - clears every input
  - removes any displayed seed from the page
  - stops the camera
  - drops the open vault from memory
- Every secret input has `autocomplete="off"`, `spellcheck="false"` and
  `autocapitalize="off"`.

## A18: QR libraries and rendering (§4.1). Decided by Claude.

- **jsQR 1.4.0** decodes, as in v2. **qrcode-generator 2.0.4** encodes. It has
  no dependencies.
- Neither library uses `Math.random` or any network API (checked at install).
- QR codes are drawn onto a `<canvas>` from the module matrix, with a white
  quiet zone. The library's `<img>` (a `data:` URL) and `<table>` (inline
  `style` attributes) outputs are not used, so the Phase 1 CSP stays unchanged.

## A19: when the passphrase is asked for during signing (§4.4). Decided by Claude.

The summary card (step 3) names accounts and destinations by their vault
labels, so the vault must be open before it is shown. So:

- The vault is opened with its passphrase first.
- After the summary and acknowledgements, step 5 asks for the passphrase
  again. It is checked by decrypting the vault file again before anything is
  signed. This keeps the spec's order, and the second entry is a real check.
- After every signing, **Done** wipes the keys and inputs and locks the vault
  (§4.2: "secrets are wiped ... after each signing").
- Send & Rotate and Rotate use that one step-5 passphrase for everything:
  saving the vault, the A2 gate, and signing (§4.5: "one passphrase").

## A20: Online Builder form and placement (§5.1). Approved by owner.

- **One codebase:** a single self-contained page, `dist/icecold-v3-online.html`,
  plain JavaScript like the offline signer, built by the same command.
- **Explorer tab:** the explorer's "Cold Storage" tab shows that exact file in
  an `<iframe allow="camera">`, pinned by its SHA-256. This keeps the
  builder's CSP and styles separate from the explorer. It's added on a new
  explorer branch at the end of Phase 3.
- **GitHub Pages:** a manual-only workflow publishes both HTML files and their
  `.sha256` files. It is not switched on until the owner says so.
- **Library:** xrpl.js 5.3.0, the same pinned version the tests use, for the
  WebSocket connection to the ledger. The online page also disables
  `Math.random` after it loads.

## A21: servers, fees, expiry and reserves (§5.2, §5.3). Decided by Claude, reviewed by Gemini.

- **Servers:** a fixed list per network, tried in order until one connects.
  - Mainnet: `wss://xrplcluster.com`, `wss://s1.ripple.com`, `wss://s2.ripple.com`
  - Testnet: `wss://s.altnet.rippletest.net:51233`, `wss://testnet.xrpl-labs.com`
  - The page's CSP allows connections only to these addresses.
- **Fee:** the `fee` command's `open_ledger_fee`, in drops. A multi-signed
  transaction pays it × 2 (one signer, §4.6). AccountDelete pays the owner
  reserve.
  - If the network fee is over the offline cap, the builder refuses and says
    to wait. It never sets a fee below what the network needs.
- **Expiry:** `LastLedgerSequence` = the validated ledger + 900 (about 1 hour),
  or + 2,700 for Migration (about 3 hours, A12). `builtAt` is that validated
  ledger's index and close time.
  - The window is configurable (§5.3): the Build screen takes 10–360
    minutes, at 4 s per ledger.
- **Destinations:** a destination that doesn't exist on the ledger is refused
  by design, since sending to it could fail or need a larger first payment.
  A destination with `lsfRequireDestTag` needs a tag.
- **Spendable balance:** Send and Send & Rotate refuse an amount that would
  dip into the reserve once all fees are paid (two fees for Send & Rotate).
- **Connection:** only the latest network switch wins. A slower earlier
  connection is closed and discarded, and every build and submit checks that
  the live connection is on the selected network. (Phase 3 review.)
- **Reserves:** read from `server_state` in drops, so no decimals are rounded.
  An account's reserve = base reserve + `OwnerCount` × owner reserve. An
  account with a signer list holds one object, so its reserve is currently
  1.2 XRP.
- **Estate amount:** balance − account reserve − fee, refused if that is zero
  or less. The destination tag is required by default (§6).

## A22: checking signed transactions before submitting (§5.5). Decided by Claude, reviewed by Gemini.

A signed hash can't be known before offline signing, and templates are filled
in offline. So each scanned blob is checked like this:

- `verifySignedBlob` must pass: canonical encoding, every signature valid.
- Every field the builder set must be unchanged.
- The only allowed additions are the signature fields (`SigningPubKey`,
  `TxnSignature`, `Signers`) and, for a template, the one field filled in
  offline: `RegularKey`, or `SignerEntries` with exactly one entry of weight 1.
- Any other difference is refused.
- The filled-in key or spare address is kept for the post-checks.
- After submitting, the validated transaction must have the hash computed
  from the blob.
- Any `tem`, `tef` or `tel` result fails at once; `telCAN_NOT_QUEUE*` means the
  network dropped it. After `LastLedgerSequence` passes, the transaction is
  looked up once more before it's called expired.
- **The result screen is green only when every transaction is `tesSUCCESS`
  and every post-check passes.** Otherwise it lists each transaction that
  failed or was held back, then says whether the ones that succeeded passed
  their checks. (Phase 3 review.)
- **Submission order:**
  - Send & Rotate submits the key change only if the payment used up its
    sequence (`tesSUCCESS` or `tec`, §5.5).
  - Migration submits an account's `SetRegularKey` only if its
    `SignerListSet` was `tesSUCCESS`. A `tec` would use up the sequence, and
    the key change would then land with no spare.
- **Post-checks:**
  - After a rotation or recovery, the ledger's `RegularKey` equals the new key.
  - After Replace Spare, the signer list holds the new spare.
  - After migration, no kept account still has the shared key, every signer
    list holds its spare, and every deleted account is gone.

## A23: watch-only list and the secret guard (§5.2, O-4). Approved by owner.

- **Watch-only list (O-4 resolved):** labels and public addresses only, in
  `localStorage`, one list per network so mainnet and testnet never mix.
  A **Clear** button empties it. Nothing else is stored.
- **Secret guard:** every text input checks what is typed or pasted. If it is
  a valid seed, the field is cleared at once, and a warning says the key
  should be treated as compromised because it was typed on an online machine.
- The built envelope is kept in page memory only, so it can be compared when
  the signed QR codes come back.

## A24: what blocks deleting a small account (§5.4). Decided by Claude, reviewed by Gemini.

The migration wizard lists every object from `account_objects`, all types, and
blocks deletion until all of these hold:

- The account has a regular key, the shared one, to sign the AccountDelete.
- The leftovers account exists, is kept, and doesn't require a tag.
- Every small account is checked, and all their blockers are listed together.
- `OwnerCount` is 0 apart from objects the ledger removes itself (offers,
  tickets, signer list, deposit preauthorisations). Escrows, payment channels,
  checks, trust lines and NFT pages must be cleared by hand; the wizard says
  which ones.
- `Sequence` + 256 ≤ the current ledger index.
- The balance is more than the AccountDelete fee (the owner reserve).
- The destination is a kept account.

## A25: printing (§4.7, §6). Decided by Claude, reviewed by Gemini.

- **Blank Spare Key Card:** the account label, a line for the spare's
  address, and 31 boxes grouped 4-4-4-4-4-4-4-3, the length of an Ed25519
  seed. Each box has an upper/lower mark to circle.
- **Estate letter and helper appendix:** the text §6 lists, the GitHub Pages
  URLs, and the offline HTML's SHA-256, which is built into the online page at
  build time. Names and the spare's location are typed at print time, or left
  blank to write by hand, and are never stored.

## A26: how the Online Builder is tested (§7.1). Decided by Claude.

- **No network in `npm test`.** A fake ledger (`test/online/mockLedger.js`)
  answers the rippled commands, applies submitted transactions, and checks
  signatures and authorisation. Browser tests use a test copy of the page
  (`dist-test/`, never published) pointed at it.
- **Round trips** in Chromium and Firefox: build online, sign in the offline
  page, submit, post-check. They cover Send & Rotate, Migration and Recovery.
- **`npm run test:testnet`** runs the real builders, the offline signing core
  and the submit code against the live Testnet, using faucet accounts. It's
  optional and run by hand.

## Tooling. Decided by Claude.

- **Build:** esbuild directly, not Vite. One small dependency, deterministic
  output.
- **Tests:** Node's built-in `node:test`, not vitest. vitest 5 needs Node 22,
  and the built-in runner adds no dependency.
- **QR libraries:** see A18.
- **UI:** plain JavaScript with no framework. Every value is shown with
  `textContent`; there is no `innerHTML` and no inline style. A test checks
  that markup inside an envelope stays text.
- **End-to-end tests** drive every screen in headless Chromium and Firefox,
  using a fake camera that the tests inject. The built file has no test hook.

## Known limitations

- **Secret wiping (§4.2):** JavaScript cannot guarantee memory is erased. The
  core zeroes byte arrays it owns and drops references, and the UI will clear
  inputs. Seed strings may remain in memory until garbage collected.
- **scrypt cost:** N = 2^16 needs about 64 MiB, which the signing machine handles.
  The default was set from timings measured on it (O-1). N is stored in each vault file, so changing the default later does
  not break existing vaults.
