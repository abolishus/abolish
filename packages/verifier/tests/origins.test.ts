import { readFileSync } from "node:fs";
import {
  checkContractEvent,
  decodeBoardEntry,
  decodeContractEvent,
  encodeBoardEntry,
  encodeContractEvent,
  type L1Origin,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { type L1Header, splitEntries } from "../src/index.ts";
import { decodeDefinition } from "../src/definition.ts";
import { eventChecks, originCode, PINNED_SEQUENCER_DRIFT } from "../src/events.ts";

// 4.4's L1-origin checks (docs/spec/verifier.md, Contract events, step 5;
// docs/spec/contracts.md, Election registry, The L1 origin) over the
// election's own `ElectionCreated` and `DefinitionRegistered`. The records
// are verifier-events.json's (contract-event-v2.json's honest ones), with
// the creation re-addressed to the definition's election by its indexed
// topic, which the event check reads the identifier from, and its L2
// timestamp moved; every one still passes the event check.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const file = JSON.parse(readFileSync(new URL("verifier-events.json", VECTORS), "utf8")) as {
  readonly cases: readonly {
    readonly id: string;
    readonly definition: string;
    readonly board: string;
  }[];
};
const c = file.cases.find((x) => x.id === "v2-records");
if (c === undefined) throw new Error("no v2-records case");
const definition = decodeDefinition(Uint8Array.from(Buffer.from(c.definition, "hex")));
const d = definition.value;
const contracts = {
  electionRegistry: d.election_registry,
  trusteeRegistry: d.trustee_registry,
  groupRegistry: d.group_registry,
  board: d.board,
};
const board = splitEntries(Uint8Array.from(Buffer.from(c.board, "hex"))).entries;
// Entry 0 is the honest creation: origin block 19,000,000 at 1,760,000,000.
const creation = decodeBoardEntry(board[0] as Uint8Array, 4);
const record = decodeContractEvent(creation.payload, 2);
const ORIGIN = 1_760_000_000n;

/** The creation, as this election's, emitted in an L2 block at `l2Timestamp`. */
function created(l2Timestamp: bigint): Uint8Array {
  const topics = record.topics.map((t, i) => (i === 1 ? d.election_id : t));
  const payload = encodeContractEvent({ ...record, topics, l2_timestamp: l2Timestamp }, 2);
  const checked = checkContractEvent(decodeContractEvent(payload, 2), contracts, 2);
  if (!checked.ok || checked.event.event !== "ElectionCreated")
    throw new Error("fixture: the re-addressed creation fails the event check");
  return encodeBoardEntry({ ...creation, election_id: d.election_id, payload }, 4);
}
const header = (number: bigint, timestamp: bigint, hash: Uint8Array): L1Header => ({
  hash,
  parentHash: new Uint8Array(32),
  stateRoot: new Uint8Array(32),
  number,
  timestamp,
});

describe("the creation's L1 origin", () => {
  test("the event's L2 block is at or after its origin, by at most the pinned drift", () => {
    const run = (t: bigint, anchored?: number) =>
      eventChecks(definition, [created(t)], 4, anchored);
    for (const t of [ORIGIN, ORIGIN + PINNED_SEQUENCER_DRIFT])
      expect(run(t, 1)).toEqual({ status: "unverifiable", code: "not-implemented" });
    for (const t of [ORIGIN - 1n, ORIGIN + PINNED_SEQUENCER_DRIFT + 1n]) {
      expect(run(t, 1)).toEqual({ status: "fail", code: "l1-origin-drift", at: { entry: 0 } });
      // On a copy the board checks don't authenticate, the code but no failure (T-53).
      expect(run(t)).toEqual({
        status: "unverifiable",
        code: "l1-origin-drift",
        at: { entry: 0 },
      });
    }
  });

  test("a finalized run holding the origin's number must hold the origin's block", () => {
    const origin = decodeContractEvent(decodeBoardEntry(created(ORIGIN), 4).payload, 2);
    const event = checkContractEvent(origin, contracts, 2);
    if (!event.ok || event.event.event !== "ElectionCreated") throw new Error("unreachable");
    const { number, hash } = event.event.l1Origin;
    const run = (blocks: readonly L1Header[]) =>
      eventChecks(definition, [created(ORIGIN)], 4, 1, blocks);
    expect(run([header(number, ORIGIN, hash)])).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
    const other = Uint8Array.from(hash).map((x, i) => (i === 0 ? x ^ 1 : x));
    for (const blocks of [[header(number, ORIGIN, other)], [header(number, ORIGIN + 12n, hash)]])
      expect(run(blocks)).toEqual({
        status: "fail",
        code: "l1-origin-unknown",
        at: { entry: 0 },
      });
    // A run that doesn't reach the origin decides nothing about it.
    expect(run([header(number + 1n, ORIGIN + 12n, other)])).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
    expect(run([header(number - 5n, ORIGIN - 60n, other)])).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
  });

  test("another election's events are never judged", () => {
    // The vector's own creation names another election and breaks the drift.
    const late = encodeBoardEntry(
      {
        ...creation,
        payload: encodeContractEvent({ ...record, l2_timestamp: ORIGIN - 100n }, 2),
      },
      4,
    );
    expect(eventChecks(definition, [late], 4, 1)).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
  });
});

describe("the registration against the creation", () => {
  // Entry 1 is an honest registration; its origin is the data's words 0 to 2,
  // the creation's words 1 to 3.
  const registration = decodeBoardEntry(board[1] as Uint8Array, 4);
  const registered = decodeContractEvent(registration.payload, 2);
  const setWord = (data: Uint8Array, at: number, value: bigint) => {
    const out = Uint8Array.from(data);
    for (let i = 0, x = value; i < 32; i++, x >>= 8n) out[at * 32 + 31 - i] = Number(x & 0xffn);
    return out;
  };
  const entry = (
    base: ReturnType<typeof decodeBoardEntry>,
    r: ReturnType<typeof decodeContractEvent>,
    ours: boolean,
    originAt: number,
    origin: { readonly number: bigint; readonly timestamp: bigint },
    l2Timestamp: bigint,
  ) => {
    const data = setWord(setWord(r.data, originAt, origin.number), originAt + 1, origin.timestamp);
    const topics = r.topics.map((t, i) => (i === 1 && ours ? d.election_id : t));
    const payload = encodeContractEvent({ ...r, topics, data, l2_timestamp: l2Timestamp }, 2);
    if (!checkContractEvent(decodeContractEvent(payload, 2), contracts, 2).ok)
      throw new Error("fixture: a record fails the event check");
    return encodeBoardEntry({ ...base, election_id: d.election_id, payload }, 4);
  };

  test("only the election's own creation is compared, never another election's", () => {
    const copy = [
      // Another election's creation, with an earlier origin.
      entry(
        creation,
        record,
        false,
        1,
        { number: 18_999_990n, timestamp: ORIGIN - 120n },
        ORIGIN - 100n,
      ),
      entry(creation, record, true, 1, { number: 19_000_000n, timestamp: ORIGIN }, ORIGIN + 10n),
      // This election's registration, before its creation's origin.
      entry(
        registration,
        registered,
        true,
        0,
        { number: 18_999_995n, timestamp: ORIGIN - 60n },
        ORIGIN - 50n,
      ),
    ];
    expect(eventChecks(definition, copy, 4, 3)).toEqual({
      status: "fail",
      code: "l1-origin-order",
      at: { entry: 2 },
    });
    // At its creation's origin, it is in order.
    copy[2] = entry(
      registration,
      registered,
      true,
      0,
      { number: 19_000_000n, timestamp: ORIGIN },
      ORIGIN + 20n,
    );
    expect(eventChecks(definition, copy, 4, 3)).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
  });

  test("the drift is the release's pin, Base's 30 minutes", () => {
    expect(PINNED_SEQUENCER_DRIFT).toBe(1800n);
  });
});

describe("the three checks, in order", () => {
  const origin = (number: bigint, timestamp: bigint): L1Origin => ({
    number,
    timestamp,
    hash: new Uint8Array(32).fill(Number(number % 251n)),
  });

  test("a registration's origin is at or after its creation's, by number and by time", () => {
    const made = origin(100n, 1000n);
    expect(originCode(origin(100n, 1000n), 1000n, made, undefined)).toBeUndefined();
    expect(originCode(origin(99n, 1000n), 1000n, made, undefined)).toBe("l1-origin-order");
    expect(originCode(origin(100n, 999n), 1000n, made, undefined)).toBe("l1-origin-order");
    // Without the creation on the copy, nothing to compare with.
    expect(originCode(origin(1n, 1n), 1n, undefined, undefined)).toBeUndefined();
  });

  test("the first failing check is the code (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n }),
        fc.bigInt({ min: 0n, max: 3000n }),
        fc.bigInt({ min: 0n, max: 4000n }),
        fc.boolean(),
        fc.boolean(),
        (number, timestamp, l2, known, ordered) => {
          const o = origin(number, timestamp);
          const run = [header(number, timestamp, known ? o.hash : new Uint8Array(32).fill(255))];
          const made = ordered ? origin(0n, 0n) : origin(number + 1n, timestamp);
          const expected = !known
            ? "l1-origin-unknown"
            : l2 < timestamp || l2 > timestamp + PINNED_SEQUENCER_DRIFT
              ? "l1-origin-drift"
              : !ordered
                ? "l1-origin-order"
                : undefined;
          expect(originCode(o, l2, made, run)).toBe(expected);
        },
      ),
      { numRuns },
    );
  });
});
