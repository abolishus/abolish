# ADR 0004: L2 choice

- Status: Accepted (agent) — owner may veto (2026-10-10, rule A): option B, for development and testnet only; mainnet waits for the owner
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-50, T-71 (new), T-35, T-11, T-13, T-26, T-06, T-33, T-34, T-37, T-38, T-62, T-69 (see [[THREAT_MODEL]])

## Context

The brief puts Semaphore groups, election-definition hashes, trustee public keys and direct-submitted ballots on "an Ethereum L2 that L2BEAT rates Stage ≥1 at decision time", choosing between Arbitrum One and Base, and weighing sequencer jurisdiction, the forced-inclusion path and paymaster tooling. Gas sponsorship covers registration only; voters never transact to vote, except when they choose to submit directly because our servers refuse (T-25).

It is one-way because the Semaphore groups live there. Moving to another chain later means either every member registers again, or the old groups' roots are carried over by a migration that voters and verifiers must trust and check. Election definitions, trustee keys and direct-submitted ballots of past elections stay on the old chain for good, so every verifier must keep reading it.

The L2 sits inside the trust base of every result: a ballot counts only if it is on the L2 (or on our board, anchored to L1), and a voter is eligible only if their commitment is in an L2 group. Two properties of the L2 matter most:

- **Censorship (T-50).** Both chains have a single sequencer run by one US company. If it refuses our transactions, the remedy is forced inclusion through L1, which takes up to the chain's delay bound. A poll that closes within that bound can lose ballots.
- **Governance power over state (new T-71).** Stage 1 means a Security Council can still change the rollup's rules, and so its state, with little or no delay. L2BEAT's Arbitrum One page records that on 2026-04-21, after the KelpDAO exploit, the Security Council, acting alone on its instant emergency path, spoofed an L2 transfer of about 30,766 ETH from the exploiter's address to a quarantine address; in June a Constitutional AIP (the regular, delayed path) used a temporary Inbox override to spoof a second transfer releasing it. Both changed L2 balances through delayed messages created on L1. Whatever the merits of that case, it shows the power is real and is used: a Stage 1 L2's governance can forge any transaction from any address. Base's governance has the same power with no delay at all.

Data below is from L2BEAT's project pages for Arbitrum One and Base, read on 2026-10-09, plus the chains' own documentation. L2BEAT itself warns that parts of its Arbitrum page may be outdated after recent changes. Stages and delays change; the recommendation must be re-checked against L2BEAT before any mainnet deployment.

## Options

### A. Arbitrum One

Optimistic rollup (Nitro), built by Offchain Labs and governed by the Arbitrum DAO; data is posted to Ethereum (blobs). Testnet: Arbitrum Sepolia (settles to Sepolia).

- **L2BEAT stage:** Stage 1. Permissionless interactive fraud proofs (BoLD, live since February 2025), 6d 8h challenge period.
- **Sequencer and jurisdiction:** one sequencer, operated by Offchain Labs, a US company. L2BEAT treats the sequencer's policy as outside its assessment.
- **Forced inclusion:** a transaction sent to the delayed inbox on L1 can be forced into the chain after up to **24 hours** (L2BEAT: "up to a 1 day delay"). It is the user's original signed L2 transaction, so `msg.sender` is preserved. A live sequencer may also hold delayed messages for that whole window, and Arbitrum's documentation lets it set block timestamps up to 24 hours behind L1.
- **Upgrades:** regular upgrades go through a token-weighted DAO vote and about 17 days of timelocks and challenge period (L2BEAT's page also lists a 10-day exit window, and about 41 days wall-clock for a Constitutional AIP). The Security Council (9 of 12, elected in two cohorts) can upgrade **instantly**, with no exit window, and used that path in April 2026 to spoof the transfer above.
- **Paymaster tooling:** ERC-4337 EntryPoint and the major third-party bundlers and paymasters (Pimlico, Alchemy and others) support Arbitrum One and Arbitrum Sepolia. Nothing chain-native.
- **Semaphore:** v4 is deployed on Arbitrum One and Arbitrum Sepolia (same address on both, per Semaphore's deployed-contracts page).
- **EVM differences:** `block.number` returns an estimate of the **L1** block number; the L2 block number needs the `ArbSys` precompile. One execution client (Nitro).
- **Pros:**
  - Regular-path upgrades give about 17 days' notice, so a malicious non-emergency change is public long before it takes effect.
  - The Security Council is elected by the DAO in cohorts, with members outside Offchain Labs.
- **Cons:**
  - Forced inclusion takes up to 24 hours, and a live sequencer can hold delayed messages and backdate timestamps for as long: twice Base's worst case, and far beyond its live-sequencer bound (T-50, T-35).
  - The Security Council alone (9 of 12) can rewrite the rules instantly, and has used that power to forge a transaction from a third party's address (T-71).
  - `block.number` semantics differ from Ethereum, a trap for contract code, for the election definition's open and close rule (T-35), and for third-party verifiers.
  - Regular upgrades are decided by a token-weighted vote. This doesn't touch our "one person, one vote" rule (it's about the chain, not our ballots), but the chain's rules can be changed by whoever holds the most ARB, given 17 days.

### B. Base

Optimistic rollup on the OP Stack, operated by Coinbase; data is posted to Ethereum (blobs). Testnet: Base Sepolia (settles to Sepolia).

- **L2BEAT stage:** Stage 1. Fraud-proof submission is open to everyone. Since June 2026, each state proposal carries either a TEE attestation or a ZK proof; a proposal with one resolves after 5 days unchallenged, with both after 1 day. TEE proposers are allowlisted by Coinbase's Coordinator multisig; only self-proposing with a ZK proof is permissionless.
- **Sequencer and jurisdiction:** one sequencer (five Raft replicas, one leader), operated by Coinbase, a publicly listed, regulated US company. L2BEAT notes the replicas "do not create independent operators or censorship resistance".
- **Forced inclusion:** a deposit sent to `OptimismPortal` on L1 must be included within the **12-hour** sequencing window (3,600 L1 blocks). The deposit becomes an L1-originated transaction rather than the user's signed L2 transaction; for an EOA sender, `msg.sender` is the same address. Deposits share a metered gas budget per L1 block (L2BEAT: 20,000,000 gas), and calldata is capped (120,000 bytes), which bounds the size of a forced ballot. The 12 hours apply when the sequencer stops posting; a live sequencer must take each deposit once its L1 block becomes the L2's origin, and the origin may lag L2 time only by `max_sequencer_drift` (1,800 seconds in the OP Stack since Fjord), a parameter Base can change without delay.
- **Upgrades:** all contracts are upgradable by a 2-of-2 multisig whose members are the Base Security Council (8 of 11) and Coinbase's Coordinator multisig (3 of 6). There is **no delay** and **no exit window** on any upgrade. Below that, Coinbase alone controls the TEE proposer allowlist (Coordinator, 3 of 6) and `SystemConfig` (Base Multisig 1, 3 of 12): the sequencer and batcher, the gas limit and the deposit metering that forced inclusion uses.
- **Paymaster tooling:** the same third-party ERC-4337 bundlers and paymasters as Arbitrum, plus Coinbase's own paymaster (which needs a Coinbase Developer Platform account, so Coinbase would see every sponsored registration, T-13).
- **Semaphore:** v4 is deployed on Base and Base Sepolia (same address as on Arbitrum).
- **EVM differences:** EVM-equivalent: `block.number` and `block.timestamp` are L2 values with Ethereum semantics. The `L1Block` predeploy exposes the L1 origin block's number and timestamp, which a contract can use to tell when a forced deposit was sent (see Consequences). More than one OP Stack execution client exists.
- **Pros:**
  - Forced inclusion within 12 hours, half Arbitrum's bound, on the attack our design leans on most: a US company compelled to drop our transactions near a poll's close (T-50, T-69).
  - No contract upgrade without both the Security Council and Coinbase. Arbitrum's Security Council can act alone.
  - Ethereum semantics for block numbers and timestamps, which simplifies contracts, the close-time rule and every third-party verifier.
- **Cons:**
  - No upgrade delay of any kind. A malicious or compelled upgrade signed by the Security Council and Coinbase takes effect immediately, with no warning to anyone (T-71).
  - Coinbase is both the sequencer operator and one of the two upgrade keys, so one company in one jurisdiction controls ordering and holds a veto over every change, and is the most exposed to US legal compulsion (A-1).
  - Coinbase alone sets `SystemConfig` (batcher, gas and deposit limits, so part of the forced-inclusion path) and the TEE proposer allowlist. A false TEE-only output root settles after 5 days unless someone challenges it with a ZK proof, so a settled Base output root is not proof of L2 history (T-71).
  - Coinbase's own paymaster is the convenient default and must not be used (T-13).

## Recommendation

**Option B, Base,** with contracts that treat the L2's governance as untrusted (Consequences).

Both chains meet the brief's bar (Stage 1), and both put sequencing in one US company's hands, so jurisdiction doesn't separate them. Paymaster tooling doesn't either: we must run our own paymaster on either chain (T-13). What separates them:

- **Censorship (T-50) favours Base.** Censorship by a compelled or hostile sequencer is the concrete, cheap attack against a voting system: it needs only a court order, and its effect is invisible unless forced inclusion works in time. Base bounds it at 12 hours, and a live Base sequencer can delay a deposit only by the drift bound (30 minutes today); Arbitrum's bound is 24 hours either way.
- **Governance power (T-71) is a wash, and can't be fixed by choosing.** Arbitrum's regular path has a 17-day delay but its Security Council can act alone and instantly; Base has no contract-upgrade delay but needs two independent parties, while Coinbase alone holds the configuration and proposer allowlist. Neither chain lets us rely on its governance. So the contracts and the verifier must make governance tampering detectable instead: every write that affects a result carries its own verifiable evidence that L2 governance can't forge (Consequences).
- **Ethereum semantics favour Base.** Exact `block.number` and `block.timestamp` semantics matter for the close rule and for every verifier we and third parties write.

What would change the recommendation:

- Base drops below Stage 1, or Arbitrum One's forced-inclusion bound falls to 12 hours or less, or Base raises its sequencing window or drift bound until its forced-inclusion bound approaches Arbitrum's (it can do so without delay).
- Base's sequencer is seen filtering transactions by address or contract.
- The owner weighs a regular-path upgrade delay above the censorship bound. Then Arbitrum One is the better choice, and the 24-hour bound must be designed around (Consequences, close rule).
- Either chain reaches Stage 2 first. That is worth a switch while no mainnet groups exist yet.

## Consequences

- **Testnet:** Base Sepolia (chain ID 84532) for L2 contracts, Sepolia for L1 anchoring, Anvil locally. If the recommendation is adopted by default, it covers development and testnet deployment only: **nothing goes to mainnet until the owner signs off** (AGENTS.md), and that sign-off should re-check L2BEAT first.
- **Portability (P1-18).** Contracts use no chain-specific precompile except behind one small, documented adapter, and read time only through `block.timestamp` and the adapter. The chain ID and contract addresses are bound into the election definition (T-34). Moving chains later is then a redeployment plus a group migration, not a rewrite.
- **Close rule (P1-18, P1-13, P1-19).** A poll must not lose ballots that were forced through L1 before close but included up to 12 hours later (T-50), and must not accept ballots the sequencer slips in after close by lagging the L1 origin (up to the drift bound) or by rebuilding unposted blocks with earlier timestamps (T-35, and reordering re-votes, T-33, T-38). The EVM can't tell a contract whether a transaction is a deposit. P1-18 picks the rule; candidates:
  - **recommended:** an ordinary L2 transaction counts if `block.timestamp ≤ close` and the verifier finds the L1 block carrying its batch at or before close + δ, with δ in the election definition. A forced ballot goes through our own L1 relay contract, which stamps L1 `block.timestamp` into the message; on L2 the contract accepts it only from the relay's aliased address and with a stamp ≤ close, and the verifier finds the matching relay call on L1 (so a forged message from the aliased address is detected, T-71);
  - accept a ballot if the L1 origin timestamp (`L1Block`) of its inclusion block is at or before close. Simpler, but it lets the sequencer accept late ordinary ballots for up to the drift bound;
  - the result is final only 12 hours after close, and the election definition says so.

  Because Base can change the sequencing window and drift without delay, the election definition records the bounds it assumes, and the verifier re-checks them against the chain's configuration over the poll's lifetime.

- **Finality (P1-13, P1-19).** A receipt and the verifier count an L2 ballot only once the L1 data it was derived from is finalized, never on a sequencer's soft confirmation (T-50, T-26). That takes minutes, not the 5-day challenge window: data on finalized L1 fixes the L2 history for every node running the derivation rules pinned by the verifier's release, while the blobs are retrievable. After blob expiry only the mirrored copy (P1-6) and the output-root chain remain, and Base's roots are only as good as the proposer rules above.
- **Governance as an adversary (T-71; P1-17, P1-18, P1-19, P4-1).** Because the L2's governance can forge any transaction:
  - no contract trusts `msg.sender` alone for anything that affects a result. A ballot carries its ZK membership proof (T-04); a trustee key carries its DKG transcript hash (T-37); a Tier 2 group addition carries its public document proof (T-06); an election definition is checked against its hash published to the board;
  - Tier 0 and Tier 1 group additions (T-06, T-62) carry a threshold signature of the Safe's owners (EIP-712) over the batch of commitments, checked by the contract and again by the verifier, so a transaction spoofed from the Safe's address can't add members without the owners' keys. Group roots anchored to L1 (P4-1) are computed from the board's record of signed additions, never read back from L2 state;
  - any deposit or delayed-message transaction that reaches our contracts is suspect: the verifier checks that its L1 source is an ordinary call to the canonical portal recorded in the release (or to our relay), which L2 governance can't fake on L1;
  - the verifier recomputes our contracts' state transitions from the events and calldata it holds, and reports any state of ours that the recomputation doesn't reproduce. It doesn't replay the whole chain, so it doesn't detect governance changes elsewhere on the L2.
- **History beyond blob expiry (P1-6, P1-19, P4-3, P4-5).** Ethereum prunes blob data after about 18 days, so after that the L2's history can't be rebuilt from L1 alone. The verifier reads our contracts' events from any Base archive node, and our events are mirrored to IPFS and the permanent archive (P1-6) so they outlive any one node. Output roots settled on L1 are a cross-check, not proof (Option B, Cons): what makes our records trustworthy is the evidence each one carries.
- **Paymaster (P2-6, P3-2).** Registration sponsorship uses our own ERC-4337 paymaster contract, never Coinbase's hosted paymaster, so Coinbase's developer platform doesn't receive it. The bundler and the RPC provider still see the UserOperation (sender account and commitment) with network metadata (T-11, T-13), so registration goes through a bundler we run or over a privacy-preserving transport. Our paymaster still sees the link; T-13's residual stands.
- **Forced-deposit limits (P4-2).** A direct-submitted ballot sent through `OptimismPortal` must fit the deposit calldata cap and gas metering. P1-18 sizes direct-submit ballots against that, together with the option-count limit from [[0003-tally-scheme]].
- Known-weak:
  - T-50: a poll whose last hours are censored loses voters who don't know how to force a deposit through L1. `apps/node` and the verifier docs must explain the forced path (P4-2, P4-5), and it costs L1 gas.
  - T-71: Base's governance can change the chain's rules instantly. We can make tampering detectable, not impossible.
  - T-69: the sequencer operator is one US public company.
  - T-11, T-13: a direct or forced submission from a voter's own funded address publicly links that address (often funded from a KYC'd exchange) to participation in the poll, and through the nullifier to how many times they re-voted. The direct-submit docs (P4-2) must tell voters to use a fresh, privately funded address.

## Default

Opened 2026-10-09 20:10 UTC. If the owner hasn't answered by **2026-10-12 20:10 UTC**, option B is adopted for development and testnet work and this ADR is marked `Status: accepted by default — revisit`. Mainnet deployment is never defaulted: it waits for the owner.

Superseded on 2026-10-10 by rule A (`AGENTS.md`): the owner's update replaced the 72-hour default, and the recommendation was adopted as `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
