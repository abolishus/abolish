# ADR 0017: Voting-identity recovery backup

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option A
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-20, T-10, T-18, T-11, T-41, T-46, T-49, T-52, T-66, T-67, T-69 (see [[THREAT_MODEL]])

## Context

The brief: the voting identity (the Semaphore secret, [[0009-membership-proof]]) "never leaves the device. It is encrypted with a key derived via the WebAuthn PRF extension for cross-device recovery." It says nothing about where the encrypted copy lives, which credential the PRF comes from, or how a new device finds the copy. Those choices decide whether the operator can join an account to a voting identity, which T-20 marks **Needs design** for this item, and whoever holds the secret can recompute every nullifier the voter ever produced (T-18, [[membership]]).

How the PRF behaves:

- During a WebAuthn ceremony the client passes a salt, and the authenticator returns 32 bytes: CTAP 2.1's `hmac-secret`, `HMAC-SHA-256(CredRandom, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt))` (W3C Web Authentication Level 3, PRF extension, https://www.w3.org/TR/webauthn-3/#prf-extension; CTAP 2.1, hmac-secret, https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#sctn-hmac-secret-extension). An authenticator keeps two such secrets per credential, one used with user verification (UV) and one without, so the output is fixed per credential, salt and UV state. The output never leaves the client unless the page sends it.
- A credential is bound to a relying party ID (RP ID), a domain. A page can use it if the page's host is the RP ID or a subdomain of it, or if the RP ID's `https://<rp-id>/.well-known/webauthn` lists the page's origin (Related Origin Requests, https://www.w3.org/TR/webauthn-3/#sctn-related-origins). Native apps can use it through the platform's associated-domain files on the same host.
- Synced passkeys (iCloud Keychain, Google Password Manager and other providers) carry the credential to the user's other devices, so the same salt gives the same output there. Some credentials don't sync (a hardware security key, some platform authenticators); authenticator data says which (the backup-eligible and backed-up flags, BE and BS). Support for `prf` varies by browser, platform and authenticator, and a client can only learn it by trying.

So the trust boundary of a PRF-derived key is every page and app that can use the credential's RP ID: the RP ID host, its subdomains, the origins its well-known file lists, and the apps its association files name. What is one-way: a backup format and its key derivation must stay readable for as long as any voter relies on them, and an RP ID can't be changed for existing credentials: moving it orphans every backup made under the old one.

## Options

### A. A separate backup passkey on a dedicated ballot RP ID; the ciphertext stored by us under a locator derived from the PRF

1. **RP ID.** The backup passkey's RP ID is a dedicated host that serves only the ballot client: a stable domain (not an IPFS gateway origin, which changes with every release's CID), on a registrable domain other than `apps/web`'s (so the two are never same-site and no account cookie reaches the ballot client), with no other subdomains served under it and no wildcard DNS. The ballot client is the only code served there.
2. **Credential.** The ballot client creates a discoverable passkey of its own, never the account passkey (better-auth, `apps/web`). Its user handle is 32 random bytes and its user name a fixed generic label, never an account identifier or anything the voter types, so the credential names nothing, in our storage or in the passkey provider's. Both its creation and every evaluation require user verification (`userVerification: "required"`), and the client proceeds only if the authenticator data shows UV, so backup and recovery always use the same PRF secret. If the authenticator data shows the credential can't sync (BE clear) or isn't backed up yet (BS clear), the client tells the voter the backup won't survive this authenticator, and checks BS again on later uses.
3. **Keys.** One PRF evaluation, with a fixed salt that a domain tag defines, gives 32 bytes. HKDF-SHA-256 (RFC 5869) under registered tags derives two independent values from it: a wrap key and a locator. Neither is ever stored or sent except as below.
4. **Envelope.** The secret goes into a fixed-length, versioned plaintext record, sealed with an AEAD under the wrap key with a fresh random nonce. The associated data binds the version and the locator, so an envelope moved to another locator doesn't open. Every envelope of a version has the same length.
5. **Storage.** The ballot client stores the envelope through the API's ballot path, which carries no account session, cookie or token (T-10). A request presents the locator; the server keeps the row under `id = H(tag, locator)`, so a copy of the table (a leak, a seizure) can't be used to read, overwrite or delete a row. Only a holder of the locator can read, replace or delete its envelope. The table is operational, has no account column and no timestamp beyond what the expiry rule needs, and the request log holds only the method, the route, the status and the duration, as for every API request (T-10). Envelopes are never put on the board, IPFS or the archive.
6. **Recovery.** On a new device the ballot client asks for a discoverable credential of its RP ID, evaluates the PRF with the fixed salt (with UV), derives the locator and key, fetches and opens the envelope, recomputes the identity commitment and checks it against the tier groups it downloads in full, never by asking a server about one commitment (T-11; [[revoting]], Client rule 4, applies the same rule to L1 blocks). A credential with no envelope gets a clear answer and a prompt to pick another passkey. The client keeps the backup credential's ID on the device and passes it as an excluded credential, so one device doesn't create a second backup passkey.
7. **Signed boundary.** The RP ID's `/.well-known/webauthn` and any associated-domain files are part of the signed ballot client release (P0-3), list only origins that serve that same release (P4-4's mirrors) and never an `apps/web` origin, and the verifier's served-client check (P1-19) checks the served copies against the release, as it checks the client.

- Pros:
  - The server holds a pseudonymous id and a ciphertext. Joining the id to an account (through timing or addresses, T-11) gives nothing usable: opening the envelope needs a UV-gated PRF evaluation, which only code inside the boundary above can ask for.
  - Inside that boundary the code is the ballot client alone: one signed, hash-addressed build, the same code that holds the secret on the device. `apps/web`, the larger codebase, with SSR, the account system and PostHog, is outside it (T-20, T-67), and the files that could widen it are signed with the client and checked like it.
  - Recovery needs only the synced passkey, as the brief asks: no file, no code to keep, and the secret never leaves the device unencrypted.
  - The key is 256 bits from an HMAC, not from a password: there is nothing to brute-force offline, and a quantum adversary (A-11) faces only Grover against the AEAD key.
- Cons:
  - **The boundary is wider than the device.** Whoever serves the ballot RP ID (A-2, or A-1 by seizing the domain, T-49, T-69) can serve a malicious client on any device the synced passkey reaches, including one where the voter never ran the ballot client, and read the secret from the backup once the voter authenticates there. That is T-41 at a new place: the device's own copy needs the voter to open a malicious client on that device; the backup needs it on any of their devices. A subdomain or dangling DNS record under the RP ID would let a third party in too, which the dedicated-host rule exists to prevent.
  - **The well-known file is served live.** The signed release and P1-19's check catch a served file that differs from the release, but only for someone who checks. A malicious or compelled operator can serve a version listing an `apps/web` origin to one voter at a time, and `apps/web` could then ask for the PRF during a logged-in session, joining that account to the identity. The browser's prompt names the RP ID, which is weak protection.
  - Anyone can write rows (the ballot path is anonymous by design), so storage can be flooded (T-52). Rows are fixed-size and small; per-address limits sit at the proxy (P2-11). No Turnstile: the ballot client ships no third-party code.
  - Wiping Postgres loses every backup (T-66). Backups affect no result, so the brief's invariant holds, but a voter who then loses their device loses their identity.
  - A voter whose authenticator doesn't support `prf` gets no backup at all, and one whose backup passkey doesn't sync gets one that dies with that authenticator.
  - The passkey provider (Apple, Google, a password manager) holds both the account passkey and the backup passkey in one user's vault. It can't evaluate either without the user, and the backup passkey names nothing, but it knows the user has one. Whoever takes over the voter's provider account and enrols a device of their own gets the passkey and passes user verification there, so can open the backup through the ballot client: a route to the secret that didn't exist while it lived only on the device (T-18).

### B. User-held only: a recovery code the voter keeps

The ballot client shows the secret once as a recovery code (the fixed-length record in a human-transcribable encoding with a checksum), and nothing is stored by us. The voter restores by typing or scanning it.

- Pros: no operator storage at all, so nothing to seize, flood or wipe. Works on every device, with or without PRF support.
- Cons: it contradicts the brief, under which the secret never leaves the device, and the brief's properties are the owner's to change. The code is the secret in plaintext, on paper, in screenshots or in photo sync: anyone who sees it can vote as the voter and recompute their nullifiers (T-18), and a coercer can demand it as easily as the device (T-46). Most people lose such codes.

### C. The ciphertext keyed by the account, with the PRF from the account passkey

`apps/web` evaluates the account passkey's PRF at login and stores the envelope with the account.

- Pros: one passkey, the simplest flow.
- Cons: exactly what T-20 describes. Every page on the account's RP ID (all of `apps/web`, its dependencies and its analytics proxy) can evaluate the PRF during an ordinary login, and the server holds the envelope next to the account, so one malicious or compelled deploy of `apps/web` (A-2, A-1, T-69) links accounts to every nullifier, with no per-voter targeting needed. It also puts the voting identity under the larger, less-reviewed codebase.

Also considered: the `largeBlob` extension (store the secret in the authenticator itself, no server copy). Support is uneven across platforms and providers, so it doesn't meet "cross-device recovery" for most voters today. A later version can add it as a second copy.

## Recommendation

**Option A.** It gives what the brief asks for, cross-device recovery from the passkey alone with the secret never leaving the device unencrypted, and keeps the key inside a boundary that holds only the signed ballot client. What the server keeps is useless without a UV-gated PRF evaluation it can't make. C is rejected (T-20). B is rejected because it contradicts the brief; the owner may still ask for it, for voters without PRF support or as a second copy against a database wipe.

What would change it: browsers letting a page use a credential outside its RP ID's domain and related origins (that breaks the boundary A rests on); the ballot client having to share a registrable domain with `apps/web` (then the backup must move to the native app, P5-2); the owner allowing B as a fallback; or the owner preferring no operator-held backups at all.

## Consequences

- T-20 moves to **Planned**: the design is here; the spec, code and tests are P2-6's later parts. Its residual is T-41 widened to every device the passkey syncs to, and a served well-known file that differs from the release.
- P2-6 continues in parts on `claude/p2-6`:
  1. This ADR.
  2. `docs/spec/identity-backup.md` and `packages/crypto`: the PRF salt, the HKDF tags, the plaintext record, the envelope and its strict decoder, and the locator id, with cross-language vectors from an independent implementation. It uses the ChaCha20-Poly1305 of RFC 8439 that P1-12 part 2 (#58) brings in with `@noble/ciphers`, so it waits for that PR.
  3. Storage: the operational table in `packages/core` (no account column; classed in the T-10 no-join test), the ballot-path procedures in `packages/api-contract` and `apps/api` (put, get and delete by locator, fixed body size, no session), a test that a request carrying an account cookie or token is refused rather than ignored, and the expiry rule (one that doesn't need a per-row access time the server would otherwise not keep).
  4. The ballot client's flows (create the credential, back up, recover) come with `apps/ballot` (P2-8).
- Before P2-8 ships backups, the ballot RP ID host must be chosen under the rules in A.1. P2-8 must put the well-known file in the signed release and test that it lists no `apps/web` origin; P1-19's served-client check must cover it; P2-11's DNS and deploy runbook must keep the RP ID free of other subdomains and wildcard records.
- Envelopes are never archived, mirrored or anchored. A voter can delete theirs.
- The ballot client is the only place the secret, the PRF output and the derived keys exist, and they are `packages/crypto` APIs the client calls (AGENTS.md, Architecture), so the code that touches them stays inside the `crypto-review` gate.
- Out of scope here, and still open for T-18: revoking a stolen identity and re-registering. At Tier 2 the uniqueness nullifier lets one document register once ([[0010-tier2-identity-provider]]), so a voter who loses both the device and the backup loses Tier 2 until that design exists. P2-6 records it as a follow-up.
- Ballot receipts and cast records stay on the device only; the backup carries neither. A lost device loses the voter's own receipt checks (G-7), and a recovered client starts without the records [[revoting]]'s client rules rely on, which can affect the voter's own vote:
  - Client rule 3's alarm would fire on every earlier ballot of the voter's in a poll still open. P2-8's recovered client must first show the voter every ballot on the board under their nullifiers, as cast before recovery, for them to confirm or flag (a ballot they don't recognise is the T-18 alarm), and then name only blocks newer than all of them.
  - The passkey syncs, so a voter can hold the secret on two devices at once. Two clients that cast in one election and tier without each other's records can name the same block, which ties the ballots and voids that vote ([[revoting]], A voter who has lost their records). P2-8 must warn a recovered client's voter to cast from one device per poll, and re-read the board under their nullifiers before every cast.
  - Both reads come from board segments the client downloads in full (or reads anyway for its anchor checks), never from a query keyed by a nullifier: one address asking about all of a voter's nullifiers at once would link them to each other and to that address (T-11, T-13).
  - The client can't decrypt earlier ballots (the backup carries no randomness or records), so the voter judges each one only by its approximate cast time, from its L1 block (about 12 seconds). A forged ballot cast close to a real one looks familiar, so this check catches a thief only when their timing differs (T-18); P2-8's interface must not claim more.

## Decision

Under rule A (`AGENTS.md`): option A, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. The owner may ask for option B, which contradicts the brief, as a fallback; nothing waits on that.
