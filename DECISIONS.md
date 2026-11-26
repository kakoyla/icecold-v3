# Decisions log

SPEC.md is authoritative. This file records how ambiguities in it were resolved
and choices the spec leaves open. Nothing here changes the spec. Approved
wording was folded into SPEC.md on 2026-11-25; entries say where.

## Open item O-1: signing-machine browser (interim)

- The signing machine's stock browser is Firefox 58, which has no `BigInt`.
  The §4.1 libraries (`@noble/*`, `ripple-keypairs` 3.x) require it, so they
  cannot run there. This also explains the v2 "checksum failed" error.
- **Plan:** run a portable Firefox ESR 140.17.0 (32-bit Linux) next to the
  stock browser, brought in on the read-only USB stick and hash-checked as §1
  requires. It is verified against Mozilla's signed SHA256SUMS but not yet
  installed on the machine.
- **Build target:** `firefox140`, set in one place: `build.config.js`.
- **Still open:** O-1 closes after the probe page passes on the machine itself.
  The interim plan is noted in SPEC.md §9.

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
- **scrypt cost:** N = 2^17 needs about 128 MiB, and the signing machine has limited
  RAM. The default stays N = 2^17 until the probe measures real
  timings. N is stored in each vault file, so changing the default later does
  not break existing vaults.
