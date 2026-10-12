# Identity backup

How a voter's voting identity is backed up for recovery on another device, as [[0017-identity-recovery-backup]] (option A) decides: the identity secret and its encoding, the WebAuthn PRF salt, the keys derived from the PRF output, the envelope (record type `0x000a`) and its strict decoding, the locator the client presents and the row identifier the server keeps, and how a client opens an envelope. Notation is from [[notation]], `H` from [[group]], the secret's statement from [[membership]]. Threats: T-18, T-20, T-10, T-11, T-41, T-52, T-66.

The backup is operational data, never part of an election: it is never on the board, the chain, IPFS or the archive, and no verifier reads it. Only the ballot client ever holds the secret, the PRF output or a key derived from it, and it uses only the `packages/crypto` functions that implement this page (AGENTS.md, Architecture).

What this page doesn't cover:

- **Storage:** the server's table, the ballot-path procedures and the expiry rule (P2-6 part 3).
- **The client's flows:** creating the backup passkey, backing up, recovering, and checking the recovered identity's commitment against the tier groups (P2-8, under [[0017-identity-recovery-backup]], Option A, steps 2, 6 and 7).

## Sources

- **WebAuthn PRF:** W3C Web Authentication Level 3, the `prf` extension (https://www.w3.org/TR/webauthn-3/#prf-extension), over CTAP 2.1's `hmac-secret` (https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#sctn-hmac-secret-extension). The authenticator returns `HMAC-SHA-256(CredRandom, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt))`, with one `CredRandom` for evaluations with user verification and another without.
- **HKDF:** RFC 5869 with SHA-256, from `@noble/hashes`, checked against RFC 5869's Appendix A.1 to A.3 (`packages/crypto/test-vectors/rfc/rfc5869.txt`).
- **ChaCha20-Poly1305:** RFC 8439, §2.8, from `@noble/ciphers`, checked against RFC 8439's own vectors ([[share-encryption]], Sources).
- **The secret:** Semaphore v4's identity secret, the Baby Jubjub scalar `s` of [[membership]], Statement (EIP-2494).

## Identity secret

The voting identity is the scalar `s` of [[membership]], Statement: an integer with `1 ≤ s < l`, where `l` is the order of Baby Jubjub's prime subgroup. Its identity commitment is `Poseidon2(s · B8)`. The secret is the scalar itself, not the private key Semaphore's JavaScript `Identity` hashes into one, so a tool that takes such a private key can't import an Abolish identity, and the identity is used for nothing but Abolish membership proofs ([[membership]], Security notes; T-12).

**Encoding.** `identity_secret` is 32 bytes, `s` big-endian. An encoding of 0, or of a value at or above `l`, is not an identity secret. `s = 0` is the public secret whose commitment [[membership]] forbids, and a value at or above `l` is refused by the circuit, so neither can vote.

**Generation.** The ballot client draws 32 bytes from the CSPRNG, clears the top 5 bits (so the value is below 2²⁵¹, and `2²⁵⁰ < l < 2²⁵¹`), and keeps the value if `1 ≤ v < l`; otherwise it draws again. Each draw is kept with probability `(l − 1) / 2²⁵¹`, about 0.76, so `s` is uniform on 1 to `l − 1` (T-18).

## PRF salt

```
prf_salt = H(DS("abolish/v1/identity-backup/prf-salt", ""))
```

32 bytes, the same for every voter and every release of version 1. The client passes it as `extensions.prf.eval.first` in every ceremony with the backup passkey, with `userVerification: "required"`, and continues only if the authenticator data's UV flag is set, so backup and recovery use the same `CredRandom` ([[0017-identity-recovery-backup]], Option A, step 2). It continues only if `results.first` is exactly 32 bytes: that output is `P`. A fixed salt is what lets a new device, holding only the synced passkey, derive the same keys.

## Keys

From `P`, HKDF-SHA-256 (RFC 5869) with an empty salt (so `HashLen` zero bytes, §2.2), under two tags:

```
wrap_key = HKDF(IKM = P, salt = "", info = DS("abolish/v1/identity-backup/wrap-key", ""), L = 32)
locator  = HKDF(IKM = P, salt = "", info = DS("abolish/v1/identity-backup/locator",  ""), L = 32)
id       = H(DS("abolish/v1/identity-backup/id", locator))
```

`P` is an HMAC output, already uniform, so HKDF's extract step needs no salt. The two `info` strings differ, so the expand step makes `wrap_key` and `locator` independent: the server learns `locator` and nothing about `wrap_key` from it (T-20).

- `wrap_key` never leaves the client.
- `locator` is what the client presents to the server to put, get or delete its envelope. Only a holder of `P` can compute it.
- `id` is the row's key on the server, recomputed from the presented `locator`. A copy of the table (a leak, a seizure) gives only `id`s, from which no `locator` can be found, so it can't be used to read, replace or delete a row (T-66, T-52).

The client derives `P`, `wrap_key` and `locator` only when it needs them, and overwrites them once the request or the decryption that needed them is done. None of them is logged, stored or sent, except `locator` in a request (T-41).

## Envelope

Record type `0x000a` ([[versioning]]), version 1. Never on the board, the chain or the archive.

| Field    | Type        | Meaning                                                                              |
| -------- | ----------- | ------------------------------------------------------------------------------------ |
| `nonce`  | `bytes[12]` | The AEAD nonce, 12 bytes from the CSPRNG, fresh for every seal                       |
| `sealed` | `bytes[48]` | `ChaCha20-Poly1305.Seal(wrap_key, nonce, aad, identity_secret)` with its 16-byte tag |

The encoding is the record header, then the fields: 63 bytes, the same for every envelope of version 1, so an envelope's length says nothing about its contents. A strict decoder rejects any other length (`truncated`, `trailing-bytes`), another record type (`unknown-record-type`: where an envelope is read, `0x000a` is the only type its decoder knows, as for [[receipts]]) or a version it doesn't know (`unknown-version`), as [[notation]] says. Version 1 is the version this release pins; an envelope belongs to no election, so no election profile pins it.

```
aad = DS("abolish/v1/identity-backup/aad", u16(0x000a) ‖ u8(1) ‖ locator)
```

The associated data binds the record type, the version and the locator, so an envelope opens only as the version it says it is and only under the locator it was stored at ([[0017-identity-recovery-backup]], Option A, step 4). Its key already depends on `P`, so this is defence in depth: no one without `P` can make or open an envelope at all.

**Sealing.** The client computes `P`, then `wrap_key` and `locator`, draws `nonce`, seals the 32-byte `identity_secret` and stores the envelope under `locator`. A new backup of the same identity, or of a new one, with the same passkey gives a new nonce and replaces the stored envelope. With random 96-bit nonces, a voter would have to seal about 2³² times under one passkey before two nonces repeat with probability 2⁻³³, and a client seals once per backup, not per vote.

**Opening.** The client computes `P`, `wrap_key` and `locator`, fetches the envelope stored under `locator`, decodes it strictly and opens `sealed` with `nonce` and `aad`. It fails with:

| Code            | Meaning                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a decode error  | The bytes aren't a version-1 envelope ([[notation]], Strict decoding)                                                                                                     |
| `backup-open`   | The tag doesn't verify: another passkey, another locator, or an envelope that was altered                                                                                 |
| `backup-secret` | The tag verifies but the plaintext isn't an identity secret (0, or at or above `l`). Only a client holding `wrap_key` can make one, so it is a client bug, never accepted |

An envelope that opens gives `s`. The client then recomputes the identity commitment and checks it against the tier groups it downloads in full, never by asking a server about one commitment, and refuses a secret whose commitment is in none of them ([[0017-identity-recovery-backup]], Option A, step 6; T-11, T-18). That check is P2-8's.

## Test vectors

`docs/spec/vectors/identity-backup.json`, from an independent Python implementation (`packages/crypto/scripts/identity-backup-vectors.py`, with its own HKDF over Python's `hmac` checked against RFC 5869 Appendix A.1 to A.3, and the ChaCha20-Poly1305 of `share-encryption-vectors.py`, written from RFC 8439 and checked against its vectors): the PRF salt; identity-secret encodings at every boundary; for several PRF outputs, secrets and nonces, the keys, locator, `id`, associated data and envelope; envelopes that fail to open (another PRF output, every field altered, a non-canonical plaintext); and decode rejections.

## Security notes

- **Who can open a backup.** Anyone who can make the backup passkey's authenticator evaluate the PRF with user verification, which only code inside its RP ID's boundary can ask for ([[0017-identity-recovery-backup]], Cons): whoever serves the ballot RP ID, on any device the passkey syncs to (T-41), and whoever takes over the voter's passkey provider account and enrols a device of their own (T-18). The server alone holds `id` and the envelope, which give nothing.
- **No offline guessing.** `P` is 256 bits from an HMAC under a key the authenticator holds, so there is no password to guess. A quantum adversary (A-11) faces Grover's search over the 256-bit `wrap_key`.
- **Fixed size.** Every version-1 envelope is 63 bytes, and every request carries a 32-byte locator, so sizes reveal nothing about the voter.
- **No recovery without the passkey.** A voter whose passkey is lost, or whose authenticator doesn't support `prf`, has no backup. A wiped database loses every envelope (T-66).
