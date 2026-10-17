// The reference election's stages (AGENTS.md, Reference election), and how
// far this fixture covers each. The transcript lists every stage, so a run
// can't read as the whole proof while stages are missing; P1-20's `ci:` part
// makes the check require all of them `covered` before it arms.

export type Coverage = "covered" | "partial" | "not-yet";

export interface Stage {
  readonly id: number;
  readonly name: string;
  readonly coverage: Coverage;
  /** What the run does for it, or which item brings it. */
  readonly note: string;
}

export const STAGES: readonly Stage[] = Object.freeze([
  {
    id: 1,
    name: "Trustee key ceremony with public transcript",
    coverage: "partial",
    note: "a 4-of-7 panel, pinned in the trustee registry on a local L2 with rule 7's quorum of 6, runs the four-round ceremony through @abolishus/crypto with every seat; the registry records it from every seat's signature on the checked key set, and the election registry registers the definition; the transcript is board entry 0, and the verifier's 3.2 must pass on it; a ceremony of 5 seats is refused by both registries; the verifier doesn't read L2 yet, so 3.1 can't pass (P1-19), and no release pins the panel (P1-7)",
  },
  {
    id: 2,
    name: "Registration at every identity tier",
    coverage: "not-yet",
    note: "P2-5, P2-6 (Tier 0), P3-3 (Tier 1), P3-4 (Tier 2)",
  },
  {
    id: 3,
    name: "Group membership",
    coverage: "not-yet",
    note: "P3-2 (group registry on L2), P1-17b (membership proofs)",
  },
  {
    id: 4,
    name: "Casting, Benaloh challenge/spoil, re-voting",
    coverage: "not-yet",
    note: "P1-12 (the ballot record), P1-13 (challenge/spoil), P1-13b",
  },
  {
    id: 5,
    name: "A direct-submit ballot that bypasses our servers",
    coverage: "not-yet",
    note: "P1-18 part 4, P4-2",
  },
  {
    id: 6,
    name: "Close, threshold decryption, tally",
    coverage: "not-yet",
    note: "needs ballots (stage 4); the tally and destruction code is P1-15's",
  },
  {
    id: 7,
    name: "L1 anchoring",
    coverage: "partial",
    note: "the BoardAnchor contract on Anvil anchors the ceremony's segment and the seal from a stub authority, and the verifier reads both back from eth_getProof; the anchoring job and the Safe are P4-1 part 2",
  },
  {
    id: 8,
    name: "Wipe Postgres and rebuild every result from chain + IPFS",
    coverage: "partial",
    note: "the board only: each board's segment objects are published as blocks to a community node (apps/node serve), and each bundle is rebuilt from L1 alone, the checkpoints from the anchor's CheckpointAnchored logs and the copy fetched by the CIDs they name, from a blocks.car exported from the node and from the node's gateway; no Postgres is wiped yet, since nothing the fixture runs writes one (P2-1, P2-4), and no result but the board is rebuilt (P1-15)",
  },
  {
    id: 9,
    name: "Independent verification by packages/verifier from chain + IPFS alone",
    coverage: "partial",
    note: "the verifier runs in its own process on the output bundle alone, the board read by CID from a block store or a community node's gateway; its L1 evidence is still a local file and 3.1 isn't implemented, so its verdict is unverifiable; from chain and IPFS alone is P4-6",
  },
]);
