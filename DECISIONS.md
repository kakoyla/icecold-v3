# Decisions log

SPEC.md is authoritative. This file records how ambiguities in it were resolved
and choices the spec leaves open. Nothing here changes the spec. Entries marked
**spec wording proposed** are waiting for the owner to fold them into SPEC.md.

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
  **Spec wording proposed:** "Firefox ESR 140.17.0, 32-bit Linux, portable copy."

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

## A4: AccountDelete fee cap needs the owner reserve (§4.8). Delegated to Claude.

The envelope (§5.3) carries a network-wide `ownerReserveDrops` field. The
AccountDelete cap is `ownerReserveDrops + 1000` drops. **Spec wording
proposed** for §5.3.

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
  | `AccountSet` | `SetFlag`, `ClearFlag`, `Domain`, `EmailHash`, `MessageKey`, `TransferRate`, `TickSize`, `NFTokenMinter` |
  | `AccountDelete` | `Destination`, `DestinationTag` |

- Any other field, including `Memos` and `TicketSequence`, blocks signing until
  the user acknowledges it.
- Refused outright, with no acknowledgement possible:
  - `Paths`, `SendMax` and `DeliverMin` (§3)
  - `DeliverMax` (an alias of `Amount`)
  - `NetworkID`, which is invalid on mainnet and testnet
  - `TxnSignature` and `Signers` on an unsigned input

## A6: envelope carries ledger time for the expiry estimate (§4.8). Decided by Claude.

To show an "estimated expiry time", the envelope carries
`builtAt: { ledgerIndex, closeTime }`. Expiry is estimated as
`closeTime + (LastLedgerSequence - ledgerIndex) x 4 s`, which is shown as an
estimate. **Spec wording proposed** for §5.3.

## A7: Estate payments without a destination tag need acknowledgement. Decided by Claude.

§6 says `DestinationTag` is required by default for Estate. The offline side
mirrors this: an estate Payment with no tag needs an explicit acknowledgement.

## A8: vault details the spec leaves open (§4.2). Decided by Claude.

- **Minimum passphrase length:** 12 characters, enforced when a vault is
  saved. Passphrases are Unicode-normalised (NFKC) before scrypt.
- **Address book:** stored per account, as §4.2 lists it under "per account".
  Each entry has a label, an address, and the flags `isExchange` and
  `requiresTag` (used by the §4.8 destination-tag check).
- **Schema:** the vault payload has a strict schema. Any unexpected field is
  refused, and any field whose name contains "spare" is refused with a
  specific error. On every open, each stored seed must re-derive its stored
  public key and address.

## A9: what the plain `sign` purpose may contain. Decided by Claude; needs owner review.

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
**Spec wording proposed** for §5.3.

## A10: order of migration transactions (§4.9). Found in review; spec wording proposed.

§4.9 signs every migration transaction with the shared regular key. When a
`SetRegularKey` validates, the shared key stops signing for that account. A
later `SignerListSet` signed with it would fail with `tefBAD_AUTH`. So each
kept account must have:

- a `SignerListSet` at Sequence N, then
- a `SetRegularKey` at Sequence N+1.

This also puts the spare on the ledger before the key changes. A small account
has exactly one `AccountDelete`. The offline side refuses any other shape.
**Spec wording proposed** for §4.9 and §4.4.

## Tooling. Decided by Claude.

- **Build:** esbuild directly, not Vite. One small dependency, deterministic
  output.
- **Tests:** Node's built-in `node:test`, not vitest. vitest 5 needs Node 22,
  and the built-in runner adds no dependency.
- **QR libraries:** QR encoder/decoder are pinned when Phase 2 (UI) needs them,
  so Phase 1 ships no unused code.
- **Seed repair and the full signing screens** are Phase 2 (UI).

## Known limitations

- **Secret wiping (§4.2):** JavaScript cannot guarantee memory is erased. The
  core zeroes byte arrays it owns and drops references, and the UI will clear
  inputs. Seed strings may remain in memory until garbage collected.
- **scrypt cost:** N = 2^17 needs about 128 MiB, and the signing machine has limited
  RAM. The default stays N = 2^17 until the probe measures real
  timings. N is stored in each vault file, so changing the default later does
  not break existing vaults.
