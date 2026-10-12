# ADR 0020: Entry points

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A); buying the second domain, registering and renewing `abolishus.eth` and the registrant's legal identity are the owner's (spending, mainnet, legal)
- Threats addressed: T-41, T-49, T-43, T-20, T-69 (see [[THREAT_MODEL]])

## Context

The brief: abolish.us is the primary domain, but `.us` is government-administered, so it isn't trusted. The ballot client is published to IPFS behind `abolishus.eth` and a second non-US-TLD domain, and the verifier, docs and app list all three entry points.

Three earlier decisions constrain where the ballot client may run:

- **A dedicated origin.** The client refuses to run on an IPFS path gateway, where every CID shares one origin and another CID's page could read the client and its randomness (P2-8 part 1, T-41, T-43). Each entry point must be an origin that serves only the ballot client.
- **The ballot RP ID** ([[0017-identity-recovery-backup]], A.1): the recovery backup's passkey is bound to a stable host that serves only the ballot client, on a registrable domain other than `apps/web`'s (never same-site with it), with no other subdomains served under it and no wildcard DNS. An RP ID can't change for existing credentials: moving it orphans every backup made under the old one.
- **Origins hold the voting identity.** The voter's secret lives in the browser's storage for one origin (P2-6). A voter who opens the client at another origin starts without it.

What is one-way: the RP ID (above); the second domain's TLD, whose registry and courts decide whether the name can be taken; and every entry point we publish, because releases, docs, receipts and third-party verifiers will cite them, and an abandoned name can be registered by someone else and serve their own client under our listing.

## Options

### A. The ballot client only on the second domain and `abolishus.eth`; abolish.us links to them

- **abolish.us** serves `apps/web` (discovery, accounts, results) and docs, and links to the ballot client. It never serves the client itself, because a ballot host under abolish.us would be same-site with `apps/web` and break 0017's rule, and because `.us` is the name the brief says not to trust.
- **The second domain** is the ballot client's canonical home and its RP ID: the apex serves the signed release and nothing else; no other host under it serves anything; no wildcard records. Its `/.well-known/webauthn` lists no other origin, the narrowest reading of 0017 A.7 (which allows origins serving the same release), because every other entry point is run by someone else or can't use WebAuthn (option C).
- **`abolishus.eth`** has a `contenthash` naming the IPFS CID of the current signed release. Voters reach it through an ENS gateway that gives each name its own subdomain origin (`abolishus.eth.limo`: eth.limo resolves the name's contenthash on each request and serves it at the name's own host, https://eth-limo.gitbook.io/documentation/introduction/what-is-eth.limo/gateway-basics), so the origin is the name's, not the CID's, and stays the same across releases. P2-8's path-gateway refusal doesn't fire there, and nothing else is served at that origin.
- **`apps/node`** (P4-5) serves the release it has checked from IPFS at one local origin of its own, a fourth way in that depends on no name at all.

Pros: satisfies 0017 without exception; the RP ID sits on the name we trust most; an ENS name can't be seized through a registry or registrar (only through its owner's keys or by letting it expire). Cons: the RP ID is the second domain, so seizing that name orphans every backup and lets the seizer serve a client that reads the secret of a voter who authenticates with their backup passkey there (0017's residual, T-41, now on a non-US name rather than abolish.us). A voter who moves to the ENS entry point during an outage arrives at another origin without their identity (Consequences).

### B. The ballot client on a ballot-only US domain too (for example a second `.us` name)

The same as A, plus a third ballot host under a registrable domain of our own in the US. Pros: one more name to keep the client up. Cons: a `.us` name is exactly what the brief doesn't trust, so it adds a seizable host without adding independence; and it can't be the RP ID, so its users get no recovery. Rejected.

### C. Every entry point listed as a related origin of the RP ID

As A, but the RP ID's `/.well-known/webauthn` lists `https://abolishus.eth.limo` (`apps/node`'s local origin can't be listed usefully either way). Recovery would then work at the ENS entry point when the second domain is down. Cons: the related-origins file only helps while the RP ID's host serves it, which is exactly when the second domain isn't down, so it buys little for outages; and it widens the boundary of every backup to whatever the gateway's operator serves at that origin, a third party we don't run (T-41). Rejected.

### The second domain's TLD

Requirements: a country-code TLD whose registry isn't under US jurisdiction or an ICANN generic-TLD contract (generic TLDs' registries answer to ICANN's US-law agreements, and the large ones are US companies); no local-presence requirement, so the owner's entity can register it; DNSSEC; registry lock; and a published, narrow takedown procedure.

- **`.ch`** (SWITCH, under Switzerland's Ordinance on Internet Domains). DNSSEC-signed, no local presence required, procedures and block statistics published every year. Its takedown path is narrow but real: under OID Art. 15 SWITCH blocks a domain it suspects of phishing or malware if the content isn't removed within one working day, for a limited time that a recognised authority can extend (https://www.nic.ch/security/malware/; the registry reports give 30 days as the maximum).
- **`.is`** (ISNIC). No local presence required; ISNIC has argued publicly against suspending domains for their content (https://www.isnic.is/en/news/view?id=347), but its FAQ now lets it close a domain on an Icelandic court order or a request from the relevant authorities (https://www.isnic.is/en/faq), a path less precisely bounded than `.ch`'s.
- **`.eu`** requires an EU or EEA registrant, which depends on the owner's entity. Not recommended unless the entity qualifies.

## Recommendation

Option A, with `.ch` for the second domain and `.is` as the fallback if the name is taken or the owner's counsel prefers it. `.ch`'s takedown path is narrow, time-limited and published, and a wrongful block is a temporary outage of one entry point while `abolishus.eth` keeps serving; it can't change what the client does. The TLD's legal assessment is the owner's (legal and entity matters), so the owner may substitute another country-code TLD that meets the requirements above without reopening the rest of this ADR.

The ENS name and the second domain are held so that no single key or person can move them:

1. **`abolishus.eth`** is registered and wrapped with its owner set to an L1 Safe dedicated to releases, never the anchoring Safe of [[0004-l2-choice]] and never a single key, so seizing the anchoring authority doesn't seize the client and the reverse (T-69). The Safe sets the `contenthash` only to the CID of a signed release (P0-3), after that release's reproducible build has passed `repro-build`. It is registered for at least 10 years and renewed whenever fewer than 5 remain; renewal on the `.eth` registrar is open to anyone, so the community can keep the name alive if we can't.
2. **The second domain** has registry lock where offered, DNSSEC, nameservers from at least two providers (at least one outside the US), a registration term of at least 5 years and auto-renewal. Its DNS holds only the apex's records and no wildcard (0017 A.1).
3. **One list.** The entry points are listed in one place, in the signed release record, and the verifier, docs, `apps/web` and the ballot client print that list. A later change to the list ships in a release and is reviewed like one.

What would change this: a browser-native way to reach an IPFS CID at its own origin from an ENS name without a gateway (then the gateway drops out of the trust base); the owner's counsel ruling out `.ch` and `.is`; or the ballot RP ID moving to the native app only (P5-2), which would free the second domain from 0017's rules.

## Consequences

- **Owner actions** (spending, mainnet, legal): buy the second domain under the rules above; register and wrap `abolishus.eth` under the release Safe (whether we already hold it must be checked before anything lists it); name the Safe's signers. Until then nothing lists either name, and P2-8 can't ship backups (0017 A.1 needs the RP ID chosen).
- **A voter's identity doesn't follow them across entry points.** A voter on `abolishus.eth.limo` or `apps/node` while the second domain is down has no identity there and no recovery (the RP ID's host is the one that's down). P2-6 or P2-8 must add an explicit, voter-initiated transfer of the identity between the client's own origins (for example a code or QR shown in one and entered in the other), never through a server; until it exists, only a voter who registered at that origin can vote there.
- **The ENS gateway is trusted for the bytes it serves**, as any host is (T-41): eth.limo could serve another client at `abolishus.eth.limo`. The verifier's served-client check (P1-19) compares the served bytes with the signed release, and `apps/node` removes the gateway. Its operator never gets the RP ID's PRF (option C rejected).
- **Seizing the second domain** orphans every recovery backup and puts its seizer inside the RP boundary (0017's residual, T-41, T-49). DNSSEC and registry lock stop registrar-level hijacks, not the registry or a court. The native app (P5-2) and an RP ID per release platform are the longer-term exits.
- **Expiry is a seizure.** An expired `.eth` name or domain can be registered by anyone, who then serves their own client under our listing. The renewal rules above, and a monitoring job alerting a year before either expires (P2-11), are required before either is listed.
- Follow-ups: P4-4 part 2 adds the entry-point list to the release record and the verifier's served-client check (P0-3, P1-19); part 3 sets the ENS contenthash from the release workflow through the Safe (a `ci:` PR) and the second domain's DNS and deploy (P2-11, a runbook); P4-3 pins each release on IPFS so the contenthash resolves; P2-8 must show a voter at an origin that isn't on the release's list, and isn't `apps/node`'s local one, a warning naming the listed entry points (a refusal would also shut out community mirrors during a takedown), and ship the well-known file listing no other origin.

## Decision

Under rule A (`AGENTS.md`): option A, with `.ch` recommended for the second domain and `.is` as its fallback, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. Buying the domain, registering `abolishus.eth`, naming the release Safe's signers and the TLD's legal assessment are owner-only and listed under Waiting on the owner; nothing else waits on them except listing the names and P2-8's backups.
