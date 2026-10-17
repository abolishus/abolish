// `vp run reference-election`: the reference election (AGENTS.md, Reference
// election; P1-20). It runs every stage built so far against two local Anvils,
// an L1 and an L2,
// writes what it produced to reference-election-output/, has packages/verifier
// check that output in a process of its own, and exits non-zero if any stage
// or any expectation of the verifier's reports fails. Stages not built yet are
// listed as such in stages.json (stages.ts), which is written however the run
// ends.
//
// Besides the honest election, the run holds controls the verifier must not
// pass, each with the rows it must show, so the honest run's passes can't be
// vacuous: an election whose ceremony two seats sat out (rule 7 of
// [[0006-trustees]]), which the trustee registry must refuse to record and the
// election registry to register; an election whose board carries a ballot
// with a membership proof made for another ballot; and the honest bundle with
// its board copy altered, and one whose block store holds another election's
// board but none of its own.
//
// The board isn't handed to the verifier from the fixture's memory: its
// segment objects and entry-hash lists are published as blocks to a community
// node (apps/node),
// and each bundle is rebuilt from L1 alone, the checkpoints from the anchor's
// logs and the board copy fetched by the CIDs they name, from a block store
// exported from the node or from the node's gateway (stage 8's board, P4-3).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkChallengeOpening,
  type Checkpoint,
  copyCheckpoints,
  decodeOpening,
  type ElectionDefinition,
  encodeBallot,
  encodeCheckpoint,
  encodeDisplayText,
  encodeElectionDefinition,
  type Panel,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Rpc, startAnvil } from "./anvil.ts";
import {
  castingFor,
  castVote,
  challengeVote,
  electorateOf,
  newVoters,
  proverArtifacts,
} from "./casting.ts";
import { boardEntry, displayText, newTrustees, PANEL, runCeremony, STUBS } from "./election.ts";
import { checkBallots, checkControl, checkExpectations } from "./expectations.ts";
import { blocksCar, segmentObjects } from "./blocks.ts";
import {
  anchorAt,
  type DeployedAnchor,
  deployAnchor,
  evidence,
  l1RefAt,
  loggedCheckpoints,
  mineAt,
} from "./l1.ts";
import {
  ceremonyRegistration,
  createElection,
  deployL2,
  registerCeremony,
  registerDefinition,
} from "./l2.ts";
import { startNode } from "./node.ts";
import { anchorSlots } from "./slots.ts";
import { STAGES } from "./stages.ts";
import { runVerifier } from "./verify.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "reference-election-output");
const BOARD_ANCHOR = new URL(
  "../../../packages/contracts/out/BoardAnchor.sol/BoardAnchor.json",
  import.meta.url,
);

/** Anvil's default chain ID: a local L1 that no real network uses. */
const L1_CHAIN_ID = 31337n;
/** The local L2's: the next one, also used by no real network. */
const L2_CHAIN_ID = 31338n;
/**
 * Signatures a ceremony registration needs: rule 7's n − 1 of [[0006-trustees]],
 * so the trustee registry itself refuses a ceremony that fewer seats ran.
 */
const QUORUM = PANEL.size - 1;
// The deployed anchor's period and deadline (docs/spec/contracts.md, Board anchor).
const PERIOD = 3600n;
const DEADLINE = 43_200n;
// How far past a period's end the fixture anchors it: inside the deadline.
const ANCHOR_DELAY = 60n;
/** The Tier 0 group's size; one member never votes, so the group isn't just its voters. */
const VOTERS = 4;
/** What the verifier must find on the honest board: every ballot cast admitted, none rejected. */
const HONEST_BALLOTS = { admitted: 4, rejected: [] } as const;

const hex = (b: Uint8Array) => bytesToHex(b);
const log = (line: string) => process.stdout.write(`${line}\n`);

interface Election {
  readonly name: string;
  readonly definition: ElectionDefinition;
  readonly panel: Panel;
  readonly transcript: Uint8Array;
  readonly entries: Uint8Array[];
}

/**
 * The board copy a bundle holds: `board.bin`, a block store (`blocks.car`) to
 * read it from by CID, or neither, for a run that reads it from gateways.
 */
type Copy = { readonly board: Uint8Array } | { readonly blocks: Uint8Array } | "none";

function writeBundle(
  dir: string,
  e: Election,
  clock: { epoch: bigint; lastSegment: number },
  l1: {
    firstSegment: number;
    header: Uint8Array;
    nodes: readonly Uint8Array[];
    checkpoints: readonly Checkpoint[];
  },
  copy: Copy,
): void {
  mkdirSync(dir, { recursive: true });
  const bundle = {
    format: "abolish-verifier-bundle/4",
    definition: hex(encodeElectionDefinition(e.definition)),
    clock: {
      epoch: clock.epoch.toString(),
      period: PERIOD.toString(),
      deadline: DEADLINE.toString(),
      lastSegment: clock.lastSegment.toString(),
    },
    l1: {
      firstSegment: l1.firstSegment.toString(),
      header: hex(l1.header),
      nodes: l1.nodes.map(hex),
      checkpoints: l1.checkpoints.map((c) => hex(encodeCheckpoint(c))),
    },
    panel: { threshold: e.panel.threshold.toString(), keys: e.panel.keys.map(hex) },
  };
  writeFileSync(join(dir, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  if (copy === "none") return;
  if ("board" in copy) writeFileSync(join(dir, "board.bin"), copy.board);
  else writeFileSync(join(dir, "blocks.car"), copy.blocks);
}

/** Verifies `dir`, keeps the report next to it, and returns what fell short. */
function verify(
  dir: string,
  judge: (run: ReturnType<typeof runVerifier>) => string[],
  options: readonly string[] = [],
): string[] {
  const run = runVerifier(dir, options);
  writeFileSync(`${dir}-report.json`, run.stdout);
  return judge(run);
}

async function run(anvil: Rpc, l2Anvil: Rpc, failures: string[]): Promise<void> {
  const genesis = await anvil.call<{ timestamp: string }>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  const now = BigInt(genesis.timestamp);
  // The clock starts a period before now, so the elections' first segment is 1.
  const epoch = (now / PERIOD) * PERIOD - PERIOD;
  const anchor: DeployedAnchor = await deployAnchor(anvil, BOARD_ANCHOR, {
    epoch,
    period: PERIOD,
    deadline: DEADLINE,
  });
  const end = (s: number) => epoch + (BigInt(s) + 1n) * PERIOD;
  // The ceremony's segment, the voting window's (ballots are boarded in it)
  // and the seal, which repeats the board's state after the window.
  const first = Number((now - epoch) / PERIOD);
  const cast = first + 1;
  const seal = first + 2;
  log(`L1: Anvil (chain ${L1_CHAIN_ID}), BoardAnchor at 0x${hex(anchor.address)}`);

  // The panel, pinned in the L2's trustee registry at deployment.
  const trustees = newTrustees();
  // Stage 4's voters: one Tier 0 group, whose root every definition names.
  const voters = newVoters(VOTERS);
  const electorate = electorateOf(voters);
  const l2 = await deployL2(l2Anvil, anvil, {
    l2ChainId: L2_CHAIN_ID,
    l1ChainId: L1_CHAIN_ID,
    l1Anchor: anchor.address,
    epoch,
    panel: trustees.panel,
    quorum: QUORUM,
  });
  log(
    `L2: Anvil (chain ${L2_CHAIN_ID}), election registry at 0x${hex(l2.electionRegistry)}, trustee registry at 0x${hex(l2.trusteeRegistry)}`,
  );

  // Stage 1: each election created on L2, its ceremony, the ceremony and the
  // definition registered there, and its board, which holds the transcript in
  // the first segment.
  const timing = {
    l1ChainId: L1_CHAIN_ID,
    l1Anchor: anchor.address,
    opensAt: end(first),
    closesAt: end(first) + PERIOD / 2n,
    inclusionBound: 600,
  };
  const elections: Election[] = [];
  for (const [name, absent] of [
    ["honest", 0],
    ["rule-7", 2],
    ["rejected-ballot", 0],
  ] as const) {
    const text = displayText();
    const counter = await createElection(l2, anvil);
    const c = runCeremony(timing, l2, trustees, text, { counter, absent, electorate });
    const record = ceremonyRegistration(l2, trustees, c);
    if (absent === 0) {
      await registerCeremony(l2, anvil, record);
      await registerDefinition(l2, anvil, c.definition);
    } else {
      // Its five seats are under the quorum, so no definition can name it.
      await registerCeremony(l2, anvil, record, "BelowQuorum(uint256,uint8)");
      await registerDefinition(l2, anvil, c.definition, "CeremonyNotRecorded(bytes32,bytes32)");
    }
    const dir = join(OUT, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "definition.bin"), encodeElectionDefinition(c.definition));
    writeFileSync(join(dir, "ceremony-transcript.bin"), c.transcript);
    writeFileSync(join(dir, "display-text.bin"), encodeDisplayText(text));
    log(
      `stage 1 (${name}): ${c.panel.threshold}-of-${c.panel.keys.length} ceremony with ${c.panel.keys.length - absent} seats, election 0x${hex(c.definition.election_id)}, ${absent === 0 ? "registered on L2" : "refused by both registries"}`,
    );
    elections.push({
      name,
      definition: c.definition,
      panel: c.panel,
      transcript: c.transcript,
      entries: [boardEntry(c.definition, 0n, first, c.transcript)],
    });
  }

  // Stage 7: each period's checkpoints anchored in one call, inside its
  // window. A segment with nothing appended in it, the seal's always,
  // repeats the board's state after the last one that has.
  const checkpointsAt = (segment: number) =>
    elections.map((e) => {
      const copies = copyCheckpoints(e.definition.election_id, e.entries, [first, cast]);
      const c = (segment >= cast ? copies.get(cast) : undefined) ?? copies.get(first);
      if (c === undefined) throw new Error(`no checkpoint for segment ${segment}`);
      return { ...c, segment };
    });
  await anchorAt(anvil, anchor, checkpointsAt(first), end(first) + ANCHOR_DELAY);

  // Stage 4, in the voting window: two L1 blocks for ballots to name, then
  // each election's ballots, boarded in the window's segment.
  const refs = [
    await l1RefAt(anvil, timing.opensAt + 120n),
    await l1RefAt(anvil, timing.opensAt + 240n),
  ] as const;
  const artifacts = proverArtifacts();
  const [honest, , rejected] = elections;
  if (honest === undefined || rejected === undefined) throw new Error("an election is missing");
  const board = (e: Election, payload: Uint8Array) =>
    e.entries.push(boardEntry(e.definition, BigInt(e.entries.length), cast, payload));
  {
    const casting = castingFor(
      honest.definition,
      honest.panel,
      honest.transcript,
      electorate,
      artifacts,
    );
    // The checker: the voter's second device, with a context of its own from
    // the same records (challenge.md, Client rules, the checker's).
    const checker = castingFor(
      honest.definition,
      honest.panel,
      honest.transcript,
      electorate,
      artifacts,
    );
    // Voter 0 challenges an attempt, checks its opening on the checker
    // against the code it was shown, then casts.
    const challenged = challengeVote(casting, [1, 0, 0]);
    const opened = checkChallengeOpening(checker.election, decodeOpening(challenged.opening, 1));
    if (
      !opened.ok ||
      hex(opened.coreHash) !== hex(challenged.shown) ||
      opened.votes.join() !== "1,0,0" ||
      !opened.withinRules
    )
      throw new Error("an honest challenge failed its check");
    const [v0, v1, v2] = voters;
    if (v0 === undefined || v1 === undefined || v2 === undefined) throw new Error("too few voters");
    // Voter 1 re-votes under a later block; voter 3 never votes.
    for (const [voter, votes, ref] of [
      [v0, [1, 0, 0], refs[0]],
      [v1, [0, 1, 0], refs[0]],
      [v2, [0, 0, 0], refs[0]],
      [v1, [0, 0, 1], refs[1]],
    ] as const)
      board(honest, (await castVote(casting, voter, votes, ref)).bytes);
    log(
      `stage 4 (honest): ${honest.entries.length - 1} ballots with real membership proofs boarded in segment ${cast}, one a re-vote; one challenged attempt checked`,
    );
  }
  {
    // A control: one honest ballot, then the same ballot naming the later
    // block with the proof unchanged, so its M is another and its proof
    // fails (T-38, T-45).
    const casting = castingFor(
      rejected.definition,
      rejected.panel,
      rejected.transcript,
      electorate,
      artifacts,
    );
    const [v0] = voters;
    if (v0 === undefined) throw new Error("too few voters");
    const ballot = await castVote(casting, v0, [0, 1, 0], refs[0]);
    board(rejected, ballot.bytes);
    board(
      rejected,
      encodeBallot({ ...ballot.record, l1_ref_number: refs[1].number, l1_ref_hash: refs[1].hash }),
    );
    log(`stage 4 (rejected-ballot): an honest ballot, then one whose proof is another ballot's`);
  }

  await anchorAt(anvil, anchor, checkpointsAt(cast), end(cast) + ANCHOR_DELAY);
  await anchorAt(anvil, anchor, checkpointsAt(seal), end(seal) + ANCHOR_DELAY);
  // Past the seal's deadline, so the board checks see closed boards; then
  // enough blocks that Anvil's finalized block includes every anchor.
  const after = end(seal) + DEADLINE + 1n;
  for (let i = 0n; i < 70n; i++) await mineAt(anvil, after + i * 12n);

  log(`stage 7: segments ${first} to ${seal} (the seal) anchored for each election`);

  // Stage 8, the board: each election's segment objects and entry-hash lists
  // published as blocks to a community node, which serves them by CID from
  // here on.
  const mirror = join(OUT, "node", "blocks");
  mkdirSync(mirror, { recursive: true });
  for (const e of elections)
    writeFileSync(
      join(mirror, `${e.name}.car`),
      blocksCar(segmentObjects(e.entries).flatMap((s) => [s.object, s.hashes])),
    );
  const node = await startNode(mirror);
  log(
    `stage 8: each board's segment objects and entry-hash lists mirrored by apps/node at ${node.url}`,
  );
  try {
    // Stage 9: the verifier, on each bundle alone, with the board rebuilt from
    // L1: the checkpoints from the anchor's logs, the copy by the CIDs they name.
    for (const e of elections) {
      const id = e.definition.election_id;
      const l1 = await evidence(anvil, anchor.address, anchorSlots(id, first, seal));
      if (l1.timestamp < after) throw new Error("the finalized block is before the anchors");
      const checkpoints = await loggedCheckpoints(anvil, anchor.address, id);
      const clock = { epoch, lastSegment: seal };
      const evidenceFor = { firstSegment: first, header: l1.header, nodes: l1.nodes, checkpoints };
      const dir = join(OUT, e.name, "bundle");
      // A block store holding exactly what the node mirrors for this election,
      // as a user would export it from any node holding the same blocks.
      const blocks = readFileSync(join(mirror, `${e.name}.car`));
      writeBundle(dir, e, clock, evidenceFor, { blocks });
      if (e.name === "honest") {
        failures.push(...verify(dir, (r) => checkExpectations(r, "blocks.car", HONEST_BALLOTS)));
        // The same election read from the node's gateway alone, no copy in the bundle.
        const fromNode = join(OUT, "honest", "bundle-from-node");
        writeBundle(fromNode, e, clock, evidenceFor, "none");
        failures.push(
          ...verify(fromNode, (r) => checkExpectations(r, "gateway", HONEST_BALLOTS), [
            "--gateway",
            node.url,
          ]),
        );
        // A control: the honest bundle with one byte of its transcript flipped
        // in board.bin, and no logged checkpoint given. The copy no longer
        // matches its anchors, nor the definition's hash.
        const [transcript, ...rest] = e.entries.map((x) => Buffer.from(x));
        if (transcript === undefined) throw new Error("the honest board is empty");
        transcript[transcript.length - 1] = (transcript.at(-1) as number) ^ 1;
        const tampered = Buffer.concat([transcript, ...rest]);
        const control = join(OUT, "honest", "control-tampered-copy");
        writeBundle(control, e, clock, { ...evidenceFor, checkpoints: [] }, { board: tampered });
        failures.push(
          ...verify(control, (r) =>
            checkControl("tampered-copy", r, {
              "3.1": { status: "unverifiable", code: "ceremony-transcript-missing" },
              "3.2": { status: "unverifiable", code: "not-reached" },
              "4.2": { status: "unverifiable", code: "l1-checkpoint-unknown" },
            }),
          ),
        );
        // A control: a well-formed block store holding another election's
        // board (rule-7's) and none of this one's. Withholding leaves the
        // election unverifiable from that store, never failed (T-53).
        const withheld = join(OUT, "honest", "control-withheld-blocks");
        const others = readFileSync(join(mirror, "rule-7.car"));
        writeBundle(withheld, e, clock, evidenceFor, { blocks: others });
        failures.push(
          ...verify(withheld, (r) =>
            checkControl("withheld-blocks", r, {
              "3.1": { status: "unverifiable", code: "ceremony-transcript-missing" },
              "3.2": { status: "unverifiable", code: "not-reached" },
              "4.1": { status: "unverifiable", code: "checkpoint-missing" },
              "4.2": { status: "unverifiable", code: "checkpoint-missing" },
            }),
          ),
        );
      } else if (e.name === "rejected-ballot") {
        // A control: the second ballot's proof is the first's, made for
        // another M, so the verifier must reject that entry alone, at 5.1 to
        // 5.3, and still admit the first.
        failures.push(
          ...verify(dir, (r) => [
            ...checkControl("rejected-ballot", r, {
              "3.2": { status: "pass" },
              "4.1": { status: "pass" },
              "4.2": { status: "pass" },
              "5.1": { status: "fail", code: "membership-proof" },
              "5.2": { status: "fail", code: "membership-proof" },
              "5.3": { status: "fail", code: "membership-proof" },
              "5.4": { status: "pass" },
            }),
            ...checkBallots("rejected-ballot", r, {
              admitted: 1,
              rejected: [{ entry: 2, code: "membership-proof" }],
            }),
          ]),
        );
      } else {
        // A control: anchored and well formed, but only 5 of 7 seats took part,
        // under rule 7's 6: the verifier must fail the election on 3.2 alone.
        failures.push(
          ...verify(dir, (r) =>
            checkControl("rule-7", r, {
              "3.2": { status: "fail", code: "ceremony-participation" },
              "4.1": { status: "pass" },
              "4.2": { status: "pass" },
            }),
          ),
        );
      }
    }
  } finally {
    await node.stop();
  }
}

async function main(): Promise<number> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const failures: string[] = [];
  try {
    const anvil = await startAnvil(L1_CHAIN_ID);
    try {
      const l2 = await startAnvil(L2_CHAIN_ID);
      try {
        await run(anvil, l2, failures);
      } finally {
        await l2.stop();
      }
    } finally {
      await anvil.stop();
    }
  } catch (e) {
    failures.push(`the run stopped: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    writeFileSync(
      join(OUT, "stages.json"),
      `${JSON.stringify({ stages: STAGES, stubs: STUBS, failures }, null, 2)}\n`,
    );
    for (const f of failures) process.stderr.write(`reference election: ${f}\n`);
    const partial = STAGES.filter((s) => s.coverage !== "covered").map((s) => s.id);
    log(`stages not yet fully covered: ${partial.join(", ")} (stages.json)`);
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
