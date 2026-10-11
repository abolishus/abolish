# ADR 0017: Voting-identity recovery backup

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option A, with option B as the fallback where the PRF is unavailable
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-20, T-10, T-18, T-11, T-41, T-66, T-69, T-52 (see [[THREAT_MODEL]])

## Context

The brief: the voting identity (the Semaphore secret, [[0009-membership-proof]]) never leaves the device, and "is encrypted with a key derived via the WebAuthn PRF extension for cross-device recovery". It says nothing about where the encrypted copy lives, which credential the PRF comes from, or how a new device finds the copy. Those choices decide whether the operator can join an account to a voting identity, which T-20 marks **Needs design** for this item, and whoever holds the secret can recompute every nullifier the voter ever produced (T-18, [[membership]]).

How the PRF behaves (W3C Web Authentication Level 3, `prf` extension; CTAP 2.1 `hmac-secret`):

- During a WebAuthn ceremony the client passes a salt; the authenticator returns 32 bytes, `HMAC-SHA-256(credential secret, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt))`. The output is fixed per credential and salt, and never leaves the client unless the page sends it.
- A credential is bound to a relying party ID (RP ID): the page's host or a registrable suffix of it. A page on one host can't evaluate a credential of an RP ID that isn't its host or a suffix of it, unless that RP ID's `/.well-known/webauthn` lists the page's origin (Related Origin Requests).
- Synced passkeys (iCloud Keychain, Google Password Manager and other providers) carry the credential secret to the user's other devices, so the same salt gives the same output there. Hardware security keys support `hmac-secret` without syncing. Support for `prf` varies by browser, platform and authenticator, and a client can only learn it by trying.

So whoever runs a page on the credential's RP ID can ask for the PRF output when the user next authenticates. That page is the trust boundary, not the server's storage.

What is one-way: a backup format and the key derivation must stay readable for as long as any voter relies on them, and an RP ID can't be changed for existing credentials: moving it orphans every backup made under the old one.

## Options

### A. A separate backup passkey on the ballot client's RP ID; the ciphertext stored by us under a locator derived from the PRF

1. **Credential.** The ballot client (`apps/ballot`) creates a discoverable passkey of its own, never the account passkey (better-auth, `apps/web`). Its RP ID is the ballot client's own host, which no `apps/web` origin is or has as a suffix, so `apps/web` can't evaluate it. Its user handle is 32 random bytes and its user name a fixed generic label, never an account identifier or anything the voter types, so the credential carries nothing that names the account, in our storage or in the passkey provider's. The ballot host's `/.well-known/webauthn` may list only origins that serve the same signed ballot client release (P4-4's mirrors), never `apps/web`.
2. **Keys.** One PRF evaluation, with a fixed salt that a domain tag defines, gives 32 bytes. HKDF-SHA-256 (RFC 5869) under registered tags derives two independent values from it: a wrap key and a locator. Neither is ever stored or sent except as below.
3. **Envelope.** The secret goes into a fixed-length, versioned plaintext record, sealed with an AEAD under the wrap key with a fresh random nonce. The associated data binds the version and the locator, so an envelope moved to another locator doesn't open. Every envelope of a version has the same length.
4. **Storage.** The ballot client stores the envelope through the API's ballot path, which carries no account session, cookie or token (T-10). A request presents the locator; the server keeps the row under `id = H(tag, locator)`, so a copy of the table (a leak, a seizure) can't be used to read, overwrite or delete a row. Only a holder of the locator can replace or delete its envelope. The table is operational, has no account column and no timestamp beyond what the expiry rule needs, and the request log keeps only the route (T-10). Envelopes are never put on the board, IPFS or the archive.
5. **Recovery.** On a new device the ballot client asks for any discoverable credential of its RP ID, evaluates the PRF with the fixed salt, derives the locator and key, fetches and opens the envelope, recomputes the identity commitment and checks it against the tier groups it downloads in full, never by asking a server about one commitment (T-11; [[revoting]], Client rule 4, applies the same rule to L1 blocks).

- Pros:
  - The server holds a pseudonymous id and a ciphertext. Joining the id to an account (through timing or addresses, T-11) gives nothing usable: opening the envelope needs the PRF output, and only a page on the ballot RP ID can get it. That page already has the secret in the device's storage, so a malicious ballot client (T-41) learns nothing from the backup it couldn't read directly; the backup adds no new holder of the secret.
  - `apps/web`, the larger codebase, with SSR, the account system and PostHog, is outside the boundary entirely (T-20, T-67).
  - Recovery needs only the synced passkey, as the brief asks: no file, no code to keep.
  - The key is 256 bits from an HMAC, not from a password: there is nothing to brute-force offline, and a quantum adversary (A-11) faces only Grover against the AEAD key.
- Cons:
  - Anyone can write rows (the ballot path is anonymous by design), so storage can be flooded (T-52). Rows are fixed-size and small; per-address limits sit at the proxy (P2-11). No Turnstile: the ballot client ships no third-party code.
  - Wiping Postgres loses every backup (T-66). Backups affect no result, so the brief's invariant holds, but a voter who then loses their device loses their identity unless they also kept option B's code.
  - The passkey provider (Apple, Google, a password manager) holds both the account passkey and the backup passkey in one user's vault. It can't evaluate either without the user, and the backup passkey names nothing, but it knows the user has one.
  - Recovery works only on the ballot RP ID and the origins its `/.well-known/webauthn` lists. A mirror outside that list (an IPFS gateway, P4-4) can still vote with a secret already on the device, but can't recover one.

### B. User-held only: a recovery code the voter keeps

The ballot client shows the secret once as a recovery code (the fixed-length record in a human-transcribable encoding with a checksum), and nothing is stored by us. The voter restores by typing or scanning it.

- Pros: no operator storage at all, so nothing to seize, flood or wipe. Works on every device, with or without PRF support.
- Cons: not what the brief specifies (a PRF-derived key for cross-device recovery). Most people lose such codes, or keep them where others find them: the code is the secret, so anyone who sees it can vote as the voter and recompute their nullifiers (T-18), and a coercer can demand it as easily as the device (T-46). Encrypting the code under the PRF key would bring back A's credential without A's convenience.

### C. The ciphertext keyed by the account, with the PRF from the account passkey

`apps/web` evaluates the account passkey's PRF at login and stores the envelope with the account.

- Pros: one passkey, the simplest flow.
- Cons: exactly what T-20 describes. Every page on the account's RP ID (all of `apps/web`, its dependencies and its analytics proxy) can evaluate the PRF during an ordinary login, and the server holds the envelope next to the account, so one malicious or compelled deploy of `apps/web` (A-2, A-1, T-69) links accounts to every nullifier. It also puts the voting identity under the larger, less-reviewed codebase.

Also considered: the `largeBlob` extension (store the secret in the authenticator itself, no server copy). Support is uneven across platforms and it has no fallback when the provider doesn't sync blobs, so it doesn't meet "cross-device recovery" for most voters today. A later version can add it as a third copy.

## Recommendation

**Option A, with option B offered where the PRF is unavailable.** A gives what the brief asks for, cross-device recovery from the passkey alone, and keeps the backup inside the same trust boundary as the secret on the device: only the ballot client's RP ID can open it, and that origin already holds the secret, so the backup adds no new party able to read it. What the server keeps is useless without a PRF evaluation it can't make. C is rejected (T-20). B on its own fails the brief and most voters, but as the fallback it keeps voters with no PRF support from having no recovery at all, and any voter may also take it alongside A to survive a database wipe.

What would change it: browsers letting another origin evaluate a credential's PRF without the RP ID's consent (that would break the boundary A rests on); the ballot client and `apps/web` having to share an origin (then A loses its separation and the backup must move to the native app, P5-2); or the owner preferring no operator-held backups at all (B alone).

## Consequences

- T-20 moves to **Planned**: the design is here; the spec, code and tests are P2-6's later parts. Its residual is T-41, as before: whoever serves the ballot client can read the secret, with or without the backup.
- P2-6 continues in parts on `claude/p2-6`:
  1. This ADR.
  2. `docs/spec/identity-backup.md` and `packages/crypto`: the PRF salt, the HKDF tags, the plaintext record, the envelope and its strict decoder, the locator id, and the recovery code, with cross-language vectors from an independent implementation. It uses the ChaCha20-Poly1305 of RFC 8439 that P1-12 part 2 (#58) brings in with `@noble/ciphers`, so it waits for that PR.
  3. Storage: the operational table in `packages/core` (no account column; classed in the T-10 no-join test), the ballot-path procedures in `packages/api-contract` and `apps/api` (put, get and delete by locator, fixed body size, no session), and a test that a request carrying an account cookie or token is refused rather than ignored.
  4. The ballot client's flows (create the credential, back up, recover, offer the code) come with `apps/ballot` (P2-8), which must also test that its `/.well-known/webauthn` lists no `apps/web` origin.
- Envelopes are never archived, mirrored or anchored. A voter can delete theirs.
- Expiry: rows are operational state. Part 3 decides an expiry rule that doesn't need a per-row access time the server would otherwise not keep.
- The ballot client is the only place the secret, the PRF output and the derived keys exist, and they are `packages/crypto` APIs the client calls (AGENTS.md, Architecture), so the code that touches them stays inside the `crypto-review` gate.
- Out of scope here, and still open for T-18: revoking a stolen identity and re-registering. At Tier 2 the uniqueness nullifier lets one document register once ([[0010-tier2-identity-provider]]), so a voter who loses both the device and every backup loses Tier 2 until that design exists. P2-6 records it as a follow-up.
- Ballot receipts stay on the device only; a lost device loses them, which affects only that voter's own checks (G-7), never a result.

## Decision

Under rule A (`AGENTS.md`): option A, with option B as the fallback where the PRF is unavailable, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
