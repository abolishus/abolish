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
    note: "a 4-of-7 panel, pinned in the trustee registry on a local L2 with rule 7's quorum of 6, runs the four-round ceremony with every seat: for the elections of one question, each seat is apps/trustee-node's own ceremony duty (CeremonySeat) over a store of its own, with the stub checks before round 1 and again before approving, and the fixture only relays the rounds as coordinator; the poll of questions (definition version 5, which the node doesn't read yet) and the rolling poll (version 7) run through @abolishus/crypto; the registry records each from every seat's approval of the checked key set, and the election registry registers the definition; the transcript is board entry 0, and the verifier's 3.2 must pass on it; a ceremony of 5 seats is refused by every node that ran it (rule 7's participation) and by both registries, signed anyway; the verifier doesn't read L2 yet, so 3.1 can't pass (P1-19), and no release pins the panel (P1-7)",
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
    note: "the definition's one Tier 0 group is four voters' identity commitments, its root their tier tree, and every ballot proves membership in it with a real Semaphore proof under the pinned depth-32 key, made by the ballot client's prover (@abolishus/membership-prover) from a path rebuilt from every leaf; that root is computed by the fixture, not created in the group registry on L2 (P3-2); the rolling poll's Tier 0 group is created in the group registry and filled by records both registrars sign, its version-7 definition naming the tier tree's opening state at the L2 block of its first batch, and after the registration a voter joins and a member is removed and added again, one commitment in two leaves and so one member; the fixture derives the opening state and every accepted step from the registry's logs through @abolishus/crypto's rolling tier tree, the registry's events are archived and held by 4.4's replay, and a civic rolling definition is refused by the library's rules and the election registry with rolling-class; the rolling poll has no ballots yet (P2-17 part 4f-2), and the verifier doesn't read the registry yet (2.4, P1-19)",
  },
  {
    id: 4,
    name: "Casting, Benaloh challenge/spoil, re-voting",
    coverage: "partial",
    note: "in the honest election, three voters cast version-1 ballots in Casting's order through @abolishus/crypto, one re-voting under a later L1 block, each cast through the API's ballots.submit and boarded by its worker after the verifier's admission (P2-3), in the voting window's segment, as the very entry the fixture's board holds; the verifier must admit all four (5.1 to 5.5, 5.7), and a control election's ballot carrying another ballot's proof must be rejected at 5.1 to 5.3 alone, and the API refuses it with membership-proof before the fixture boards it anyway; a poll of three questions (pick one, pick any, pick exactly two; definition version 5, registered on L2 with its receipt key registered with the L1 anchor) gets the same: version-3 ballots sealed and cast through @abolishus/crypto's seal, one a re-vote, all four cast through the API and boarded by its worker as the very entries the fixture's board holds, with the client's receipt-key check before casting and 2.9 judging the key from L1 state; in both, one challenged attempt is opened and checked on a second context against the code shown, but not published, since an opening boarded before the counted extent breaks challenge.md's Publication rules (P1-18's window); the poll's ballots get the operator's receipts, signed by the fixture under the listed key and passing the client's check at cast, and each is judged after the seal's window from the anchors and the key's record at the finalized L1 block and the operator's entry-hash lists: the four boarded ballots' receipts must be included, a receipt for a forked board (a boarded ballot shown at another index) forked from the copy, and one for a ballot never boarded forked from L1 alone; the poll's bundle is also written in format 5, with Anvil's headers from block 0 to the finalized head, where the L1 references (5.8) and selection (6.1, the re-vote over the first ballot) must pass and the verifier's drop rule must find the forked receipt's ballot present at its entry and the never-boarded one a drop, against the bundle's inputs (every one a local file, so the drop itself stays unjudged); receipts aren't committed or opened after the dispute end; in the honest election every seat's apps/trustee-node intake (IntakeSeat: the election checks, admission, decryption, the shares held before the receipt) takes every cast ballot in, delivered to its node's intake endpoint over TLS with the hybrid post-quantum group, as the client's direct route delivers it, and refuses a ballot again once the intake cutoff has passed; in the poll, every seat takes them in through @abolishus/crypto's intake; in both, the share receipts are boarded on the board path after the window's ballots, so the verifier must find every counted ballot delivered (5.9); every election's bundle is also written in format 5",
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
    coverage: "partial",
    note: "past the close, the honest election and the poll of questions are tallied by the seats, run by the fixture through @abolishus/crypto (with the nodes' per-election keys in the honest election): each sums its shares of its cell's counted ballots (each voter's last) and seals the sums to seat 1 in a summed-share message under seat 1's registered key, which seat 1 opens and checks against its own aggregate, combines and signs as the cell's opening, boarded in the segment after the counted extent's floor; once that checkpoint is anchored, every seat's destruction statement is boarded in the next; on each format-5 bundle the verifier must pass 7.1 to 7.3 with the counts the votes cast add up to and 8.5 with every seat destroyed; there are no close statements (close-missing, P1-18), the tally and destruction duties aren't apps/trustee-node's yet (P2-13 part 5), tally.md's windows aren't waited out (no seal is derived from the definition yet), and the rejected-ballot control's ballot is never delivered, so its format-5 bundle shows tally-missing, unpinned",
  },
  {
    id: 7,
    name: "L1 anchoring",
    coverage: "partial",
    note: "the BoardAnchor contract on Anvil anchors the ceremony's segment, the voting window's, the one after it, the tally's and the seal from a stub authority, and the verifier reads them back from eth_getProof; the anchoring job and the Safe are P4-1 part 2",
  },
  {
    id: 8,
    name: "Wipe Postgres and rebuild every result from chain + IPFS",
    coverage: "partial",
    note: "the board only: each board's segment objects and entry-hash lists are published as blocks to a community node (apps/node serve), and each bundle is rebuilt from L1 alone, the checkpoints from the anchor's CheckpointAnchored logs and the copy fetched by the CIDs they name, from a blocks.car holding the node's blocks and from the node's gateway; the same objects are posted to a local Arweave node through the worker's Arweave client, listed once confirmed in manifest 0, which the fixture writes through @abolishus/crypto rather than core's archive run, and the anchor's locator-only call names it, so the honest election is also rebuilt from L1 and Arweave alone with no IPFS (4.3 must pass, the earlier locators judged from the anchor's logs), and a node withholding one object leaves it unverifiable, never failed; manifest 0 also lists the L2 contracts' evidence records, one for each anchored period that moved a contract's count, read through the worker's contract-event source over the fixture's games and index, and the runs of their events, so 4.4's replay must hold every event each contract emitted from the archive alone, and a node withholding the election registry's run leaves 4.4 unverifiable with run-gap; no Postgres is wiped yet, since nothing the fixture runs writes the board to one (P2-1, P2-4), and no result but the board is rebuilt (P1-15)",
  },
  {
    id: 9,
    name: "Independent verification by packages/verifier from chain + IPFS alone",
    coverage: "partial",
    note: "the verifier runs in its own process on the output bundle alone, the board read by CID from a block store, a community node's gateway or, found from the anchor's archive locator, a local Arweave node; then the community node (abolish-node verify) verifies every election the anchor names with no input from the fixture, the board from its own blocks and the definition, panel and creation from the L2's logs, and each registered election's checks must equal the verifier's on the bundle (rule-7's, never registered, is skipped as l2-definition-missing); the L1 header, the clock and the L2's logs are still unproven inputs and 3.1 isn't implemented, so the verdict is unverifiable; with our servers and domain offline is P4-6",
  },
]);
