// The panel's trustee nodes (apps/trustee-node, P2-13): each seat runs the
// node's own ceremony duties (`CeremonySeat`: the stub checks, the four
// rounds, the transcript check and the one approval per stub) and its intake
// (`IntakeSeat`: the election checks, crypto's admission checks and
// decryption, the shares held before the receipt), over a store of its own on
// disk, as a deployed node does. The fixture is only the coordinator here,
// relaying rounds and collecting approvals (docs/spec/ceremony.md: trusted
// for liveness only), and the deployment, supplying the electorate and
// registration checks and the clock (T-37, T-54, T-14, T-41). Ballots reach
// each node at its intake endpoint, over TLS 1.3 with the hybrid
// post-quantum group, as a client delivers them (T-39, T-11).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
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
  type Delivery,
  type ElectorateCheck,
  type Endpoint,
  encodeDelivery,
  FileStore,
  INTAKE_GROUPS,
  IntakeSeat,
  type RegistrationCheck,
  type SeatResult,
  serveIntake,
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

/** A seat's intake endpoint as a client reaches it: its URL and the certificate the client pins. */
export interface SeatEndpoint {
  readonly index: number;
  readonly url: string;
  readonly ca: string;
}

export interface ServedSeats {
  readonly endpoints: readonly SeatEndpoint[];
  close(): Promise<void>;
}

/**
 * Serves every node's intake endpoint on loopback over HTTPS, as `run`
 * serves it with the TLS files: TLS 1.3 and `X25519MLKEM768` only (T-39).
 * Each seat gets a self-signed certificate of its own, made by `openssl`
 * under `root` beside the stores, which its clients pin in place of the Web
 * PKI a deployed node's certificate chains to.
 */
export async function serveSeats(root: string, nodes: readonly SeatNode[]): Promise<ServedSeats> {
  const served: Endpoint[] = [];
  const endpoints: SeatEndpoint[] = [];
  try {
    for (const s of nodes) {
      const tls = selfSigned(join(root, `tls-${s.index}`));
      const endpoint = await serveIntake(s.intake, { host: "127.0.0.1", port: 0, tls, queue: 1 });
      served.push(endpoint);
      endpoints.push({ index: s.index, url: endpoint.url, ca: tls.cert });
    }
  } catch (e) {
    await Promise.all(served.map((s) => s.close()));
    throw e;
  }
  return {
    endpoints,
    close: async () => {
      await Promise.all(served.map((e) => e.close()));
    },
  };
}

function selfSigned(dir: string): { readonly cert: string; readonly key: string } {
  mkdirSync(dir, { mode: 0o700 });
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
}

/** The endpoint's answer: the share receipt on 200, the refusal's code on 422, otherwise the status alone. */
export type Delivered =
  | { readonly ok: true; readonly receipt: Uint8Array }
  | { readonly ok: false; readonly status: number; readonly code?: string };

/**
 * One delivery to a seat's endpoint, as the client's direct route sends it
 * (docs/spec/delivery.md, Client rules 4): `POST /v1/intake`, offering only the hybrid
 * group, so a classical-only handshake fails rather than carry `ct_i`.
 */
export function deliver(endpoint: SeatEndpoint, delivery: Delivery): Promise<Delivered> {
  const body = encodeDelivery(delivery);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      endpoint.url,
      {
        method: "POST",
        // A connection of its own: no kept-alive socket the server may close
        // as it is reused, and nothing joining two deliveries (T-11).
        agent: false,
        ca: endpoint.ca,
        ecdhCurve: INTAKE_GROUPS,
        minVersion: "TLSv1.3",
        headers: { "content-type": "application/octet-stream", "content-length": body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const answer = new Uint8Array(Buffer.concat(chunks));
          const status = res.statusCode ?? 0;
          if (status === 200) resolve({ ok: true, receipt: answer });
          else if (status === 422)
            resolve({ ok: false, status, code: new TextDecoder().decode(answer) });
          else resolve({ ok: false, status });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Every seat's intake of one cast ballot of the election `definition` and
 * `transcript` register, delivered to each seat's endpoint: `record`, with
 * seat `i + 1`'s ciphertext `ciphertexts[i]`. Returns each seat's share
 * receipt (`0x000b`), in seat order; a node refusing an honest ballot stops
 * the run.
 */
export async function nodeIntake(
  endpoints: readonly SeatEndpoint[],
  definition: ElectionDefinition,
  transcript: Uint8Array,
  record: Uint8Array,
  ciphertexts: readonly Uint8Array[],
): Promise<Uint8Array[]> {
  const stub = stubOf(definition);
  const receipts: Uint8Array[] = [];
  for (const e of endpoints) {
    const ciphertext = ciphertexts[e.index - 1];
    if (ciphertext === undefined) throw new Error(`no share ciphertext for seat ${e.index}`);
    const taken = await deliver(e, { stub, transcript, record, ciphertext });
    if (!taken.ok)
      throw new Error(
        `seat ${e.index}'s node refused an honest ballot: ${taken.code ?? `HTTP ${taken.status}`}`,
      );
    receipts.push(taken.receipt);
  }
  return receipts;
}

/** The stub a definition was registered from: itself, before its transcript hash. */
export function stubOf(definition: ElectionDefinition): Uint8Array {
  return encodeElectionDefinition({ ...definition, ceremony_transcript_hash: new Uint8Array(32) });
}
