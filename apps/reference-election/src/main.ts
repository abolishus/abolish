// `vp run reference-election`: the reference election (AGENTS.md, Reference
// election; P1-20). It runs every stage built so far against two local Anvils,
// an L1 and an L2,
// writes what it produced to reference-election-output/, has packages/verifier
// check that output in a process of its own, and exits non-zero if any stage
// or any expectation of the verifier's reports fails. Stages not built yet are
// listed as such in stages.json (stages.ts), which is written however the run
// ends.
//
// Beside the honest election runs a poll of three questions under
// definition version 5 (P2-14), which must verify as the honest one does.
// A rolling poll under definition version 7 (P2-17) is registered over a
// group the run creates and changes in the group registry, its opening state
// and steps derived from the registry's events; its ballots, against a step
// before a voter joins and the next, go straight to the board's rolling call,
// and the operator carries them to the poll's board. Every seat takes them in
// against the step roots it computes, its receipts are boarded, and past the
// close the poll is tallied and sealed as the others are; its verifier run
// isn't built yet (P2-17 part 4f-2b-2b), so the node stops it at 2.3.
// Its ballots get receipts signed by the fixture as board operator, among
// them one for a forked board and one for a ballot it never boards, which
// the voter's later checks must find from L1, and the verifier's drop rule
// must tell apart over the poll's bundle in format 5: the first ballot is on
// the board, the second dropped (P1-13b).
//
// Every seat takes each ballot of the honest election and the poll in, and
// its share receipts are boarded; past the close the seats tally each over
// its counted ballots and then state destruction (stage 6), which the
// verifier must find in each format-5 bundle, with the counts the votes cast
// add up to.
// Besides these, the run holds controls the verifier must not
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
// The node then verifies every election itself (`abolish-node verify`), from
// its blocks and the two chains alone, and must find what the verifier found.
// The same objects are archived on a local Arweave node, and the honest
// election is read again from L1 and Arweave alone (stage 8's archive, P4-3).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ballotHashV5,
  checkChallengeOpening,
  checkChallengeOpeningV2,
  checkShareReceiptV5,
  type Checkpoint,
  copyCheckpoints,
  decodeOpening,
  decodeTallyOpening,
  deliveryDeadlines,
  type ElectionDefinition,
  encodeBallot,
  encodeCheckpoint,
  encodeDisplayText,
  encodeDisplayTextV2,
  encodeShareReceiptV2,
  identityKey,
  intakeBallotV5,
  MembershipProverError,
  POLL_CLASSES,
  isReceiptAlarm,
  objectCid,
  type Panel,
  receiptKeysCastCheck,
  type RegisteredKeys,
  type RollingTier,
  rootClockBoundary,
  shareReceiptRecordV2,
  rootClockStepAtOrBefore,
  rootStepWindow,
  RollingTierTree,
  rollingTierSteps,
  SEAT_PANELS,
} from "@abolishus/crypto";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { startApi } from "./api.ts";
import { type Anvil, startAnvil } from "./anvil.ts";
import { archiveObjects } from "./archive.ts";
import { contractEventObjects } from "./contract-events.ts";
import { type LocalArweave, startArweave } from "./arweave.ts";
import {
  castingFor,
  castQuestions,
  castRolling,
  type CastRollingBallot,
  castVote,
  challengeQuestions,
  challengeVote,
  electorateOf,
  newVoters,
  proverArtifacts,
  questionCastingFor,
  rollingCastingFor,
  type StepTree,
  stepTree,
} from "./casting.ts";
import {
  boardEntry,
  boundDefinition,
  type Ceremony,
  definitionBytes,
  displayText,
  type FixtureDefinition,
  newTrustees,
  PANEL,
  questionsDisplayText,
  rollingDisplayText,
  runQuestionCeremony,
  runRollingCeremony,
  singleStub,
  STUBS,
} from "./election.ts";
import {
  checkBallots,
  checkArchivedEvents,
  checkControl,
  checkExpectations,
  checkSelected,
  checkTallied,
} from "./expectations.ts";
import { blocksCar, segmentObjects } from "./blocks.ts";
import { addMembers, createGroup, groupEvents, removeMembers } from "./groups.ts";
import {
  allAnchorLogs,
  anchorAt,
  type AnchorLog,
  type DeployedAnchor,
  deployAnchor,
  evidence,
  headers,
  l1RefAt,
  locateAt,
  loggedAnchors,
  loggedCheckpoints,
  mineAt,
  registerReceiptKey,
  storageWords,
} from "./l1.ts";
import {
  ceremonyRegistration,
  createElection,
  deployL2,
  registerCeremony,
  registerDefinition,
  registrationCheck,
  rollingBallotLogs,
  submitRollingBallot,
} from "./l2.ts";
import { nodeVerify, startNode } from "./node.ts";
import {
  checkAtCast,
  dropIs,
  judge,
  type JudgeView,
  operatorReceipt,
  type Receipted,
  receiptElection,
  verdictIs,
} from "./receipts.ts";
import { accumulatorSlots, anchorSlots, locatorSlots, receiptKeySlot } from "./slots.ts";
import {
  deliver,
  electorateCheck,
  nodeCeremony,
  nodeIntake,
  nodeKeys,
  registrationFrom,
  serveSeats,
  startSeats,
  stubOf,
} from "./seats.ts";
import { STAGES } from "./stages.ts";
import { type Counted, destructionStatements, intake, tallyOpening } from "./tally.ts";
import { judgeDrops, runVerifier, type VerifierRun } from "./verify.ts";

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
/**
 * The row the multi-question poll must pass beyond the honest run's: its
 * receipt key judged from the anchor's record, proven from L1 state (2.9).
 */
const QUESTIONS_PASSES = ["2.9"] as const;

const hex = (b: Uint8Array) => bytesToHex(b);
const log = (line: string) => process.stdout.write(`${line}\n`);

interface Election<D extends FixtureDefinition = FixtureDefinition> {
  readonly name: string;
  readonly definition: D;
  readonly panel: Panel;
  readonly transcript: Uint8Array;
  /**
   * Each seat's per-election secrets, for the tally and destruction statements
   * the fixture runs: read from each seat's trustee node in the elections of
   * one question, the fixture's own in the poll.
   */
  readonly secrets: Ceremony["secrets"];
  readonly entries: Uint8Array[];
}

/** Writes the records anyone reads the election from beside its bundle: the definition, transcript and display text. */
function writeRecords(name: string, c: Ceremony, text: Uint8Array): void {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "definition.bin"), definitionBytes(c.definition));
  writeFileSync(join(dir, "ceremony-transcript.bin"), c.transcript);
  writeFileSync(join(dir, "display-text.bin"), text);
}

/** The election as its board starts: the ceremony's transcript, entry 0, in `segment`. */
function firstEntry<D extends FixtureDefinition>(
  name: string,
  c: Ceremony<D>,
  segment: number,
): Election<D> {
  return {
    name,
    definition: c.definition,
    panel: c.panel,
    transcript: c.transcript,
    secrets: c.secrets,
    entries: [boardEntry(c.definition, 0n, segment, c.transcript)],
  };
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
    /**
     * For format 5, the run of headers from block 0 to the finalized head
     * `header` names; format 4 without.
     */
    blocks?: readonly Uint8Array[];
    /** The anchor's every log up to `header`, for the earlier archive locators (4.3). */
    logs?: readonly AnchorLog[];
  },
  copy: Copy,
): void {
  mkdirSync(dir, { recursive: true });
  const bundle = {
    format: l1.blocks === undefined ? "abolish-verifier-bundle/4" : "abolish-verifier-bundle/5",
    definition: hex(definitionBytes(e.definition)),
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
    ...(l1.blocks === undefined ? {} : { l1Blocks: l1.blocks.map(hex) }),
    ...(l1.logs === undefined
      ? {}
      : {
          anchorLogs: l1.logs.map((g) => ({
            block: g.block.toString(),
            timestamp: g.timestamp.toString(),
            topics: g.topics.map(hex),
            data: hex(g.data),
          })),
        }),
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

async function run(
  anvil: Anvil,
  l2Anvil: Anvil,
  arweave: LocalArweave,
  stores: string,
  failures: string[],
): Promise<void> {
  // Each L1 block a second after the one before unless a step sets its time:
  // Anvil otherwise mines blocks within one wall-clock second at one
  // timestamp, and a run of finalized headers (format 5) must have them
  // strictly increasing, as Ethereum's are (docs/spec/verifier.md, Bundle).
  await anvil.call("anvil_setBlockTimestampInterval", [1]);
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
  // The ceremony's segment; the voting window's, where ballots and their
  // share receipts are boarded; the one after it, `period(closes_at) + 1`,
  // the floor of the counted extent's last segment (docs/spec/tally.md,
  // Tally window), with nothing appended; the tally's, where each cell's
  // opening is boarded; and the seal, where each seat's destruction
  // statement is, after the tally's checkpoint is anchored.
  const first = Number((now - epoch) / PERIOD);
  const cast = first + 1;
  const closed = first + 2;
  const tallied = first + 3;
  const seal = first + 4;
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
  // The panel's nodes, which run the ceremonies and intake of the elections
  // of one question (definition version 1, the one the node reads): their
  // registration check reads the registries' logs on the L2, and their clock
  // is the L1's time as the run moves it.
  let l1Time = now;
  const nodes = await startSeats(stores, trustees, {
    l2ChainId: L2_CHAIN_ID,
    trusteeRegistry: l2.trusteeRegistry,
    electorate: electorateCheck(electorate),
    registration: registrationCheck(l2, L2_CHAIN_ID),
    now: () => l1Time,
  });
  // Elections of one question (definition version 1), then the poll of
  // questions (version 5).
  const singles: Election<{ readonly version: 1; readonly value: ElectionDefinition }>[] = [];
  for (const [name, absent] of [
    ["honest", 0],
    ["rule-7", 2],
    ["rejected-ballot", 0],
  ] as const) {
    const text = displayText();
    const counter = await createElection(l2, anvil);
    const stub = singleStub(timing, l2, trustees.panel, text, { counter, electorate });
    const ran = await nodeCeremony(nodes, stub, absent);
    const definition = boundDefinition(stub, ran.transcript);
    const c: Ceremony<typeof definition> = {
      panel: trustees.panel,
      definition,
      transcript: ran.transcript,
      seats: trustees.seats.slice(0, trustees.seats.length - absent),
      secrets: await nodeKeys(nodes, ran.stubHash),
    };
    if (absent === 0) {
      const approvals = ran.approvals.map((a, i) => {
        if (!a.ok)
          throw new Error(`seat ${i + 1} refused to approve ${name}'s ceremony: ${a.code}`);
        return a.value;
      });
      await registerCeremony(l2, anvil, registrationFrom(stub, trustees.panel, ran, approvals));
      await registerDefinition(l2, anvil, definition);
    } else {
      // Five seats are under rule 7's quorum: every node that took part
      // refuses to approve (T-54), and the registries refuse the ceremony
      // even when its seats sign it anyway, so no definition can name it.
      const approved = ran.approvals.filter((a) => a.ok || a.code !== "participation");
      if (approved.length > 0)
        throw new Error(
          `${approved.length} nodes didn't refuse ${name}'s ceremony for participation`,
        );
      const record = ceremonyRegistration(l2, trustees, c);
      await registerCeremony(l2, anvil, record, "BelowQuorum(uint256,uint8)");
      await registerDefinition(l2, anvil, c.definition, "CeremonyNotRecorded(bytes32,bytes32)");
    }
    writeRecords(name, c, encodeDisplayText(text));
    log(
      `stage 1 (${name}): ${c.panel.threshold}-of-${c.panel.keys.length} ceremony run by ${c.panel.keys.length - absent} trustee nodes, election 0x${hex(c.definition.value.election_id)}, ${absent === 0 ? "approved by every node and registered on L2" : "refused by every node and both registries"}`,
    );
    singles.push(firstEntry(name, c, first));
  }
  // The poll of questions (P2-14): its receipt key registered with the anchor
  // before the poll opens, so 2.9 judges it from L1 (T-26, T-69), and listed
  // in the stub. The fixture, as the board operator, signs its receipts.
  const receiptSecret = crypto.getRandomValues(new Uint8Array(32));
  const receiptKey = identityKey(receiptSecret);
  await registerReceiptKey(anvil, anchor, receiptKey);
  const questionsText = questionsDisplayText();
  const poll = runQuestionCeremony(timing, l2, trustees, questionsText, {
    counter: await createElection(l2, anvil),
    leaves: electorate.leaves,
    receiptKeys: [receiptKey],
  });
  await registerCeremony(l2, anvil, ceremonyRegistration(l2, trustees, poll));
  await registerDefinition(l2, anvil, poll.definition);
  writeRecords("questions", poll, encodeDisplayTextV2(questionsText));
  log(
    `stage 1 (questions): ${poll.definition.value.questions.length} questions, ${poll.panel.threshold}-of-${poll.panel.keys.length} ceremony with ${poll.seats.length} seats, election 0x${hex(poll.definition.value.election_id)}, registered on L2 under definition version 5`,
  );
  const questions = firstEntry("questions", poll, first);
  const elections: Election[] = [...singles, questions];

  // The rolling poll (P2-17 part 4f; [[0028-rolling-electorates]]): its Tier 0
  // group created in the group registry and filled by the registrars' signed
  // records, so the tier's opening state is the tree through the L2 block of
  // its first batch; then the definition naming that state, registered after
  // it (rule 7), and the group changed after the registration: a voter
  // joining (voter 3) and a member removed and added again (voter 1), whose
  // two leaves are one commitment, so one member (T-16). It lists the poll of
  // questions' receipt key, already registered with the anchor. Its ballots
  // are cast in the voting window, below.
  const rolling = await (async () => {
    const group = await createGroup(l2, anvil);
    const [v0, v1, v2, v3] = voters;
    if (v0 === undefined || v1 === undefined || v2 === undefined || v3 === undefined)
      throw new Error("too few voters");
    await addMembers(
      l2,
      anvil,
      group,
      0n,
      [v0, v1, v2].map((v) => v.commitment),
    );
    const rootL2Block = BigInt(await l2Anvil.call<string>("eth_blockNumber"));
    const openingTree = new RollingTierTree([group]);
    for (const event of await groupEvents(l2)) openingTree.apply(event);
    const tier: RollingTier = {
      tier: 0,
      root_l2_block: rootL2Block,
      groups: [group],
      root: openingTree.root(),
      group_size: BigInt(openingTree.memberCount),
    };
    const text = rollingDisplayText();
    const ran = runRollingCeremony(timing, l2, trustees, text, {
      counter: await createElection(l2, anvil),
      pollClass: POLL_CLASSES.everyday,
      tier,
      receiptKeys: [receiptKey],
    });
    if (ran.failure !== undefined)
      throw new Error(`the rolling poll's definition breaks ${ran.failure.rule}`);
    const c = ran.ceremony;
    await registerCeremony(l2, anvil, ceremonyRegistration(l2, trustees, c));
    await registerDefinition(l2, anvil, c.definition);
    const registeredAt = BigInt(
      (await l2Anvil.call<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]))
        .timestamp,
    );
    writeRecords("rolling", c, encodeDisplayTextV2(text));
    // A control: the same tier on the civic record, which must keep a fixed
    // electorate. The library's rules and the registry both refuse it with
    // `rolling-class`, before any ceremony is asked for (rule 3; T-01, T-16).
    const civic = runRollingCeremony(timing, l2, trustees, rollingDisplayText(), {
      counter: await createElection(l2, anvil),
      pollClass: POLL_CLASSES.civicReferendum,
      tier,
      receiptKeys: [receiptKey],
    });
    if (civic.failure?.rule !== "rolling-class")
      throw new Error(`a civic rolling poll breaks ${civic.failure?.rule ?? "no rule"}`);
    await registerDefinition(l2, anvil, civic.ceremony.definition, "DefinitionIllFormed(uint8)");
    // After the registration: voter 3 joins, and voter 1 is removed and added
    // again, all in L2 blocks after the first boundary past the registration,
    // so that step's tree is the opening one and the next step's holds every
    // change: a ballot proving against either is a ballot of an accepted step.
    const before = (rootClockStepAtOrBefore(registeredAt) ?? -1n) + 1n;
    const latest = BigInt(
      (await l2Anvil.call<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]))
        .timestamp,
    );
    const after = rootClockBoundary(before) + 1n;
    await l2Anvil.call("evm_setNextBlockTimestamp", [Number(after > latest ? after : latest + 1n)]);
    await addMembers(l2, anvil, group, 3n, [v3.commitment]);
    await removeMembers(l2, anvil, group, 4n, [1n]);
    await addMembers(l2, anvil, group, 4n, [v1.commitment]);
    // The tier's opening state and its accepted steps, as a verifier derives
    // them from the registry's events alone (membership.md, Root clock and
    // steps): the opening state must be the one the registry took, and the
    // newest step by the close must hold every change, with voter 1 once.
    const events = await groupEvents(l2);
    const { closes_at: closesAt } = c.definition.value;
    const boundaries: bigint[] = [];
    for (
      let n = (rootClockStepAtOrBefore(registeredAt) ?? 0n) + 1n;
      rootClockBoundary(n) <= closesAt;
      n++
    )
      boundaries.push(n);
    const derived = rollingTierSteps(
      events,
      { groups: [group], rootL2Block, registeredAt, closesAt },
      boundaries,
    );
    if (
      derived.opening.root !== tier.root ||
      BigInt(derived.opening.memberCount) !== tier.group_size
    )
      throw new Error("the rolling tier's opening state isn't the one its definition names");
    const steps = derived.steps.filter((s) => s.accepted);
    const last = steps.at(-1);
    const early = steps.find((s) => s.step === before);
    const next = steps.find((s) => s.step === before + 1n);
    if (early === undefined || early.size !== 3 || early.memberCount !== 3)
      throw new Error("the rolling tier's step before voter 3 joined isn't the opening tree");
    if (next === undefined || next.size !== 5 || next.memberCount !== 4)
      throw new Error("the rolling tier's step after voter 3 joined doesn't hold every change");
    if (last === undefined || last.size !== 5 || last.memberCount !== 4)
      throw new Error(
        `the rolling tier's newest step by the close holds ${last?.size ?? 0} leaves and ${last?.memberCount ?? 0} members, not 5 and 4`,
      );
    writeFileSync(
      join(OUT, "rolling", "electorate.json"),
      `${JSON.stringify(
        {
          group: group.toString(),
          rootL2Block: rootL2Block.toString(),
          registeredAt: registeredAt.toString(),
          events: events.map((e) => ({
            blockNumber: e.blockNumber.toString(),
            timestamp: e.timestamp.toString(),
            groupId: e.groupId.toString(),
            ...(e.kind === "add"
              ? { kind: e.kind, commitments: e.commitments.map(String) }
              : { kind: e.kind, indices: e.indices.map(String) }),
          })),
          opening: { root: derived.opening.root.toString(), members: derived.opening.memberCount },
          steps: steps.map((s) => ({
            step: s.step.toString(),
            root: s.root.toString(),
            leaves: s.size,
            members: s.memberCount,
          })),
        },
        null,
        2,
      )}\n`,
    );
    log(
      `stage 3 (rolling): group ${group} created in the group registry and filled by both registrars' records; the poll's version-7 definition, opening with ${tier.group_size} members at L2 block ${rootL2Block}, registered on L2 after a ceremony of ${c.seats.length} seats, and a civic one refused with rolling-class; then, after step ${before}'s boundary, voter 3 added and voter 1 removed and added again, so ${steps.length} accepted steps, the newest with ${last.size} leaves and ${last.memberCount} members`,
    );
    return {
      ceremony: c,
      board: firstEntry("rolling", c, first),
      group,
      registeredAt,
      events,
      early: before,
      late: before + 1n,
    };
  })();
  // Every board the operator keeps and anchors: the rolling poll's beside the
  // others, whose verifier runs (stage 9) don't yet take a rolling poll.
  const boards: Election[] = [...elections, rolling.board];

  // Stage 7: each period's checkpoints anchored in one call, inside its
  // window. A segment with nothing appended in it repeats the board's state
  // after the last one that has.
  const appended = [first, cast, tallied, seal];
  const checkpointsAt = (segment: number) =>
    boards.map((e) => {
      const copies = copyCheckpoints(e.definition.value.election_id, e.entries, appended);
      const at = appended.filter((s) => s <= segment && copies.has(s)).at(-1);
      const c = at === undefined ? undefined : copies.get(at);
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
  const [honest, , rejected] = singles;
  if (honest === undefined || rejected === undefined) throw new Error("an election is missing");
  const board = (e: Election, payload: Uint8Array, segment = cast) =>
    e.entries.push(boardEntry(e.definition, BigInt(e.entries.length), segment, payload));
  // Each election's counted ballots, for stage 6: every voter's last ballot,
  // the one selection keeps (docs/spec/revoting.md), with the shares every
  // seat took from it; the key set the seats' messages go under; and the
  // counts per option their votes add up to, which the verifier must report.
  const counted = new Map<
    Election,
    {
      readonly ballots: readonly Counted[];
      readonly registered: readonly RegisteredKeys[];
      readonly counts: readonly number[];
    }
  >();
  const countsOf = (votes: Iterable<readonly number[]>) =>
    [...votes].reduce<number[]>((sum, v) => v.map((x, j) => x + (sum[j] ?? 0)), []);
  // The poll's receipts, each with the verdict its voter's later check must reach.
  const receipts: Receipted[] = [];
  // Every election takes its ballots through the operator's API, its worker
  // judging each by the verifier's admission before boarding it (P2-3; T-17,
  // T-38, T-52), the poll of questions under definition version 5 and ballot
  // version 3: what it answers must be the very entry the fixture's board
  // holds at that position, so the verifier's judgement of that board is a
  // judgement of what the API boarded.
  const api = await startApi({
    panels: [trustees.panel],
    clock: { epoch, period: PERIOD },
    now: () => l1Time,
  });
  // Every election's ballots are cast at the same L1 time, in the window,
  // the honest election's last, since its cutoff control moves the clock
  // past the close.
  l1Time = timing.opensAt + 240n;
  try {
    for (const e of [honest, rejected, questions])
      await api.open(
        definitionBytes(e.definition),
        e.definition.value.election_id,
        first,
        e.transcript,
      );
    /** Casts `payload` through the API, which must board it as `e`'s next entry. */
    const submitted = async (e: Election, payload: Uint8Array) => {
      const r = await api.submit(e.definition.value.election_id, payload);
      if (!r.ok) throw new Error(`the API refused ${e.name}'s ballot: ${r.code} (${r.admission})`);
      board(e, payload);
      if (hex(r.entry) !== hex(e.entries.at(-1) ?? new Uint8Array()))
        throw new Error(`the API boarded ${e.name}'s ballot as another entry than the fixture's`);
    };
    {
      // A control: one honest ballot, then the same ballot naming the later
      // block with the proof unchanged, so its M is another and its proof
      // fails (T-38, T-45).
      const casting = castingFor(
        rejected.definition.value,
        rejected.panel,
        rejected.transcript,
        electorate,
        artifacts,
      );
      const [v0] = voters;
      if (v0 === undefined) throw new Error("too few voters");
      const ballot = await castVote(casting, v0, [0, 1, 0], refs[0]);
      await submitted(rejected, ballot.bytes);
      // The API refuses the forged one with the code the verifier's report
      // must give it; the fixture boards it anyway, as an operator that skipped
      // admission would.
      const forged = encodeBallot({
        ...ballot.record,
        l1_ref_number: refs[1].number,
        l1_ref_hash: refs[1].hash,
      });
      const refused = await api.submit(rejected.definition.value.election_id, forged);
      if (
        refused.ok ||
        refused.code !== "BALLOT_REJECTED" ||
        refused.admission !== "membership-proof"
      )
        throw new Error("the API didn't refuse a ballot whose proof is another ballot's");
      board(rejected, forged);
      log(
        `stage 4 (rejected-ballot): an honest ballot cast through the API, then one whose proof is another ballot's, which the API refuses with membership-proof and the fixture boards anyway`,
      );
    }
    {
      // The poll of questions, as the honest election below: voter 0 challenges an
      // attempt and checks its opening on a second context against the code
      // shown, voters 0 to 2 answer, voter 1 answers again under the later
      // block, and voter 3 never does. Voter 1 first leaves the first two
      // questions blank, which their limits allow.
      const { value } = questions.definition;
      // The client's check before casting: every listed receipt key is
      // registered with the anchor before the poll opens (T-26, T-69).
      const read = await storageWords(
        anvil,
        anchor.address,
        value.receipt_keys.map(receiptKeySlot),
      );
      const keys = receiptKeysCastCheck(read.words, value.opens_at, read.timestamp);
      if (!keys.castable) throw new Error(`the poll's receipt key ${keys.key} judges nothing`);
      const pollCasting = () =>
        questionCastingFor(
          value,
          questions.panel,
          questions.transcript,
          electorate.leaves,
          artifacts,
        );
      const casting = pollCasting();
      const checker = pollCasting();
      const attempt = [0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0] as const;
      const challenged = challengeQuestions(casting, attempt);
      const opened = checkChallengeOpeningV2(
        checker.election,
        decodeOpening(challenged.opening, 2),
      );
      if (
        !opened.ok ||
        hex(opened.coreHash) !== hex(challenged.shown) ||
        opened.votes.join() !== attempt.join() ||
        !opened.withinRules
      )
        throw new Error("an honest challenge of the poll failed its check");
      const [v0, v1, v2] = voters;
      if (v0 === undefined || v1 === undefined || v2 === undefined)
        throw new Error("too few voters");
      // Each ballot gets the operator's receipt for the board as it stands
      // once the ballot is appended, which the voter's client checks at cast.
      const payloads: Uint8Array[] = [];
      const receiptsOf = receiptElection(questions.definition);
      // Every seat takes each ballot in, as in the honest election below.
      const last = new Map<typeof v0, Counted & { readonly votes: readonly number[] }>();
      const shareReceipts: Uint8Array[] = [];
      for (const [voter, votes, ref] of [
        [v0, [1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 0], refs[0]],
        [v1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1], refs[0]],
        [v2, [0, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0], refs[0]],
        [v1, [0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1], refs[1]],
      ] as const) {
        const made = await castQuestions(casting, voter, votes, ref);
        const payload = made.ballot;
        const taken = intake(
          casting.election,
          questions.secrets,
          payload,
          made.ciphertexts.map((c) => c.ciphertext),
        );
        shareReceipts.push(...taken.receipts);
        last.set(voter, { payload, shares: taken.shares, votes });
        payloads.push(payload);
        await submitted(questions, payload);
        receipts.push({
          name: `entry ${questions.entries.length - 1}`,
          payload,
          receipt: operatorReceipt(receiptSecret, receiptsOf, questions.entries, cast),
          expected: "included",
          drop: { status: "not-alarm" },
        });
      }
      // The seats' share receipts after the window's ballots, so the ballots
      // keep the indices the receipts below name.
      for (const r of shareReceipts) board(questions, r);
      // Two receipts the operator signs for boards it never anchors. A fork:
      // voter 0's ballot shown at index 2, after voter 1's first, though the
      // anchored board has it at 1; the ballot is on the board, so only the
      // receipt's board is false. A drop: voter 3's ballot, never boarded,
      // shown appended to the window's anchored board, after the share
      // receipts (T-26).
      const [p0, p1] = payloads;
      const [transcript] = questions.entries;
      if (p0 === undefined || p1 === undefined || transcript === undefined)
        throw new Error("the poll's board is missing entries");
      receipts.push({
        name: "forked",
        payload: p0,
        receipt: operatorReceipt(
          receiptSecret,
          receiptsOf,
          [
            transcript,
            boardEntry(questions.definition, 1n, cast, p1),
            boardEntry(questions.definition, 2n, cast, p0),
          ],
          cast,
        ),
        expected: "forked-copy",
        // Voter 0's ballot is on the anchored board, at entry 1: no drop.
        drop: { status: "present", entry: 1 },
      });
      const v3 = voters[3];
      if (v3 === undefined) throw new Error("too few voters");
      const dropped = (await castQuestions(casting, v3, [1, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0], refs[1]))
        .ballot;
      receipts.push({
        name: "dropped",
        payload: dropped,
        receipt: operatorReceipt(
          receiptSecret,
          receiptsOf,
          [
            ...questions.entries,
            boardEntry(questions.definition, BigInt(questions.entries.length), cast, dropped),
          ],
          cast,
        ),
        expected: "forked-l1",
        drop: { status: "drop" },
      });
      // The client can't tell any of them apart at cast: each passes.
      for (const r of receipts)
        if (!checkAtCast(receiptsOf, r.receipt, r.payload, { min: cast, max: closed }))
          throw new Error(`the poll's ${r.name} receipt failed the client's check at cast`);
      counted.set(questions, {
        ballots: [...last.values()],
        registered: casting.registered,
        counts: countsOf([...last.values()].map((b) => b.votes)),
      });
      log(
        `stage 4 (questions): ${payloads.length} version-3 ballots answering ${value.questions.length} questions cast through the API and boarded by its worker in segment ${cast}, one a re-vote, each with every seat's share receipt; one challenged attempt checked; ${receipts.length} receipts signed, one for a forked board and one for a dropped ballot, each passing the client's check at cast`,
      );
    }
    {
      const casting = castingFor(
        honest.definition.value,
        honest.panel,
        honest.transcript,
        electorate,
        artifacts,
      );
      // The checker: the voter's second device, with a context of its own from
      // the same records (challenge.md, Client rules, the checker's).
      const checker = castingFor(
        honest.definition.value,
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
      if (v0 === undefined || v1 === undefined || v2 === undefined)
        throw new Error("too few voters");
      // Voter 1 re-votes under a later block; voter 3 never votes. Every seat
      // takes each ballot in, and its share receipts are boarded after the
      // window's ballots, in the same segment: their delivery (5.9).
      const last = new Map<typeof v0, Counted & { readonly votes: readonly number[] }>();
      const receipts: Uint8Array[] = [];
      const ballots = [
        [v0, [1, 0, 0], refs[0]],
        [v1, [0, 1, 0], refs[0]],
        [v2, [0, 0, 0], refs[0]],
        [v1, [0, 0, 1], refs[1]],
      ] as const;
      // Each seat's node takes every ballot in and signs its receipt. The
      // fixture opens the same shares with the node's keys for the tally, which
      // no node runs yet (STUBS, seats), and must reach the very receipts the
      // nodes signed (RFC 6979), so it tallies what the nodes hold.
      let lastBallot:
        | { readonly bytes: Uint8Array; readonly ciphertexts: readonly Uint8Array[] }
        | undefined;
      // Each ballot reaches every seat at its node's intake endpoint, over TLS
      // with the hybrid group, as the client's direct route delivers it.
      const served = await serveSeats(stores, nodes);
      try {
        for (const [voter, votes, ref] of ballots) {
          const ballot = await castVote(casting, voter, votes, ref);
          await submitted(honest, ballot.bytes);
          const signed = await nodeIntake(
            served.endpoints,
            honest.definition.value,
            honest.transcript,
            ballot.bytes,
            ballot.ciphertexts,
          );
          const taken = intake(casting.election, honest.secrets, ballot.bytes, ballot.ciphertexts);
          if (
            signed.length !== taken.receipts.length ||
            signed.some((r, i) => hex(r) !== hex(taken.receipts[i] ?? new Uint8Array()))
          )
            throw new Error("the nodes' share receipts aren't the ones their keys sign");
          receipts.push(...signed);
          last.set(voter, { payload: ballot.bytes, shares: taken.shares, votes });
          lastBallot = ballot;
        }
        // A control: by the delivery deadline `t_D` the intake cutoff has
        // passed, and every node refuses the same ballot again (T-54).
        if (lastBallot === undefined) throw new Error("no ballot was cast");
        l1Time = deliveryDeadlines(timing.closesAt, BigInt(timing.inclusionBound)).delivery;
        for (const e of served.endpoints) {
          const late = await deliver(e, {
            stub: stubOf(honest.definition.value),
            transcript: honest.transcript,
            record: lastBallot.bytes,
            ciphertext: lastBallot.ciphertexts[e.index - 1] ?? new Uint8Array(),
          });
          if (late.ok || late.code !== "intake-closed")
            throw new Error(`seat ${e.index}'s node took a ballot past the intake cutoff`);
        }
      } finally {
        await served.close();
      }
      for (const r of receipts) board(honest, r);
      counted.set(honest, {
        ballots: [...last.values()],
        registered: casting.registered,
        counts: countsOf([...last.values()].map((b) => b.votes)),
      });
      log(
        `stage 4 (honest): ${ballots.length} ballots with real membership proofs cast through the API and boarded by its worker in segment ${cast}, one a re-vote, each delivered to every seat's intake endpoint and receipted by its trustee node, and every node's endpoint refusing intake past the cutoff; one challenged attempt checked`,
      );
    }
  } finally {
    await api.close();
  }

  // Stage 4 and 5 (rolling): the rolling poll's ballots, each made against
  // a step's tree the client rebuilt from the group registry's events and
  // sent straight to the board's rolling call with the root it proved
  // against, no server of ours in the path ([[0028-rolling-electorates]],
  // Direct submission; T-25). Voter 0 proves against the step before voter 3
  // joined; voter 3, who joined after the poll was registered, and voter 1,
  // removed and added again, against the next, voter 1 from its live leaf;
  // voter 2 against the first, then again against the next under a later L1
  // block, a re-vote across steps under one nullifier (T-01, T-02, T-08,
  // T-16). Every L1 reference is in the window of the step it names, inside
  // the voting window, and every submission lands in an L2 block inside it.
  await (async () => {
    const { ceremony: c, board: poll, group, registeredAt, events, early, late } = rolling;
    const [v0, v1, v2, v3] = voters;
    if (v0 === undefined || v1 === undefined || v2 === undefined || v3 === undefined)
      throw new Error("too few voters");
    const chain = { events, registeredAt };
    const casting = rollingCastingFor(c.definition.value, c.panel, c.transcript, chain, artifacts);
    const trees = [early, late].map((n) =>
      stepTree(chain, [group], Number(n), rootClockBoundary(n)),
    ) as [StepTree, StepTree];
    const [before, after] = trees;
    const latest = async (rpc: typeof anvil) =>
      BigInt(
        (await rpc.call<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]))
          .timestamp,
      );
    const max = (...xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b));
    const at = max((await latest(anvil)) + 1n, rootClockBoundary(late), timing.opensAt);
    const refs = [await l1RefAt(anvil, at), await l1RefAt(anvil, at + 60n)] as const;
    for (const [n, t] of [
      [early, at],
      [late, at],
      [late, at + 60n],
    ] as const)
      if (rootStepWindow(n, t) !== "in" || t > timing.closesAt)
        throw new Error(`step ${n} isn't in the window of an L1 reference at ${t}`);
    // The board takes a ballot only in an L2 block inside the voting window.
    const l2At = max((await latest(l2Anvil)) + 1n, timing.opensAt);
    if (l2At > timing.closesAt) throw new Error("the L2 is past the rolling poll's close");
    await l2Anvil.call("evm_setNextBlockTimestamp", [Number(l2At)]);
    // A control: voter 3 joined after the earlier step, so its tree has no
    // leaf of theirs, and the client refuses before proving (T-08).
    try {
      await castRolling(casting, v3, [1, 0, 0], refs[0], before);
      throw new Error("voter 3 proved against a step from before they joined");
    } catch (e) {
      if (!(e instanceof MembershipProverError) || e.code !== "not-a-member") throw e;
    }
    const boarded: {
      readonly voter: number;
      readonly votes: readonly number[];
      readonly ballot: CastRollingBallot;
    }[] = [];
    for (const [i, voter, votes, ref, tree] of [
      [0, v0, [1, 0, 0], refs[0], before],
      [3, v3, [0, 1, 0], refs[0], after],
      [1, v1, [0, 0, 1], refs[0], after],
      [2, v2, [1, 0, 0], refs[0], before],
      [2, v2, [0, 1, 0], refs[1], after],
    ] as const) {
      const ballot = await castRolling(casting, voter, [...votes], ref, tree);
      await submitRollingBallot(l2, anvil, ballot.root, ballot.bytes);
      boarded.push({ voter: i, votes, ballot });
    }
    const [first0, , , revoted, revote] = boarded;
    if (revoted === undefined || revote === undefined || first0 === undefined)
      throw new Error("a rolling ballot is missing");
    if (revoted.ballot.record.nullifier !== revote.ballot.record.nullifier)
      throw new Error("voter 2's two ballots carry two nullifiers");
    // A control: an honest ballot with another step's root beside it fails
    // its proof on chain, so nobody can attach another root to it (T-25, T-38).
    const other = await castRolling(casting, v0, [0, 0, 1], refs[1], after);
    await submitRollingBallot(l2, anvil, before.root, other.bytes, "BallotRefused(uint8)");
    // The board's log holds each ballot with the root it proved against.
    const logged = (await rollingBallotLogs(l2)).filter(
      (l) => hex(l.definitionHash) === hex(casting.election.definitionHash),
    );
    if (
      logged.length !== boarded.length ||
      logged.some(
        (l, i) =>
          hex(l.record) !== hex(boarded[i]?.ballot.bytes ?? new Uint8Array()) ||
          l.root !== boarded[i]?.ballot.root ||
          l.timestamp < timing.opensAt ||
          l.timestamp > timing.closesAt,
      )
    )
      throw new Error("the board's rolling ballots aren't the ones submitted");
    // The operator carries each ballot from the board's log to the poll's
    // board, in log order, in the voting window's segment, as it does a
    // direct submission of a fixed poll (contracts.md, Rolling ballots).
    for (const l of logged) board(poll, l.record);
    // Every seat takes each boarded ballot in, as its node does from the
    // client's direct route (share-encryption.md, Ballot version 5): admitted
    // against the root of the step it names, which the seat computes from the
    // group registry's events and never takes from the board's log, its
    // shares opened and a version-2 receipt signed over the version-5 ballot
    // hash, which binds the step (T-08, T-25, T-38, T-52). The fixture runs
    // it through @abolishus/crypto with the seats' keys: no trustee node
    // takes version-5 ballots yet (P2-17 part 4f-2b).
    const tauLate = rootClockBoundary(late);
    // A control: while the safe chain holds no block later than the newer
    // step's boundary, every seat refuses that step's ballots with
    // step-unsettled, decrypting and storing nothing, and still takes the
    // older step's (T-52, T-54).
    const seatKeys = (s: (typeof c.secrets)[number]) => ({
      panel: SEAT_PANELS.default,
      seat: s.index,
      kemSecret: s.kemSecret,
      signingSecret: s.signingSecret,
    });
    for (const { ballot } of boarded)
      for (const s of c.secrets) {
        const got = intakeBallotV5(
          casting.election,
          seatKeys(s),
          ballot.bytes,
          ballot.ciphertexts[s.index - 1] ?? new Uint8Array(),
          tauLate,
        );
        const settled = ballot.record.step < Number(late);
        if (settled ? !got.ok : got.ok || got.code !== "step-unsettled")
          throw new Error(
            `seat ${s.index} judged a step-${ballot.record.step} ballot before step ${late} settled as ${got.ok ? "ok" : got.code}`,
          );
      }
    if ((await latest(l2Anvil)) <= tauLate) {
      await l2Anvil.call("evm_setNextBlockTimestamp", [Number(tauLate + 1n)]);
      await l2Anvil.call("evm_mine", []);
    }
    const safeAt = await latest(l2Anvil);
    if (safeAt > timing.closesAt) throw new Error("the L2 is past the rolling poll's close");
    const signers = {
      default: casting.registered.map((k) => ({ index: k.index, signingKey: k.signingKey })),
      author: [],
    };
    const taken = boarded.map(({ voter, votes, ballot }) => {
      const { record } = ballot;
      const named = {
        definitionHash: casting.election.definitionHash,
        cell: record.cell,
        nullifier: record.nullifier,
      };
      const receipts = c.secrets.map((s) => {
        const r = intakeBallotV5(
          casting.election,
          seatKeys(s),
          ballot.bytes,
          ballot.ciphertexts[s.index - 1] ?? new Uint8Array(),
          safeAt,
        );
        if (!r.ok) throw new Error(`seat ${s.index} refused an honest rolling ballot: ${r.code}`);
        if (
          r.step !== record.step ||
          hex(r.ballotHash) !==
            hex(ballotHashV5({ ...named, step: record.step }, record.committed_vote))
        )
          throw new Error(`seat ${s.index} took a rolling ballot in at another step or hash`);
        // The receipt checks against the ballot as boarded, and not against
        // the same vote relabelled to the other step (T-38).
        const relabelled = record.step === Number(late) ? Number(early) : Number(late);
        if (
          !checkShareReceiptV5(
            signers,
            { ...named, step: record.step },
            record.committed_vote,
            SEAT_PANELS.default,
            s.index,
            r.receipt,
          ) ||
          checkShareReceiptV5(
            signers,
            { ...named, step: relabelled },
            record.committed_vote,
            SEAT_PANELS.default,
            s.index,
            r.receipt,
          )
        )
          throw new Error(`seat ${s.index}'s receipt doesn't bind the rolling ballot's step`);
        return r;
      });
      return { voter, votes, ballot, receipts };
    });
    // Each seat's receipt boarded as the ballot's delivery record, version 2
    // under ballot version 5, naming the ballot by version 5's hash, which
    // binds the step (delivery.md; T-38, T-53).
    for (const { receipts } of taken)
      for (const [i, r] of receipts.entries()) {
        const seat = c.secrets[i]?.index;
        if (seat === undefined) throw new Error("a receipt from no seat");
        board(
          poll,
          encodeShareReceiptV2(shareReceiptRecordV2(casting.election.definitionHash, seat, r)),
        );
      }
    // The counted set for stage 6: each voter's last ballot, voter 2's
    // re-vote over its first, with the shares every seat took from it.
    const lastOf = new Map(taken.map((t) => [t.voter, t]));
    const kept = [...lastOf.values()];
    counted.set(poll, {
      ballots: kept.map(({ ballot, receipts }) => ({
        payload: ballot.bytes,
        shares: new Map(
          receipts.map((r, i) => {
            const seat = c.secrets[i]?.index;
            if (seat === undefined) throw new Error("shares from no seat");
            return [seat, r.shares] as const;
          }),
        ),
      })),
      registered: casting.registered,
      counts: countsOf(kept.map(({ votes }) => votes)),
    });
    writeFileSync(
      join(OUT, "rolling", "receipts.json"),
      `${JSON.stringify(
        {
          safeAt: safeAt.toString(),
          ballots: taken.map(({ voter, ballot, receipts }) => ({
            voter,
            step: ballot.record.step,
            receipts: receipts.map((r, i) => ({
              seat: c.secrets[i]?.index,
              receipt: hex(r.receipt),
            })),
          })),
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(OUT, "rolling", "ballots.json"),
      `${JSON.stringify(
        {
          steps: trees.map((t) => ({
            step: t.step,
            root: t.root.toString(),
            leaves: t.leaves.length,
          })),
          ballots: boarded.map(({ voter, ballot }) => ({
            voter,
            step: ballot.record.step,
            root: ballot.root.toString(),
            l1RefNumber: ballot.record.l1_ref_number.toString(),
            record: hex(ballot.bytes),
          })),
        },
        null,
        2,
      )}\n`,
    );
    log(
      `stage 4 (rolling): ${boarded.length} version-5 ballots with real membership proofs under the rolling scope submitted straight to the board's rolling call, ${boarded.filter((b) => b.ballot.record.step === Number(early)).length} against step ${early} and ${boarded.filter((b) => b.ballot.record.step === Number(late)).length} against step ${late}, voter 3 (joined after registration) and voter 1 (removed and added again) among them, and voter 2 re-voting across the two steps under one nullifier; voter 3 refused before proving against the step before they joined, and an honest ballot with another step's root refused by the board; every seat took each ballot in against the step root it computed (${taken.length * c.secrets.length} version-2 receipts over the version-5 ballot hash, none checking for the other step), and refused step ${late}'s ballots with step-unsettled until the L2 held a block past its boundary; the ballots carried from the board's log and the receipts boarded on the poll's board in segment ${cast}`,
    );
  })();
  await anchorAt(anvil, anchor, checkpointsAt(cast), end(cast) + ANCHOR_DELAY);
  await anchorAt(anvil, anchor, checkpointsAt(closed), end(closed) + ANCHOR_DELAY);

  // Stage 6, once the counted extent is anchored: each election whose
  // ballots the seats took in is tallied over its counted ballots, its one
  // cell's opening boarded in the tally's segment; once that checkpoint is
  // anchored, each seat states destruction in the seal's (docs/spec/tally.md,
  // Destruction, When).
  const tallies = [honest, questions, rolling.board].map((e) => {
    const taken = counted.get(e);
    if (taken === undefined) throw new Error(`no counted ballots for ${e.name}`);
    const { ballots, registered, counts } = taken;
    const opening = tallyOpening(e.definition, registered, e.secrets, ballots);
    // What the seats opened must be what the counted ballots add up to. The
    // verifier judges every opening from the board in stage 9 (7.2, 7.4);
    // this catches the fixture's own fault first, and is the only check of
    // the rolling poll's until stage 9 reads a rolling poll (P2-17 part
    // 4f-2b-2b).
    const opened = decodeTallyOpening(opening, 1).opening.map(({ v }) => Number(v));
    if (opened.join() !== counts.join())
      throw new Error(`${e.name}'s cell opened as ${opened.join()}, not ${counts.join()}`);
    board(e, opening, tallied);
    return { e, ballots };
  });
  await anchorAt(anvil, anchor, checkpointsAt(tallied), end(tallied) + ANCHOR_DELAY);
  for (const { e } of tallies)
    for (const statement of destructionStatements(e.definition, e.secrets))
      board(e, statement, seal);
  await anchorAt(anvil, anchor, checkpointsAt(seal), end(seal) + ANCHOR_DELAY);
  // Stage 8, the archive: every board's segment objects and entry-hash lists
  // posted to the local Arweave through the worker's client, listed in
  // manifest 0 once confirmed, and the locator naming it sent alone after
  // the seal's anchor, as the worker's final anchor is (docs/spec/archive.md,
  // Locator; T-51). Beside them, the L2 contracts' evidence and runs for
  // each anchored period, read through the worker's source once every L2
  // event of the run is emitted (docs/spec/archive.md, Who writes them).
  const l2Contracts = [l2.electionRegistry, l2.trusteeRegistry, l2.groupRegistry, l2.board];
  const contractEvents = await contractEventObjects(
    anvil,
    l2Anvil,
    { l1ChainId: L1_CHAIN_ID, l2ChainId: L2_CHAIN_ID, contracts: l2Contracts },
    Array.from({ length: seal - first + 1 }, (_, i) => end(first + i)),
  );
  const archived = await archiveObjects(
    arweave,
    boards.flatMap((e) => segmentObjects(e.entries).flatMap((o) => [o.object, o.hashes])),
    { l1ChainId: L1_CHAIN_ID, anchor: anchor.address },
    contractEvents,
  );
  await locateAt(anvil, anchor, archived.locator, end(seal) + ANCHOR_DELAY + 1n);
  log(
    `stage 6: ${tallies.map(({ e, ballots }) => `${e.name}'s cell opened over ${ballots.length} counted ballots`).join(", ")}, each from every seat's summed shares, in segment ${tallied}; every seat's destruction statement in segment ${seal}`,
  );
  // Past the seal's deadline, so the board checks see closed boards; then
  // enough blocks that Anvil's finalized block includes every anchor.
  const after = end(seal) + DEADLINE + 1n;
  for (let i = 0n; i < 70n; i++) await mineAt(anvil, after + i * 12n);

  log(`stage 7: segments ${first} to ${seal} (the seal) anchored for each election`);
  log(
    `stage 8: ${archived.objects.length} segment objects and entry-hash lists, and the L2 contracts' ${archived.evidence.length} evidence records and ${archived.runs.length} runs of ${[...contractEvents.counts.values()].reduce((a, b) => a + b, 0n)} events, posted to a local Arweave at ${arweave.url} through the worker's client and listed in manifest 0, whose locator the anchor holds`,
  );

  // Stage 4's later checks: each receipt of the poll judged as its voter's
  // client would, from the anchors and the receipt key's record at the
  // finalized L1 block and the operator's entry-hash lists, after every
  // window has closed (docs/spec/receipts.md, Verdicts; T-26, T-24).
  const judged = await (async () => {
    const { value } = questions.definition;
    const { words, timestamp } = await storageWords(
      anvil,
      anchor.address,
      value.receipt_keys.map(receiptKeySlot),
      "finalized",
    );
    const view: JudgeView = {
      words,
      now: timestamp,
      anchors: await loggedAnchors(anvil, anchor.address, value.election_id),
      clock: { epoch, period: PERIOD, deadline: DEADLINE, lastSegment: seal },
      firstSegment: first,
      sources: [concatBytes(...segmentObjects(questions.entries).map((o) => o.hashes))],
    };
    const judged = receipts.map((r) => ({
      r,
      verdict: judge(receiptElection(questions.definition), r.receipt, r.payload, view),
    }));
    for (const { r, verdict } of judged)
      if (
        !verdictIs(r.expected, verdict) ||
        isReceiptAlarm(verdict) !== (r.expected !== "included")
      )
        failures.push(
          `receipts (questions): the ${r.name} receipt is ${verdict.verdict}${"by" in verdict ? ` by ${verdict.by}` : ""}, not ${r.expected}`,
        );
    log(
      `stage 4 (questions, receipts): ${judged.filter(({ verdict }) => verdict.verdict === "included").length} included, ${judged.filter(({ verdict }) => isReceiptAlarm(verdict)).length} alarms, judged from L1 and the operator's entry-hash lists`,
    );
    return judged;
  })();

  // Stage 8, the board: each election's segment objects and entry-hash lists
  // published as blocks to a community node, which serves them by CID from
  // here on.
  const mirror = join(OUT, "node", "blocks");
  mkdirSync(mirror, { recursive: true });
  for (const e of boards)
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
      const id = e.definition.value.election_id;
      const receiptKeys = e.definition.version === 5 ? e.definition.value.receipt_keys : [];
      const l1 = await evidence(anvil, anchor.address, [
        ...anchorSlots(id, first, seal),
        ...receiptKeys.map(receiptKeySlot),
      ]);
      if (l1.timestamp < after) throw new Error("the finalized block is before the anchors");
      const checkpoints = await loggedCheckpoints(anvil, anchor.address, id);
      const clock = { epoch, lastSegment: seal };
      const evidenceFor = { firstSegment: first, header: l1.header, nodes: l1.nodes, checkpoints };
      const dir = join(OUT, e.name, "bundle");
      // A block store holding exactly what the node mirrors for this election,
      // as a user would export it from any node holding the same blocks.
      const blocks = readFileSync(join(mirror, `${e.name}.car`));
      writeBundle(dir, e, clock, evidenceFor, { blocks });
      // The same bundle in format 5, with the run of finalized L1 headers
      // from block 0: what the community node gathers (stage 9, by the node)
      // must be judged as this is.
      const withBlocks = join(OUT, e.name, "bundle-l1-blocks");
      writeBundle(
        withBlocks,
        e,
        clock,
        { ...evidenceFor, blocks: await headers(anvil, l1.number) },
        { blocks },
      );
      // A tallied election's format-5 bundle must show its tally (stage 6):
      // each voter's last ballot selected (voter 1's re-vote, entry 4, over
      // its first, entry 2), delivered, counted and opened, and every seat's
      // destruction stated.
      const tally = counted.get(e);
      const tallyRows = (name: string) => (r: VerifierRun) =>
        tally === undefined
          ? []
          : [
              ...checkTallied(
                name,
                r,
                { counted: tally.ballots.length, counts: tally.counts },
                PANEL.size,
              ),
              ...checkBallots(name, r, HONEST_BALLOTS),
              ...checkSelected(name, r, [1, 3, 4]),
            ];
      if (e.name !== "questions")
        failures.push(...verify(withBlocks, tallyRows(`${e.name} (l1 blocks)`)));
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
        // The same election from L1 and Arweave alone, with no copy in the
        // bundle and no IPFS gateway ([[0005-permanent-archive]], Reference
        // election): the copy by CID is read from the objects the archive
        // lists, found from the anchor's locator, which the anchor's logs
        // show was never overwritten (4.3; T-49, T-51, T-69).
        const archiveL1 = await evidence(anvil, anchor.address, [
          ...anchorSlots(id, first, seal),
          ...locatorSlots(archived.locator.length),
          ...accumulatorSlots(),
        ]);
        const fromArweave = join(OUT, "honest", "bundle-from-arweave");
        const archiveInputs = {
          ...evidenceFor,
          header: archiveL1.header,
          nodes: archiveL1.nodes,
          blocks: await headers(anvil, archiveL1.number),
          logs: await allAnchorLogs(anvil, anchor.address),
        };
        writeBundle(fromArweave, e, clock, archiveInputs, "none");
        const fromArchive = ["--arweave", arweave.url];
        // 4.4's replay must hold every event each L2 contract emitted, from
        // the archive's evidence and runs alone (T-71).
        const held = Object.fromEntries(
          (
            [
              ["election-registry", l2.electionRegistry],
              ["trustee-registry", l2.trusteeRegistry],
              ["group-registry", l2.groupRegistry],
              ["board", l2.board],
            ] as const
          ).map(([role, a]) => [role, contractEvents.counts.get(hex(a)) ?? 0n]),
        );
        failures.push(
          ...verify(
            fromArweave,
            (r) => [
              ...checkExpectations(r, "arweave", HONEST_BALLOTS, { passes: ["4.3"] }),
              ...tallyRows("honest (arweave)")(r),
              ...checkArchivedEvents("honest (arweave)", r, held),
            ],
            fromArchive,
          ),
        );
        // A control: the same, with the node withholding the election
        // registry's run. Its records are proven but its events aren't held,
        // so 4.4 is unverifiable at the registry, never failed (T-53).
        const registryRun = archived.runs.find((r) => hex(r.contract) === hex(l2.electionRegistry));
        if (registryRun === undefined)
          throw new Error("the election registry's events aren't archived");
        await arweave.withhold(registryRun.transaction);
        const withheldRun = join(OUT, "honest", "control-withheld-run");
        writeBundle(withheldRun, e, clock, archiveInputs, "none");
        failures.push(
          ...verify(
            withheldRun,
            (r) =>
              checkControl("withheld-run", r, {
                "4.3": { status: "pass" },
                "4.4": { status: "unverifiable", code: "run-gap" },
              }),
            fromArchive,
          ),
        );
        await arweave.release(registryRun.transaction);
        // A control: the same, with the node withholding the voting window's
        // segment object. The archive is then short and the copy stops at
        // that run: unverifiable from Arweave, never failed (T-53).
        const windowObject = segmentObjects(e.entries).find((s) => s.segment === cast);
        const window =
          windowObject &&
          archived.objects.find((o) => hex(o.cid) === hex(objectCid(windowObject.object)));
        if (window === undefined) throw new Error("the voting window's object isn't archived");
        await arweave.withhold(window.transaction);
        const withheldArchive = join(OUT, "honest", "control-withheld-archive");
        writeBundle(
          withheldArchive,
          e,
          clock,
          {
            ...evidenceFor,
            header: archiveL1.header,
            nodes: archiveL1.nodes,
            logs: await allAnchorLogs(anvil, anchor.address),
          },
          "none",
        );
        failures.push(
          ...verify(
            withheldArchive,
            (r) =>
              checkControl("withheld-archive", r, {
                "3.2": { status: "pass" },
                "4.1": { status: "unverifiable", code: "checkpoint-missing" },
                "4.2": { status: "unverifiable", code: "checkpoint-missing" },
                "4.3": { status: "unverifiable", code: "object-unavailable" },
              }),
            fromArchive,
          ),
        );
        await arweave.release(window.transaction);
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
      } else if (e.name === "questions") {
        // The poll of questions, from its block store: every ballot admitted
        // under definition version 5, and its own rows passing.
        failures.push(
          ...verify(dir, (r) =>
            checkExpectations(r, "blocks.car", HONEST_BALLOTS, {
              name: "questions",
              passes: QUESTIONS_PASSES,
            }),
          ),
        );
        // Its format-5 bundle: the verifier judges each ballot's L1 reference
        // (5.8), selects over the admitted ballots (6.1) and checks the tally
        // and destruction, as the honest election's.
        failures.push(...verify(withBlocks, tallyRows("questions (l1 blocks)")));
        // Stage 4's alarms judged for drops by the verifier over that bundle
        // (docs/spec/receipts.md, Drops), which needs 5.8 and 6.1: the forked
        // receipt's ballot is on the anchored board, the dropped one's on no
        // board. Every input is a local file, so `drop` stays unjudged, and
        // what the run shows is `dropAgainstInputs` (T-26, T-25, T-53).
        const drops = judgeDrops(
          withBlocks,
          judged.map(({ r, verdict }) => ({ receipt: r.receipt, payload: r.payload, verdict })),
        );
        const rows = judged.map(({ r, verdict }, i) => {
          const d = drops[i];
          if (d === undefined) throw new Error("the drop judge skipped a receipt");
          if (!dropIs(r.drop, d.dropAgainstInputs))
            failures.push(
              `receipts (questions): the ${r.name} receipt's drop is ${JSON.stringify(d.dropAgainstInputs)}, not ${JSON.stringify(r.drop)}`,
            );
          // A receipt that isn't an alarm is no drop whatever the inputs;
          // an alarm's drop stands only on authenticated ones.
          if (
            r.drop.status === "not-alarm"
              ? !dropIs(r.drop, d.drop)
              : d.drop.status !== "unjudged" || d.drop.code !== "inputs-unauthenticated"
          )
            failures.push(
              `receipts (questions): the ${r.name} receipt's drop is ${JSON.stringify(d.drop)}, not ${r.drop.status === "not-alarm" ? "not-alarm" : "unjudged from local inputs"}`,
            );
          return {
            name: r.name,
            receipt: hex(r.receipt),
            verdict: verdict.verdict,
            ...("by" in verdict ? { by: verdict.by } : {}),
            alarm: isReceiptAlarm(verdict),
            drop: d.drop,
            dropAgainstInputs: d.dropAgainstInputs,
          };
        });
        writeFileSync(
          join(OUT, "questions", "receipts.json"),
          `${JSON.stringify(rows, null, 2)}\n`,
        );
        log(
          `stage 4 (questions, drops): ${drops.filter((d) => d.dropAgainstInputs.status === "drop").length} drop and ${drops.filter((d) => d.dropAgainstInputs.code === "present").length} present among the alarms, judged by the verifier against the bundle's inputs`,
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

  // Stage 9 by the community node (P4-5 part 3): `abolish-node verify` over
  // the blocks it mirrors, every other input read from the two chains, none
  // from the fixture. Each registered election's checks must be the
  // verifier's own on the bundle above; rule-7's definition was never
  // registered, so the node finds none to verify it under.
  await l2Anvil.call("anvil_mine", ["0x46"]); // so every registration is final
  const reports = join(OUT, "node", "reports");
  const verified = await nodeVerify({
    blocks: mirror,
    reports,
    l1: anvil.url,
    anchor: `0x${hex(anchor.address)}`,
    l2: l2Anvil.url,
    registry: `0x${hex(l2.electionRegistry)}`,
  });
  writeFileSync(
    join(OUT, "node", "verify.jsonl"),
    verified.lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
  );
  if (verified.code !== 0) failures.push(`abolish-node verify exited ${verified.code}`);
  for (const e of elections) {
    const id = hex(e.definition.value.election_id);
    const line = verified.lines.find((l) => l["election"] === id);
    if (e.name === "rule-7") {
      if (line?.["error"] !== "l2-definition-missing")
        failures.push(`node (rule-7): expected l2-definition-missing, got ${JSON.stringify(line)}`);
      continue;
    }
    if (line?.["report"] === undefined) {
      failures.push(`node (${e.name}): no report: ${JSON.stringify(line)}`);
      continue;
    }
    const ours = JSON.parse(
      readFileSync(join(reports, id, "report.json"), "utf8"),
    ) as VerifierRun["report"];
    const theirs = JSON.parse(
      readFileSync(join(OUT, e.name, "bundle-l1-blocks-report.json"), "utf8"),
    ) as VerifierRun["report"];
    if (
      ours.verdict !== theirs.verdict ||
      JSON.stringify(ours.checks) !== JSON.stringify(theirs.checks)
    )
      failures.push(
        `node (${e.name}): its report's checks differ from the verifier's on the bundle`,
      );
  }
  // The rolling poll, anchored and mirrored with the rest: no release pins
  // the group and election registries yet (verifier, PINNED_REGISTRIES), so
  // the node builds no chain for it and stops it at 2.3, unverifiable and
  // never passed (T-36, T-71). Its run under the fixture's registries is
  // P2-17 part 4f-2b-2b.
  {
    const id = hex(rolling.board.definition.value.election_id);
    const line = verified.lines.find((l) => l["election"] === id);
    const report =
      line?.["report"] === undefined
        ? undefined
        : (JSON.parse(
            readFileSync(join(reports, id, "report.json"), "utf8"),
          ) as VerifierRun["report"]);
    const profile = report?.checks.find((c) => c.id === "2.3");
    if (
      report?.verdict !== "unverifiable" ||
      profile?.status !== "unverifiable" ||
      profile.code !== "unsupported-version"
    )
      failures.push(
        `node (rolling): expected 2.3 unverifiable with unsupported-version, got ${JSON.stringify(profile ?? line)}`,
      );
  }
  log(
    `stage 9 (node): abolish-node verify reported ${verified.lines.filter((l) => "report" in l).length} elections from L1, L2 and its blocks (${reports})`,
  );
}

async function main(): Promise<number> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const failures: string[] = [];
  try {
    const anvil = await startAnvil(L1_CHAIN_ID);
    try {
      const l2 = await startAnvil(L2_CHAIN_ID);
      // The trustee nodes' stores, which hold their secrets and shares:
      // outside the run's output, and removed however it ends.
      const stores = mkdtempSync(join(tmpdir(), "reference-election-seats-"));
      try {
        const arweave = await startArweave();
        try {
          await run(anvil, l2, arweave, stores, failures);
        } finally {
          await arweave.close();
        }
      } finally {
        rmSync(stores, { recursive: true, force: true });
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
