// The panel's trustee nodes (apps/trustee-node, P2-13): each seat runs the
// node's own ceremony duties (`CeremonySeat`: the stub checks, the four
// rounds, the transcript check and the one approval per stub) and its intake
// (`IntakeSeat`: the election checks, crypto's admission checks and
// decryption, the shares held before the receipt), over a store of its own on
// disk, as a deployed node does. The fixture is only the coordinator here,
// relaying rounds and collecting approvals (docs/spec/ceremony.md: trusted
// for liveness only), and the deployment, supplying the electorate and
// registration checks and the clock (T-37, T-54, T-14, T-41).

import { join } from "node:path";
import {
  checkCeremonyTranscript,
  type ElectionDefinition,
  electionStubHash,
  encodeCeremonyRegistration,
  encodeCeremonyTranscript,
  encodeElectionDefinition,
  keySetEntry,
  keySetHash,
  type Panel,
} from "@abolishus/crypto";
import {
  type Approval,
  CeremonySeat,
  type ElectorateCheck,
  FileStore,
  IntakeSeat,
  type RegistrationCheck,
  type SeatResult,
} from "@abolishus/trustee-node";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Electorate } from "./casting.ts";
import type { SeatKeys, Trustees } from "./election.ts";

const equalBytes = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b);

/** One seat's node: its ceremony duties and its intake over one store. */
export interface SeatNode {
  readonly index: number;
  readonly ceremony: CeremonySeat;
  readonly intake: IntakeSeat;
}

export interface SeatDeployment {
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  readonly electorate: ElectorateCheck;
  readonly registration: RegistrationCheck;
  /** The nodes' clock, in Unix seconds: intake closes at `c_I` by it. */
  readonly now: () => bigint;
}

/**
 * Starts a node for every seat of `trustees`, in seat order, each with a
 * store of its own under `root` (mode 0700). The stores hold the seats'
 * per-election secrets and shares, so `root` is never in the run's output.
 */
export async function startSeats(
  root: string,
  trustees: Trustees,
  d: SeatDeployment,
): Promise<SeatNode[]> {
  const pins = {
    panel: trustees.panel,
    l2ChainId: d.l2ChainId,
    trusteeRegistry: d.trusteeRegistry,
  };
  const nodes: SeatNode[] = [];
  for (const t of trustees.seats) {
    const store = await FileStore.open(join(root, `seat-${t.index}`));
    const ceremony = new CeremonySeat({
      ...pins,
      index: t.index,
      identitySecret: t.identitySecret,
      electorate: d.electorate,
      store,
    });
    const intake = new IntakeSeat({
      ...pins,
      index: t.index,
      ceremony,
      electorate: d.electorate,
      registration: d.registration,
      store,
      now: d.now,
    });
    nodes.push({ index: t.index, ceremony, intake });
  }
  return nodes;
}

/** A ceremony the nodes ran: its transcript and each taking part seat's answer to approve it. */
export interface NodeCeremony {
  readonly stubBytes: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly transcript: Uint8Array;
  /** The approvals, or refusals, of the seats that took part, in seat order. */
  readonly approvals: readonly SeatResult<Approval>[];
}

function sent<M>(index: number, round: number, r: SeatResult<M>): M {
  if (!r.ok) throw new Error(`seat ${index} refused round ${round}: ${r.code}`);
  return r.value;
}

/**
 * One run of the key ceremony over `stub` with every node but the last
 * `absent` taking part, the fixture relaying each round in full, then each
 * of them asked to approve the transcript. A seat that refuses a round of an
 * honest run stops the fixture: that is a fault in the node.
 */
export async function nodeCeremony(
  nodes: readonly SeatNode[],
  stub: ElectionDefinition,
  absent: number,
): Promise<NodeCeremony> {
  const stubBytes = encodeElectionDefinition(stub);
  const stubHash = electionStubHash(stub);
  const runId = crypto.getRandomValues(new Uint8Array(32));
  const present = nodes.slice(0, nodes.length - absent);
  const round = async <M>(n: number, ask: (s: CeremonySeat) => Promise<SeatResult<M>>) => {
    const got = await Promise.all(present.map((s) => ask(s.ceremony)));
    return got.map((r, i) => sent(present[i]?.index ?? 0, n, r));
  };
  const keys = await round(1, (s) => s.keys(stubBytes, runId));
  const challenges = await round(2, (s) => s.challenges(stubHash, runId, keys));
  const answers = await round(3, (s) => s.answers(stubHash, runId, { keys, challenges }));
  const reveals = await round(4, (s) => s.reveals(stubHash, runId, { keys, challenges, answers }));
  const transcript = encodeCeremonyTranscript({
    run_id: runId,
    keys,
    challenges,
    answers,
    reveals,
  });
  // Approvals run one at a time in each node; across nodes, in seat order.
  const approvals: SeatResult<Approval>[] = [];
  for (const s of present) approvals.push(await s.ceremony.approve(stubBytes, transcript));
  return { stubBytes, stubHash, transcript, approvals };
}

/**
 * The trustee registry's registration record from the nodes' approvals
 * (docs/spec/contracts.md, Trustee registry, Registration): the key set from
 * the coordinator's own check of the transcript, which must be the one every
 * approval signed, since the registry checks each signature over it.
 */
export function registrationFrom(
  stub: ElectionDefinition,
  panel: Panel,
  c: NodeCeremony,
  approvals: readonly Approval[],
): Uint8Array {
  const check = checkCeremonyTranscript(
    {
      l2ChainId: stub.l2_chain_id,
      trusteeRegistry: stub.trustee_registry,
      electionId: stub.election_id,
      stubHash: c.stubHash,
      panel,
    },
    c.transcript,
    1,
  );
  if (!check.ok) throw new Error(`the nodes' transcript fails: ${check.code}`);
  const keySet = check.registered.map(keySetEntry);
  const setHash = keySetHash(keySet);
  for (const a of approvals)
    if (
      !equalBytes(a.registration.keySetHash, setHash) ||
      !equalBytes(a.registration.ceremonyTranscriptHash, check.hash) ||
      !equalBytes(a.registration.stubHash, c.stubHash)
    )
      throw new Error(`seat ${a.registration.index} approved another key set or transcript`);
  return encodeCeremonyRegistration({
    panelId: stub.panel_id,
    stubHash: c.stubHash,
    ceremonyTranscriptHash: check.hash,
    keySet,
    approvals: approvals.map((a) => ({ index: a.registration.index, signature: a.signature })),
  });
}

/**
 * Each approving seat's per-election secrets, from its node's store, for the
 * duties the node doesn't run yet (the tally and destruction statements,
 * P2-13 part 5), which the fixture runs with the node's keys.
 */
export async function nodeKeys(
  nodes: readonly SeatNode[],
  stubHash: Uint8Array,
): Promise<SeatKeys[]> {
  const keys: SeatKeys[] = [];
  for (const s of nodes) {
    const secrets = await s.ceremony.intakeSecrets(stubHash);
    if (secrets === undefined) continue;
    keys.push({
      index: s.index,
      kemSecret: secrets.kemSecret,
      signingSecret: secrets.signingSecret,
    });
  }
  return keys;
}

/**
 * The nodes' electorate check ([[verifier]] 2.4 on a stub) against the
 * fixture's one Tier 0 group, which no group registry holds yet (`STUBS`,
 * electorate): one tier, group 1, whose root and size are the voters' tree.
 */
export function electorateCheck(electorate: Electorate): ElectorateCheck {
  return (stub) =>
    Promise.resolve(
      stub.electorate.length === 1 &&
        stub.electorate.every(
          (t) =>
            t.tier === 0 &&
            t.group_id === 1n &&
            t.root === electorate.root &&
            t.group_size === electorate.size,
        ),
    );
}

/**
 * Every node's intake of one cast ballot of the election `definition` and
 * `transcript` register: `record`, with seat `i + 1`'s ciphertext
 * `ciphertexts[i]`. Returns each seat's share receipt (`0x000b`), in seat
 * order; a node refusing an honest ballot stops the run.
 */
export async function nodeIntake(
  nodes: readonly SeatNode[],
  definition: ElectionDefinition,
  transcript: Uint8Array,
  record: Uint8Array,
  ciphertexts: readonly Uint8Array[],
): Promise<Uint8Array[]> {
  const stubBytes = stubOf(definition);
  const receipts: Uint8Array[] = [];
  for (const s of nodes) {
    const ciphertext = ciphertexts[s.index - 1];
    if (ciphertext === undefined) throw new Error(`no share ciphertext for seat ${s.index}`);
    const taken = await s.intake.intake(stubBytes, transcript, record, ciphertext);
    if (!taken.ok)
      throw new Error(`seat ${s.index}'s node refused an honest ballot: ${taken.code}`);
    receipts.push(taken.receipt);
  }
  return receipts;
}

/** The stub a definition was registered from: itself, before its transcript hash. */
export function stubOf(definition: ElectionDefinition): Uint8Array {
  return encodeElectionDefinition({ ...definition, ceremony_transcript_hash: new Uint8Array(32) });
}
