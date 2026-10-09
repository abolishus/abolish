# ADR 0005: Permanent archive

- Status: needs-decision
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-51, T-49, T-66, T-17, T-68, T-15, T-24, T-52, T-69, T-71 (see [[THREAT_MODEL]])

## Context

The brief stores the public bulletin board (encrypted ballots, proofs, ceremony and tally transcripts) in Postgres, mirrors it to IPFS, and adds "a permanent archive (ADR: Arweave vs pinning-only; IPFS alone is addressing, not storage)". Two invariants depend on it:

- **Wipe and rebuild (T-66).** Wiping Postgres loses no results: everything that affects a result is rebuilt from chain + IPFS.
- **Verification without us (G-9, G-10, T-49).** The verifier checks every result from chain + IPFS alone, with our servers and domain offline.

The chain holds only roots and small records: board Merkle roots anchored hourly to L1 (P4-1), and on the L2 the groups, election definitions, trustee keys and direct-submitted ballots. The board itself is too large for calldata. And since Ethereum prunes blobs after about 18 days, the L2's own history can't be rebuilt from L1 alone after that ([[0004-l2-choice]]): our contracts' events need a copy too.

An IPFS CID names bytes; it doesn't keep them. A block stays retrievable only while some node holds it (T-51). So the question is who keeps the bytes, for how long, and what happens to them when we are gone: seized, shut down by order or simply out of money (A-7, A-1, T-69).

What the archive does **not** decide is integrity. Every board entry is hash-chained and every hour's Merkle root is anchored on L1 (P1-16, P4-1), so the verifier checks any copy, from any source, against the anchored roots. A storage provider can withhold data but can't alter it undetected. The choice is purely about availability, cost and permanence.

It is one-way because:

- **Data written to a permanent store can't be withdrawn.** If personal data slips onto the board (a poll's text, T-17), or if the encryption scheme later falls (T-15), a permanent copy stays readable for good. With pinning-only we can at least stop serving it, though anyone may have copied it.
- **Data lost from a pinning-only store can't be recovered.** If an election's board is lost before anyone archived it, its result can never be verified again. Choosing pinning-only now and adding a permanent store later protects only elections whose data still exists then.

## Options

### A. Arweave, with IPFS for addressing

[Arweave](https://www.arweave.org) is a blockchain for storage: an upload is paid once, and the fee funds an endowment sized to pay miners to keep about 200 years of replicas, assuming storage costs keep falling (the yellow paper assumes at least 0.5% a year). Miners are rewarded for proving random access to the stored dataset (SPoRA, then succinct proofs of packed replicas), so keeping more of it pays more. Data is fetched by transaction ID from any node or gateway (the [AR.IO](https://ar.io) gateway network, `arweave.net`, or a node of one's own).

How we would use it: once an hour, after the anchor, the worker writes that hour's board segment, in its canonical encoding, as one CAR file (so its IPFS CID is the same whether fetched from IPFS or Arweave), tagged with the CID, the anchored root and the election ID. Small items go through an ANS-104 bundler; the worker confirms that the bundle itself reached the Arweave chain and posts directly if it hasn't within a bound.

- **Cost:** 13.93 AR per GiB on 2026-10-09 (`arweave.net/price/1073741824`); the fiat price moves with AR's. Bundling services (for example ArDrive Turbo) accept card payment, so we need not hold AR. A ballot with its validity and membership proofs is kilobytes to tens of kilobytes (fixed by P1-10, P1-12 and P1-17), so a 10,000-voter election is at most a few hundred megabytes, a few AR: a one-off cost, not a running one.
- **Pros:**
  - Survives us. Nothing has to be paid, renewed or kept running after the upload. An election archived before a takedown stays retrievable after it (T-49, T-51, T-69, A-7).
  - Many independent miners and gateways in many jurisdictions; no single provider can delete it (A-1).
  - Fits the verifier's model: integrity comes from L1 anchors, availability from any Arweave node, so neither trusts the other.
- **Cons:**
  - Irrevocable. Anything archived by mistake, personal data especially, can't be removed (T-17, T-68). The archive needs a strict content rule (Consequences).
  - It guarantees A-11 a complete, permanent copy of every ciphertext (T-15). The board is public, so anyone can keep a copy anyway, but we would be the ones making sure it never disappears. This is the strongest argument for P1-3's perfectly hiding option.
  - Its permanence is an economic assumption, not a proof. If storage costs stop falling or AR's value collapses, the endowment may not pay for 200 years, and data could be dropped by miners over time.
  - Miners and gateways each apply their own content policies and may refuse to store or serve data; in practice most traffic goes through a few large gateways (A-1). Any full node can still serve it.
  - A token and a separate network in the verifier's path: a new client, a new failure mode, and a wallet key in the worker (an Arweave key can only add data under our address, which the verifier doesn't trust anyway).

### B. Pinning-only

Every board CAR is pinned on IPFS by several independent parties: our own IPFS nodes (Kubo), two or more commercial pinning services in different jurisdictions (for example Pinata, Filebase), and community nodes (`apps/node`, P4-5) that pin every election's data by default. The verifier fetches by CID from whoever has it.

- **Cost:** a monthly fee per stored gigabyte per provider, for as long as the data is kept; our own nodes cost hosting.
- **Pros:**
  - Reversible. Personal data that slips through can be unpinned by us and our providers (T-17, T-68); copies held by others can't be recalled, but most viewers would lose access.
  - One protocol (IPFS) in the verifier's path, and no token.
  - Content-addressed end to end: the CID is the integrity check.
- **Cons:**
  - Data lasts only as long as someone pays. If we are seized, shut down or run out of money, our nodes and our commercial pins lapse with our accounts (A-7, T-69), which is exactly the case the brief's censorship-resistance goal is about (G-10, T-49).
  - Commercial pinning services are companies that remove content under legal orders (A-1).
  - Community nodes are voluntary and unevenly distributed. Nobody can promise they will still hold a given election in ten years; an old, uncontested election is exactly the data volunteers stop pinning.
  - No proof that anyone still holds the data until someone asks and it fails (T-51).

### C. Filecoin storage deals, with IPFS pinning

[Filecoin](https://filecoin.io) storage providers hold the board's CAR files under storage deals, and must prove on-chain, continuously, that they still hold them (proofs of replication and spacetime), or lose collateral. The data is addressed by IPFS CID. Retrieval is best-effort, so IPFS pins (as in B) are still needed for fast access.

- **Pros:**
  - Cryptographic, public proof that each copy still exists, for the length of the deal (T-51).
  - Independent providers in many jurisdictions, natively keyed by CID.
- **Cons:**
  - Deals are time-limited (a few years at most) and must be renewed and paid for by someone. Like B, data lapses if we disappear (A-7, T-69). Third-party programs that pay for public-good storage could take over renewals, but that is a promise, not a protocol.
  - Retrieval is not guaranteed by the proofs: a provider can prove storage and still refuse to serve.
  - Like A, a token and a separate network in our operations; unlike A, it doesn't outlive us.

## Recommendation

**Option A, Arweave, together with B's IPFS pinning for fast access, and a strict rule on what goes into the archive.**

- **T-51 under A-7 is the deciding case.** The archive exists for the day our servers, accounts and funds are gone. Only Arweave keeps data with nothing left to pay or run after that day. B and C protect the data only while someone renews them.
- **The data is cheap and small.** A one-off fee in the range of a few AR per election is small next to its value, and next to the running cost of B or C over decades.
- **Integrity doesn't depend on Arweave.** The L1 anchors are the root of trust; Arweave is only one more place to fetch bytes from. If Arweave's economics fail in decades, we lose one copy, not correctness.
- **Its main cost, irrevocability, can be contained by design** (Consequences): only result-critical, personal-data-free bytes go in. Its other cost, a permanent copy of the ciphertexts (T-15), exists for any public board, and P1-3 is the place to answer it.

What would change the recommendation:

- The owner decides that irrevocability is unacceptable even for result-critical data (for example because P1-3 keeps computationally hiding ballots on the board). Then **B** is the choice, with every community node pinning by default, and T-51 stays **Partial** with the residual "results of past elections can become unverifiable once nobody pins them".
- A Filecoin-based program that pays for renewals permanently, run by someone other than us, becomes credible. Then C is worth comparing again.
- Arweave's fee rises far beyond the estimate, or its main gateways start filtering election data.

## Consequences

- **What is archived (T-17, T-68).** Only result-critical data: every board entry in canonical encoding (ballots and their proofs, spoiled-ballot openings, ceremony and tally transcripts), election definitions, and our contracts' L2 events with the calldata that produced them, so the verifier's recomputation of our contract state ([[0004-l2-choice]], T-71) still works after blob expiry. An election definition commits to its display text (question, option labels, descriptions) by hash, and the text itself is stored separately, pinned on IPFS (B) but never on Arweave. A result is then fully verifiable from the archive, and anyone holding the text can prove what each option meant; if the text must be taken down, the result remains. P1-8 defines this split in the spec, P1-10 the encoding, P2-10 the moderation policy for the text.
- **Archive objects.** One CAR per election per anchoring period, written after that period's anchor. The anchor of each period records the Arweave ID of the previous period's archive object, so the verifier finds archived data from the chain alone, without trusting a gateway's search index (P4-1, P1-18). Arweave tags are a convenience index, never trusted.
- **Confirmation.** The worker treats data as archived only once the bundle carrying it is on the Arweave chain with enough confirmations, and reposts directly if a bundler doesn't deliver in time. Until then, the period's data has only the IPFS copies (T-51 residual for the newest hour, P2-4, P4-3).
- **Verifier and node (P1-19, P4-5, P4-6).** The verifier reads from local files, any IPFS source and any Arweave gateway or node, checks every byte against the anchored roots, and reports any period whose archive object is missing or doesn't match. `apps/node` pins every election's data on IPFS by default.
- **Reference election (P1-20).** Locally it uses Helia only; an Arweave test harness (such as a local `arlocal` instance) is added with P4-3. The wipe-and-rebuild step must also pass with only the archive copy.
- **Keys.** The worker holds an Arweave wallet key (or a bundler account). It can only add data under our address, which the verifier doesn't trust, so its compromise costs money and junk uploads, not integrity (T-52). It never lives in a session or CI (AGENTS.md).
- **Spam (T-52).** Only data that passes the board's validity checks is archived, so flooding the board can't cost us arbitrary archive fees beyond the board's own rate limits.
- **Known-weak:**
  - T-15: archiving makes sure every ciphertext stays available to a future cryptanalyst. Mitigated only by P1-3.
  - T-17: the hash-only rule protects display text; a poll creator who hides personal data in result-critical fields (for example option counts or encoded parameters) would get it archived for good. P1-8 limits those fields to fixed formats.
  - T-51: permanence rests on Arweave's endowment economics, and the newest period is held only on IPFS until it is confirmed.
  - T-24, T-51: a gateway may withhold data or serve it to some viewers and not others. It can't serve altered data past the anchored roots, but the verifier must be pointed at another source, and a missing object is reported, never silently skipped.

## Default

Opened 2026-10-09 20:23 UTC. If the owner hasn't answered by **2026-10-12 20:23 UTC**, option A (with IPFS pinning and the archive content rule) is adopted and this ADR is marked `Status: accepted by default — revisit`. Nothing is uploaded to Arweave mainnet before P4-3, and that upload spends real funds, so P4-3 waits for the owner to provide them.
