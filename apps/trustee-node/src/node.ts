// The node's loop: ask the coordinator what it wants of this seat, answer
// through `CeremonySeat`, post the answer. Every duty is the seat's; this
// file only moves bytes, so a retry, a lost response or a coordinator that
// asks again gets what the seat's records decide (the seat resends a
// message it recorded, and refuses anything else).
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { type CeremonyTranscript, DecodeError, encodeCeremonyTranscript } from "@abolishus/crypto";
import type { CeremonySeat, SeatRefusal, SeatResult } from "./ceremony.ts";
import { type Coordinator, TransportError } from "./client.ts";
import {
  type Asked,
  asked,
  type CeremonyRequest,
  encodeRequests,
  requestTranscript,
  stubHashOf,
} from "./wire.ts";

/**
 * What the node reports, one event per request it acts on. Never a secret:
 * only hashes, run ids, rounds and refusal codes, all of which the
 * coordinator already holds.
 */
export type NodeEvent =
  | {
      readonly event: "sent";
      readonly round: Asked;
      readonly stubHash: string;
      readonly runId: string;
    }
  | {
      readonly event: "refused";
      readonly round: Asked | undefined;
      readonly code: SeatRefusal | "request";
      readonly stubHash?: string;
      readonly runId?: string;
    }
  | { readonly event: "transport"; readonly message: string };

export interface NodeOptions {
  readonly seat: CeremonySeat;
  /** This node's seat index, the one `seat` was built for. */
  readonly index: number;
  readonly coordinator: Coordinator;
  readonly log: (event: NodeEvent) => void;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Refusals a later poll can't change, so the node doesn't redo the seat's
// checks for them every poll. The electorate check can change as L2
// finalizes, and `no-run` once the node answers an earlier round listed
// after it, so both are asked again.
const FINAL: ReadonlySet<SeatRefusal | "request"> = new Set<SeatRefusal | "request">([
  "request",
  "stub-decode",
  "stub-version",
  "stub-transcript-hash",
  "stub-rule",
  "stub-pins",
  "stub-profile",
  "stub-membership-key",
  "stub-approved",
  "run-seen",
  "view",
  "rounds",
  "transcript",
  "participation",
  "approved-other",
]);

export class TrusteeNode {
  readonly #options: NodeOptions;
  // Requests answered or finally refused, by a digest of their bytes, so a
  // coordinator that keeps asking costs one lookup per poll. Pruned to the
  // current requests each poll, so it never outgrows one response.
  #done = new Set<string>();

  constructor(options: NodeOptions) {
    this.#options = options;
  }

  /** One poll: every request the coordinator has for this seat, each answered at most once. */
  async poll(): Promise<void> {
    const { coordinator, index, log } = this.#options;
    let requests: readonly CeremonyRequest[];
    try {
      requests = await coordinator.requests(index);
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      log({ event: "transport", message: e.message });
      return;
    }
    const current = new Set<string>();
    for (const request of requests) {
      // Over the request's encoding, which length-prefixes both fields.
      const id = createHash("sha256")
        .update(encodeRequests([request]))
        .digest("hex");
      current.add(id);
      if (this.#done.has(id)) continue;
      try {
        if (await this.#answer(request)) this.#done.add(id);
      } catch (e) {
        // Posting failed: asked again next poll, when the seat resends what it recorded.
        if (!(e instanceof TransportError)) throw e;
        log({ event: "transport", message: e.message });
      }
    }
    this.#done = new Set([...this.#done].filter((id) => current.has(id)));
  }

  /**
   * Polls every `intervalMs` until `signal` aborts. A poll that throws
   * anything but a transport error (a corrupt record, a broken store) ends
   * the loop: the node acts on nothing it can't read.
   */
  async run(signal: AbortSignal, intervalMs: number): Promise<void> {
    while (!signal.aborted) {
      await this.poll();
      // An abort during the poll or the wait ends the wait at once.
      await sleep(intervalMs, undefined, { signal }).catch((e: unknown) => {
        if (!signal.aborted) throw e;
      });
    }
  }

  /** Whether the request is settled: answered and posted, or refused for good. */
  async #answer(request: CeremonyRequest): Promise<boolean> {
    const { seat, index, coordinator, log } = this.#options;
    let t: CeremonyTranscript;
    try {
      t = requestTranscript(request.transcript);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      log({ event: "refused", round: undefined, code: "request" });
      return true;
    }
    const round = asked(t);
    const stubHash = stubHashOf(request.stub);
    const names = { runId: hex(t.run_id), ...(stubHash && { stubHash: hex(stubHash) }) };
    const refused = (code: SeatRefusal | "request") => {
      log({ event: "refused", round, code, ...names });
      return FINAL.has(code);
    };
    if (round === undefined) return refused("request");
    if (round === "approve") {
      const result = await seat.approve(request.stub, request.transcript);
      if (!result.ok) return refused(result.code);
      const { registration, signature } = result.value;
      await coordinator.postApproval(index, {
        stub_hash: registration.stubHash,
        ceremony_transcript_hash: registration.ceremonyTranscriptHash,
        key_set_hash: registration.keySetHash,
        signature,
      });
      log({ event: "sent", round, stubHash: hex(registration.stubHash), runId: names.runId });
      return true;
    }
    // Round 1 runs the stub checks, so its refusal is the seat's own; a
    // later round's stub the node can't hash names no run it began.
    if (stubHash === undefined && round !== 1) return refused("no-run");
    const empty = { keys: [], challenges: [], answers: [], reveals: [] };
    let result: SeatResult<{ index: number }>;
    let field: "keys" | "challenges" | "answers" | "reveals";
    if (round === 1) {
      result = await seat.keys(request.stub, t.run_id);
      field = "keys";
    } else if (round === 2) {
      result = await seat.challenges(stubHash as Uint8Array, t.run_id, t.keys);
      field = "challenges";
    } else if (round === 3) {
      result = await seat.answers(stubHash as Uint8Array, t.run_id, t);
      field = "answers";
    } else {
      result = await seat.reveals(stubHash as Uint8Array, t.run_id, t);
      field = "reveals";
    }
    if (!result.ok) return refused(result.code);
    // Round 1 passed the stub checks, which decode the stub, so it hashes.
    const hash = stubHash ?? (stubHashOf(request.stub) as Uint8Array);
    await coordinator.postMessage(index, {
      stub_hash: hash,
      transcript: encodeCeremonyTranscript({
        ...empty,
        run_id: t.run_id,
        [field]: [result.value],
      } as CeremonyTranscript),
    });
    log({ event: "sent", round, stubHash: hex(hash), runId: names.runId });
    return true;
  }
}
