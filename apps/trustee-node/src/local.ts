// A coordinator for local runs only: the `local-ceremony` command and the
// tests. It relays one ceremony between the panel's nodes as
// docs/spec/ceremony.md's coordinator does (trusted for liveness only),
// closing a round once every seat has sent or its deadline passes, and
// collects the approvals. The production coordinator is the creator's
// (README, Known-weak); this one holds no secret and nothing a node's
// duties rely on.
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  type AnswersMessage,
  type CeremonyCheck,
  type ChallengesMessage,
  type CeremonyTranscript,
  checkCeremonyTranscript,
  DecodeError,
  decodeElectionDefinitionRecord,
  displayTextCommitment,
  ELECTION_TYPES,
  type ElectionDefinition,
  electionId,
  encodeCeremonyTranscript,
  type KeysMessage,
  keySetEntry,
  keySetHash,
  membershipVkHash,
  newDisplayTextSalt,
  type Panel,
  panelId,
  RECORD_TYPES,
  type RevealsMessage,
  TALLY_SCHEMES,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import type { Coordinator } from "./client.ts";
import {
  type ApprovalPost,
  type CeremonyRequest,
  decodeApprovalPost,
  decodeMessagePost,
  encodeRequests,
  MAX_BODY,
  type MessagePost,
  requestTranscript,
  stubHashOf,
} from "./wire.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A version-1 stub for a local panel: a two-option poll on chain ids no network uses. */
export function localStub(
  panel: Panel,
  l2ChainId: bigint,
  trusteeRegistry: Uint8Array,
  change: Partial<ElectionDefinition> = {},
): ElectionDefinition {
  const registry = new Uint8Array(20).fill(0xa1);
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: t === RECORD_TYPES.boardEntry ? 4 : 1 });
  return {
    profile: { protocol_major: 1, pins },
    election_id: electionId(l2ChainId, registry, 7n),
    l2_chain_id: l2ChainId,
    l1_chain_id: 31337n,
    election_registry: registry,
    board: new Uint8Array(20).fill(0xa2),
    trustee_registry: trusteeRegistry,
    group_registry: new Uint8Array(20).fill(0xa4),
    l1_anchor: new Uint8Array(20).fill(0xb1),
    l1_relay: new Uint8Array(20).fill(0xb2),
    election_type: ELECTION_TYPES.plurality,
    tally_scheme: TALLY_SCHEMES.pedersenVss,
    option_count: 2,
    min_selections: 0,
    max_selections: 1,
    electorate: [{ tier: 0, group_id: 1n, root: 1n << 200n, root_l2_block: 1n, group_size: 3n }],
    membership_vk_hash: membershipVkHash(),
    panel_id: panelId(panel),
    threshold: panel.threshold,
    panel_size: panel.keys.length,
    ceremony_transcript_hash: new Uint8Array(32),
    opens_at: 1_000_000n,
    closes_at: 1_086_400n,
    l1_inclusion_bound: 3600,
    sequencing_window: 3600n,
    max_sequencer_drift: 1800n,
    display_text_commitment: displayTextCommitment({
      salt: newDisplayTextSalt(),
      translations: [
        {
          language: utf8("en"),
          question: utf8("A local ceremony."),
          description: utf8(""),
          options: [
            { label: utf8("Yes"), description: utf8("") },
            { label: utf8("No"), description: utf8("") },
          ],
        },
      ],
    }),
    ...change,
  };
}

/** A post the coordinator won't take: malformed, for another run or round, or a seat's second. */
export class CoordinatorRefusal extends Error {
  override readonly name = "CoordinatorRefusal";
}

export interface LocalCoordinatorOptions {
  readonly stub: Uint8Array;
  readonly panel: Panel;
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  /** How long a round, or the approvals, stay open for seats that haven't sent. */
  readonly roundMs: number;
  readonly now: () => number;
}

export interface LocalOutcome {
  readonly transcript: Uint8Array;
  readonly check: CeremonyCheck;
  /** The approvals that verified, by seat. */
  readonly approvals: ReadonlyMap<number, ApprovalPost>;
}

const FIELDS = ["keys", "challenges", "answers", "reveals"] as const;
type Field = (typeof FIELDS)[number];

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export class LocalCoordinator implements Coordinator {
  readonly #o: LocalCoordinatorOptions;
  readonly #stubHash: Uint8Array;
  readonly #electionId: Uint8Array;
  readonly #runId = crypto.getRandomValues(new Uint8Array(32));
  // Rounds 1 to 4 open in turn; 5 is the approvals.
  #round: 1 | 2 | 3 | 4 | 5 = 1;
  #opened: number;
  #sent = new Map<number, { index: number }>();
  readonly #closed: {
    keys: KeysMessage[];
    challenges: ChallengesMessage[];
    answers: AnswersMessage[];
    reveals: RevealsMessage[];
  } = { keys: [], challenges: [], answers: [], reveals: [] };
  #outcome: { transcript: Uint8Array; check: CeremonyCheck } | undefined;
  readonly #approvals = new Map<number, ApprovalPost>();

  constructor(options: LocalCoordinatorOptions) {
    const hash = stubHashOf(options.stub);
    if (hash === undefined) throw new RangeError("local coordinator: not a version-1 stub");
    this.#o = options;
    this.#stubHash = hash;
    this.#electionId = decodeElectionDefinitionRecord(options.stub).value.election_id;
    this.#opened = options.now();
  }

  get runId(): Uint8Array {
    return Uint8Array.from(this.#runId);
  }

  async requests(seat: number): Promise<readonly CeremonyRequest[]> {
    this.#tick();
    if (this.#round === 5) {
      const outcome = this.#outcome;
      if (outcome === undefined || !outcome.check.ok || this.#approvals.has(seat)) return [];
      return [{ stub: this.#o.stub, transcript: outcome.transcript }];
    }
    if (this.#sent.has(seat)) return [];
    return [{ stub: this.#o.stub, transcript: this.#transcript() }];
  }

  async postMessage(seat: number, post: MessagePost): Promise<void> {
    this.#tick();
    if (!equal(post.stub_hash, this.#stubHash)) throw new CoordinatorRefusal("another stub");
    let t: CeremonyTranscript;
    try {
      t = requestTranscript(post.transcript);
    } catch (e) {
      if (e instanceof DecodeError) throw new CoordinatorRefusal("malformed message");
      throw e;
    }
    if (!equal(t.run_id, this.#runId)) throw new CoordinatorRefusal("another run");
    if (this.#round === 5) throw new CoordinatorRefusal("rounds closed");
    const field = FIELDS[this.#round - 1] as Field;
    const message = t[field][0];
    if (
      FIELDS.some((f) => t[f].length !== (f === field ? 1 : 0)) ||
      message === undefined ||
      message.index !== seat
    )
      throw new CoordinatorRefusal("not this seat's message for the open round");
    // First message wins: a seat's second would be equivocation, and the
    // transcript holds one message per seat per round.
    if (this.#sent.has(seat)) throw new CoordinatorRefusal("already sent");
    this.#sent.set(seat, message);
    if (this.#sent.size === this.#o.panel.keys.length) this.#close();
  }

  async postApproval(seat: number, post: ApprovalPost): Promise<void> {
    this.#tick();
    const outcome = this.#outcome;
    if (this.#round !== 5 || outcome === undefined || !outcome.check.ok)
      throw new CoordinatorRefusal("no transcript to approve");
    if (
      !equal(post.stub_hash, this.#stubHash) ||
      !equal(post.ceremony_transcript_hash, outcome.check.hash) ||
      // The key set the transcript registers, as every honest seat signs.
      !equal(post.key_set_hash, keySetHash(outcome.check.registered.map(keySetEntry))) ||
      !verifyCeremonyRegistration(
        this.#o.panel,
        {
          l2ChainId: this.#o.l2ChainId,
          trusteeRegistry: this.#o.trusteeRegistry,
          index: seat,
          stubHash: post.stub_hash,
          ceremonyTranscriptHash: post.ceremony_transcript_hash,
          keySetHash: post.key_set_hash,
        },
        post.signature,
      )
    )
      throw new CoordinatorRefusal("approval doesn't verify");
    if (!this.#approvals.has(seat)) this.#approvals.set(seat, post);
  }

  /**
   * The outcome once the approvals have closed: every qualified seat
   * approved, or their deadline passed; `undefined` while open. A transcript
   * that fails its check closes at once with no approvals.
   */
  outcome(): LocalOutcome | undefined {
    this.#tick();
    const o = this.#outcome;
    if (this.#round !== 5 || o === undefined) return undefined;
    const qualified = o.check.ok ? o.check.registered.length : 0;
    if (
      o.check.ok &&
      this.#approvals.size < qualified &&
      this.#o.now() - this.#opened < this.#o.roundMs
    )
      return undefined;
    return { ...o, approvals: new Map(this.#approvals) };
  }

  #tick(): void {
    if (this.#round !== 5 && this.#o.now() - this.#opened >= this.#o.roundMs) this.#close();
  }

  #close(): void {
    if (this.#round === 5) return;
    const field = FIELDS[this.#round - 1] as Field;
    const messages = [...this.#sent.values()].sort((a, b) => a.index - b.index);
    (this.#closed[field] as { index: number }[]).push(...messages);
    this.#sent = new Map();
    this.#opened = this.#o.now();
    this.#round = (this.#round + 1) as 2 | 3 | 4 | 5;
    if (this.#round === 5) {
      const transcript = this.#transcript();
      const check = checkCeremonyTranscript(
        {
          l2ChainId: this.#o.l2ChainId,
          trusteeRegistry: this.#o.trusteeRegistry,
          electionId: this.#electionId,
          stubHash: this.#stubHash,
          panel: this.#o.panel,
        },
        transcript,
        1,
      );
      this.#outcome = { transcript, check };
    }
  }

  #transcript(): Uint8Array {
    return encodeCeremonyTranscript({ run_id: this.#runId, ...this.#closed });
  }
}

const ROUTE = /^\/v1\/ceremony\/seats\/([1-9][0-9]?)\/(requests|messages|approvals)$/;

/** The coordinator over HTTP on loopback, for nodes that reach it through `HttpCoordinator`. */
export async function serveCoordinator(
  coordinator: Coordinator,
  port = 0,
): Promise<{ readonly url: string; readonly server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const route = ROUTE.exec(req.url ?? "");
      const seat = Number(route?.[1]);
      const what = route?.[2];
      try {
        if (what === "requests" && req.method === "GET") {
          const body = encodeRequests(await coordinator.requests(seat));
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
        } else if (what === "messages" && req.method === "POST") {
          await coordinator.postMessage(seat, decodeMessagePost(await readBody(req)));
          res.writeHead(204).end();
        } else if (what === "approvals" && req.method === "POST") {
          await coordinator.postApproval(seat, decodeApprovalPost(await readBody(req)));
          res.writeHead(204).end();
        } else res.writeHead(404).end();
      } catch (e) {
        if (e instanceof CoordinatorRefusal || e instanceof DecodeError) res.writeHead(400).end();
        else res.writeHead(500).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("local coordinator: no port");
  return { url: `http://127.0.0.1:${address.port}/`, server };
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > MAX_BODY) throw new CoordinatorRefusal("body too large");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
