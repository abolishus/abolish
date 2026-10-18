// The page–worker boundary (src/worker/protocol.ts, src/worker-client.ts):
// the worker accepts only exact, current-version requests, and the
// ballot-worker Trusted Types policy mints a script URL for the worker's own
// script and nothing else (T-43).

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { allowWorkerUrl, PROVER_URL, WORKER_URL } from "../src/worker-policy.ts";
import { parseRequest, PROTOCOL_VERSION, requestId, responseId } from "../src/worker/protocol.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const request = () => ({
  v: PROTOCOL_VERSION,
  id: 7,
  kind: "check-election",
  electionId: new Uint8Array(32),
  registeredHash: new Uint8Array(32).fill(1),
  definition: new Uint8Array([1, 2, 3]),
  displayText: new Uint8Array([4, 5]),
  entries: [new Uint8Array([6])],
  panels: [{ threshold: 2, keys: [new Uint8Array(33), new Uint8Array(33).fill(1)] }],
});

describe("requests", () => {
  test("accepts a well-formed request as it is", () => {
    expect(parseRequest(request())).toEqual(request());
  });

  test("accepts any id and any record bytes", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array(),
        fc.uint8Array(),
        (id, electionId, definition, displayText) => {
          const r = { ...request(), id, electionId, definition, displayText };
          expect(parseRequest(r)).toEqual(r);
        },
      ),
      { numRuns },
    );
  });

  test.each([
    ["another version", { v: PROTOCOL_VERSION + 1 }],
    ["an earlier version", { v: 1 }],
    ["a negative id", { id: -1 }],
    ["a fractional id", { id: 1.5 }],
    ["an id that isn't a number", { id: "7" }],
    ["another kind", { kind: "encrypt" }],
    ["a short election id", { electionId: new Uint8Array(31) }],
    ["a long election id", { electionId: new Uint8Array(33) }],
    ["an election id that isn't bytes", { electionId: Array(32).fill(0) }],
    ["a short registered hash", { registeredHash: new Uint8Array(31) }],
    ["a registered hash that isn't bytes", { registeredHash: "00".repeat(32) }],
    ["a definition that isn't bytes", { definition: "0102" }],
    ["display text that isn't bytes", { displayText: new Uint16Array(2) }],
    ["entries that aren't a list", { entries: new Uint8Array(4) }],
    ["an entry that isn't bytes", { entries: ["06"] }],
    ["panels that aren't a list", { panels: { threshold: 1, keys: [] } }],
    ["a panel with a fractional threshold", { panels: [{ threshold: 1.5, keys: [] }] }],
    ["a panel key that isn't bytes", { panels: [{ threshold: 1, keys: ["00"] }] }],
    ["a panel with an extra key", { panels: [{ threshold: 1, keys: [], extra: 1 }] }],
    ["a panel without keys", { panels: [{ threshold: 1 }] }],
    ["an extra key", { extra: true }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...request(), ...change })).toBeUndefined();
  });

  test.each([
    "v",
    "id",
    "kind",
    "electionId",
    "registeredHash",
    "definition",
    "displayText",
    "entries",
    "panels",
  ])("refuses a request without %s", (key) => {
    const r: Record<string, unknown> = request();
    delete r[key];
    expect(parseRequest(r)).toBeUndefined();
  });

  test("refuses anything that isn't a request object", () => {
    for (const x of [null, undefined, 7, "request", [request()], new Uint8Array(4)])
      expect(parseRequest(x)).toBeUndefined();
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(parseRequest(x)).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("a refused request with an id still gets its error; one without gets none", () => {
    expect(requestId({ id: 3, kind: "nonsense" })).toBe(3);
    expect(requestId({ kind: "nonsense" })).toBeUndefined();
    expect(requestId({ id: -3 })).toBeUndefined();
  });
});

describe("membership proof requests", () => {
  test("are refused, however well formed: a proof is made only by a cast, under the statement the worker derives from the poll it checked", () => {
    const { port1 } = new MessageChannel();
    port1.close();
    expect(
      parseRequest({
        v: PROTOCOL_VERSION,
        id: 9,
        kind: "prove-membership",
        secret: new Uint8Array(32).fill(2),
        leaves: [1n, 2n, 3n],
        definitionHash: new Uint8Array(32).fill(3),
        tier: 0,
        root: 5n,
        message: new Uint8Array(32).fill(4),
        prover: port1,
      }),
    ).toBeUndefined();
  });
});

describe("seal and challenge requests", () => {
  const seal = () => ({
    v: PROTOCOL_VERSION,
    id: 11,
    kind: "seal",
    definitionHash: new Uint8Array(32).fill(8),
    cell: 0,
    votes: [1, 0, 0, 1],
  });
  const challenge = () => ({ v: PROTOCOL_VERSION, id: 12, kind: "challenge", seal: 3 });

  test("accepts well-formed requests as they are", () => {
    expect(parseRequest(seal())).toEqual(seal());
    expect(parseRequest(challenge())).toEqual(challenge());
  });

  test("accepts any cell and any votes of 0 and 1: their limits are the seal's", () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(fc.constantFrom(0, 1)), (cell, votes) => {
        const r = { ...seal(), cell, votes };
        expect(parseRequest(r)).toEqual(r);
      }),
      { numRuns },
    );
  });

  test.each([
    ["a short definition hash", { definitionHash: new Uint8Array(31) }],
    ["a fractional cell", { cell: 0.5 }],
    ["a cell as a string", { cell: "0" }],
    ["a vote of 2", { votes: [1, 2] }],
    ["a vote as a boolean", { votes: [true] }],
    ["votes that aren't a list", { votes: new Uint8Array(2) }],
    ["an extra key", { extra: true }],
  ])("refuses a seal with %s", (_, change) => {
    expect(parseRequest({ ...seal(), ...change })).toBeUndefined();
  });

  test.each([
    ["a negative seal", { seal: -1 }],
    ["a seal as a string", { seal: "3" }],
    ["an extra key", { votes: [] }],
  ])("refuses a challenge with %s", (_, change) => {
    expect(parseRequest({ ...challenge(), ...change })).toBeUndefined();
  });

  test("refuses either without one of its keys", () => {
    for (const make of [seal, challenge])
      for (const key of Object.keys(make())) {
        const r: Record<string, unknown> = make();
        delete r[key];
        expect(parseRequest(r)).toBeUndefined();
      }
  });
});

describe("cast requests", () => {
  const { port1 } = new MessageChannel();
  const cast = () => ({
    v: PROTOCOL_VERSION,
    id: 13,
    kind: "cast",
    seal: 2,
    secret: new Uint8Array(32).fill(2),
    l1Number: 9_000_000n,
    l1Hash: new Uint8Array(32).fill(5),
    prover: port1,
  });
  port1.close();

  test("accepts a well-formed request as it is, its port included", () => {
    const parsed = parseRequest(cast());
    expect(parsed).toEqual(cast());
    expect(parsed?.kind === "cast" && parsed.prover).toBe(port1);
  });

  test("accepts any u64 block number", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (l1Number) => {
        const r = { ...cast(), l1Number };
        expect(parseRequest(r)).toEqual(r);
      }),
      { numRuns },
    );
  });

  test.each([
    ["a negative seal", { seal: -1 }],
    ["a seal as a string", { seal: "2" }],
    ["a short secret", { secret: new Uint8Array(31) }],
    ["a long secret", { secret: new Uint8Array(33) }],
    ["a secret as hex", { secret: "02".repeat(32) }],
    // The worker's leaves are the cell find-cell found, never the page's.
    ["leaves", { leaves: [1n, 2n, 3n] }],
    ["a block number as a number", { l1Number: 9_000_000 }],
    ["a negative block number", { l1Number: -1n }],
    ["a block number past a u64", { l1Number: 2n ** 64n }],
    ["a short block hash", { l1Hash: new Uint8Array(31) }],
    ["a long block hash", { l1Hash: new Uint8Array(33) }],
    ["a prover that isn't a port", { prover: {} }],
    ["an extra key", { extra: true }],
    ["another version", { v: PROTOCOL_VERSION - 1 }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...cast(), ...change })).toBeUndefined();
  });

  test("refuses a request without one of its keys", () => {
    for (const key of Object.keys(cast())) {
      const r: Record<string, unknown> = cast();
      delete r[key];
      expect(parseRequest(r)).toBeUndefined();
    }
  });
});

describe("find-cell requests", () => {
  const find = () => ({
    v: PROTOCOL_VERSION,
    id: 14,
    kind: "find-cell",
    definitionHash: new Uint8Array(32).fill(8),
    secret: new Uint8Array(32).fill(2),
    tier: 0,
    group: 1n,
    entries: [new Uint8Array([6]), new Uint8Array(0)],
    registrars: [new Uint8Array(20).fill(1)],
    threshold: 1,
  });

  test("accepts a well-formed request as it is", () => {
    expect(parseRequest(find())).toEqual(find());
  });

  test("accepts any tier, u64 group, entries and pins: their checks are voterCellV5's", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        fc.array(fc.uint8Array()),
        fc.array(fc.uint8Array()),
        fc.integer(),
        (tier, group, entries, registrars, threshold) => {
          const r = { ...find(), tier, group, entries, registrars, threshold };
          expect(parseRequest(r)).toEqual(r);
        },
      ),
      { numRuns },
    );
  });

  test.each([
    ["a short definition hash", { definitionHash: new Uint8Array(31) }],
    ["a short secret", { secret: new Uint8Array(31) }],
    ["a secret as hex", { secret: "02".repeat(32) }],
    ["a fractional tier", { tier: 0.5 }],
    ["a tier as a string", { tier: "0" }],
    ["a group as a number", { group: 1 }],
    ["a negative group", { group: -1n }],
    ["a group past a u64", { group: 2n ** 64n }],
    ["an entry as hex", { entries: ["06"] }],
    // oxlint-disable-next-line no-sparse-arrays -- a hole is what is refused
    ["entries with a hole", { entries: [new Uint8Array(1), , new Uint8Array(1)] }],
    ["a registrar as hex", { registrars: ["01".repeat(20)] }],
    ["a threshold as a string", { threshold: "1" }],
    ["an extra key", { extra: true }],
    ["another version", { v: PROTOCOL_VERSION - 1 }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...find(), ...change })).toBeUndefined();
  });

  test("refuses a request without one of its keys", () => {
    for (const key of Object.keys(find())) {
      const r: Record<string, unknown> = find();
      delete r[key];
      expect(parseRequest(r)).toBeUndefined();
    }
  });
});

describe("commitment requests", () => {
  const commit = () => ({
    v: PROTOCOL_VERSION,
    id: 15,
    kind: "commitment",
    secret: new Uint8Array(32).fill(2),
  });

  test("accepts a well-formed request as it is, for any 32 bytes: their range is the session's", () => {
    fc.assert(
      fc.property(fc.nat(), fc.uint8Array({ minLength: 32, maxLength: 32 }), (id, secret) => {
        const r = { ...commit(), id, secret };
        expect(parseRequest(r)).toEqual(r);
      }),
      { numRuns },
    );
  });

  test.each([
    ["a short secret", { secret: new Uint8Array(31) }],
    ["a long secret", { secret: new Uint8Array(33) }],
    ["a secret as hex", { secret: "02".repeat(32) }],
    ["a secret as a list", { secret: Array(32).fill(2) }],
    ["an extra key", { extra: true }],
    ["another version", { v: PROTOCOL_VERSION - 1 }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...commit(), ...change })).toBeUndefined();
  });

  test("refuses a request without one of its keys", () => {
    for (const key of Object.keys(commit())) {
      const r: Record<string, unknown> = commit();
      delete r[key];
      expect(parseRequest(r)).toBeUndefined();
    }
  });
});

describe("registration outcome requests", () => {
  const outcome = () => ({
    v: PROTOCOL_VERSION,
    id: 16,
    kind: "tier0-outcome",
    secret: new Uint8Array(32).fill(2),
    region: 0,
    block: 1_000n,
    groups: [
      { group_id: 1n, region: 0 },
      { group_id: 2n, region: 3 },
    ],
    records: [new Uint8Array([0, 8, 8])],
    registry: new Uint8Array(20).fill(0xaa),
    chainId: 84532n,
    version: 8,
    registrars: [new Uint8Array(20).fill(1)],
    threshold: 1,
  });

  test("accepts a well-formed request as it is, for any secret, block and records: their meaning is the session's", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        fc.array(fc.uint8Array()),
        fc.integer({ min: 1, max: 8 }),
        (id, secret, block, records, version) => {
          const r = { ...outcome(), id, secret, block, records, version };
          expect(parseRequest(r)).toEqual(r);
        },
      ),
      { numRuns },
    );
  });

  test.each([
    ["a short secret", { secret: new Uint8Array(31) }],
    ["a secret as hex", { secret: "02".repeat(32) }],
    ["a fractional region", { region: 0.5 }],
    ["a region as a string", { region: "0" }],
    ["a negative block", { block: -1n }],
    ["a block past u64", { block: 2n ** 64n }],
    ["a block as a number", { block: 1000 }],
    ["a group with an extra key", { groups: [{ group_id: 1n, region: 0, tier: 0 }] }],
    ["a group id as a number", { groups: [{ group_id: 1, region: 0 }] }],
    ["a group id past u64", { groups: [{ group_id: 2n ** 64n, region: 0 }] }],
    // oxlint-disable-next-line no-sparse-arrays -- a hole is what is refused
    ["a group list with a hole", { groups: [, { group_id: 1n, region: 0 }] }],
    ["a record as hex", { records: ["000808"] }],
    ["a short registry", { registry: new Uint8Array(19) }],
    ["a chain id as a number", { chainId: 84532 }],
    ["event version 0", { version: 0 }],
    ["event version 9", { version: 9 }],
    ["a fractional event version", { version: 7.5 }],
    ["a registrar as hex", { registrars: ["01".repeat(20)] }],
    ["a fractional threshold", { threshold: 1.5 }],
    ["an extra key", { extra: true }],
    ["another version", { v: PROTOCOL_VERSION - 1 }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...outcome(), ...change })).toBeUndefined();
  });

  test("refuses a request without one of its keys", () => {
    for (const key of Object.keys(outcome())) {
      const r: Record<string, unknown> = outcome();
      delete r[key];
      expect(parseRequest(r)).toBeUndefined();
    }
  });
});

describe("responses", () => {
  test("matches a current response to its request", () => {
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "check-election", result: {} })).toBe(4);
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "error" })).toBe(4);
    expect(responseId({ v: PROTOCOL_VERSION, id: 6, kind: "seal", result: {} })).toBe(6);
    expect(responseId({ v: PROTOCOL_VERSION, id: 7, kind: "challenge", result: {} })).toBe(7);
    expect(responseId({ v: PROTOCOL_VERSION, id: 8, kind: "cast", result: {} })).toBe(8);
    expect(responseId({ v: PROTOCOL_VERSION, id: 9, kind: "find-cell", result: {} })).toBe(9);
    expect(responseId({ v: PROTOCOL_VERSION, id: 10, kind: "commitment", result: {} })).toBe(10);
    expect(responseId({ v: PROTOCOL_VERSION, id: 11, kind: "tier0-outcome", result: {} })).toBe(11);
  });

  test("ignores another version's response or kind", () => {
    expect(responseId({ v: PROTOCOL_VERSION + 1, id: 4, kind: "error" })).toBeUndefined();
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "ready" })).toBeUndefined();
    expect(
      responseId({ v: PROTOCOL_VERSION, id: 5, kind: "prove-membership", result: {} }),
    ).toBeUndefined();
    expect(responseId({ v: PROTOCOL_VERSION, kind: "error" })).toBeUndefined();
  });
});

describe("the ballot-worker policy", () => {
  test("mints the two workers' own script URLs", () => {
    expect(WORKER_URL).toMatch(/worker/);
    expect(allowWorkerUrl(WORKER_URL)).toBe(WORKER_URL);
    expect(PROVER_URL).toMatch(/prover/);
    expect(allowWorkerUrl(PROVER_URL)).toBe(PROVER_URL);
  });

  test("refuses every other URL", () => {
    for (const url of [
      "https://example.com/worker.js",
      `${WORKER_URL}?x`,
      `${WORKER_URL}#x`,
      ` ${WORKER_URL}`,
      WORKER_URL.toUpperCase(),
      `${PROVER_URL}?x`,
      ` ${PROVER_URL}`,
      "data:text/javascript,postMessage(1)",
      "blob:null/0",
    ])
      expect(() => allowWorkerUrl(url)).toThrow(TypeError);
    fc.assert(
      fc.property(fc.string(), (url) => {
        fc.pre(url !== WORKER_URL && url !== PROVER_URL);
        expect(() => allowWorkerUrl(url)).toThrow(TypeError);
      }),
      { numRuns },
    );
  });
});
