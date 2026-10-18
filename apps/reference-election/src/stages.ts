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
    coverage: "partial",
    note: "the definition's one Tier 0 group is four voters' identity commitments, its root their tier tree, and every ballot proves membership in it with a real Semaphore proof under the pinned depth-32 key, made by the ballot client's prover (@abolishus/membership-prover) from a path rebuilt from every leaf; the root is computed by the fixture, not created in the group registry on L2 (P3-2), and the verifier doesn't read the registry yet (2.4, P1-19)",
  },
  {
    id: 4,
    name: "Casting, Benaloh challenge/spoil, re-voting",
    coverage: "partial",
    note: "in the honest election, three voters cast version-1 ballots in Casting's order through @abolishus/crypto, one re-voting under a later L1 block, each boarded on the board path in the voting window's segment; the verifier must admit all four (5.1 to 5.5, 5.7), and a control election's ballot carrying another ballot's proof must be rejected at 5.1 to 5.3 alone; a poll of three questions (pick one, pick any, pick exactly two; definition version 5, registered on L2 with its receipt key registered with the L1 anchor) gets the same: version-3 ballots sealed and cast through @abolishus/crypto's seal, one a re-vote, all four admitted, with the client's receipt-key check before casting and 2.9 judging the key from L1 state; in both, one challenged attempt is opened and checked on a second context against the code shown, but not published, since an opening boarded before the counted extent breaks challenge.md's Publication rules (P1-18's window); the poll's ballots get the operator's receipts, signed by the fixture under the listed key and passing the client's check at cast, and each is judged after the seal's window from the anchors and the key's record at the finalized L1 block and the operator's entry-hash lists: the four boarded ballots' receipts must be included, a receipt for a forked board (a boarded ballot shown at another index) forked from the copy, and one for a ballot never boarded forked from L1 alone; whether that loss is a drop (no admitted entry carries its (tier, ν, M)) isn't judged yet (the verifier's drop rule, P1-13b), nor are receipts committed or opened after the dispute end; no ballot goes through the API or a trustee's intake (P2-3, P2-13), the L1 references aren't judged (5.8 needs format 5's headers, P1-19) and selection (6.1) isn't reached",
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
    note: "the BoardAnchor contract on Anvil anchors the ceremony's segment, the voting window's and the seal from a stub authority, and the verifier reads them back from eth_getProof; the anchoring job and the Safe are P4-1 part 2",
  },
  {
    id: 8,
    name: "Wipe Postgres and rebuild every result from chain + IPFS",
    coverage: "partial",
    note: "the board only: each board's segment objects and entry-hash lists are published as blocks to a community node (apps/node serve), and each bundle is rebuilt from L1 alone, the checkpoints from the anchor's CheckpointAnchored logs and the copy fetched by the CIDs they name, from a blocks.car holding the node's blocks and from the node's gateway; no Postgres is wiped yet, since nothing the fixture runs writes one (P2-1, P2-4), and no result but the board is rebuilt (P1-15)",
  },
  {
    id: 9,
    name: "Independent verification by packages/verifier from chain + IPFS alone",
    coverage: "partial",
    note: "the verifier runs in its own process on the output bundle alone, the board read by CID from a block store or a community node's gateway; then the community node (abolish-node verify) verifies every election the anchor names with no input from the fixture, the board from its own blocks and the definition, panel and creation from the L2's logs, and each registered election's checks must equal the verifier's on the bundle (rule-7's, never registered, is skipped as l2-definition-missing); the L1 header, the clock and the L2's logs are still unproven inputs and 3.1 isn't implemented, so the verdict is unverifiable; with our servers and domain offline is P4-6",
  },
]);
