import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import {
  type ContractEventRecord,
  type ContractEventVersion,
  decodeBoardEntry,
  decodeContractEvent,
  decodeElectionDefinitionRecord,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { type ArchivedEvents, eventChecks } from "../src/events.ts";
import type { ContractSequence, ReplayedEvidence } from "../src/replay.ts";
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_CEREMONY,
  BUNDLE_FORMAT_DEFINITION,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// Formats 3 and 4: 4.4's per-record part, every contract-event record of the
// election on the copy decoded under the pinned contract-event version and
// judged by the event check against the definition's L2 contracts
// (docs/spec/verifier.md, Contract events). Fixtures:
// docs/spec/vectors/verifier-events.json
// (packages/crypto/scripts/verifier-events-vectors.py, an independent
// implementation over contract-event.json's and contract-event-v2.json's
// records and verdicts), with l1-anchor.json's L1 evidence, which is another
// election's and anchors none of these copies: 4.1 and 4.2 never pass, so a
// failing record leaves 4.4 unverifiable with its code. The fail status,
// inside an anchored extent, is tested below through `eventChecks` and in
// definition.test.ts over l1-anchor.json's anchored boards.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const raw = (name: string) => readFileSync(new URL(name, VECTORS));
const read = (name: string) => JSON.parse(raw(name).toString("utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly board: string;
  readonly expected: { readonly "4.4": Record<string, unknown> };
}

const file = read("verifier-events.json") as {
  readonly inputs: Readonly<Record<string, string>>;
  readonly cases: readonly Case[];
};

interface EventRecord {
  readonly id: string;
  readonly encoding: string;
  readonly error?: string;
}
interface EventFile {
  readonly records: readonly EventRecord[];
  readonly eventFailures: readonly EventRecord[];
  readonly decodeErrors: readonly (EventRecord & { readonly error: string })[];
}
const eventFiles = {
  1: read("contract-event.json") as EventFile,
  2: read("contract-event-v2.json") as EventFile,
};

const l1File = read("l1-anchor.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly electionId: string;
  readonly vectors: readonly {
    readonly id: string;
    readonly firstSegment: string;
    readonly block: { readonly header: string };
    readonly nodes: readonly string[];
    readonly checkpoints: readonly string[];
  }[];
};
const closed = l1File.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed L1 vector");
const l1 = {
  firstSegment: closed.firstSegment,
  header: closed.block.header,
  nodes: closed.nodes,
  checkpoints: closed.checkpoints,
};
// Any panel the bundle format accepts: 4.4 doesn't read it.
const panel = (
  read("verifier-tallies.json") as {
    readonly panels: Readonly<Record<string, unknown>>;
  }
).panels["panel-4"];

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const runs = (cap: number) => Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), cap);

const run = (c: Case, board = hex(c.board), format4 = false) =>
  verifyBundle(
    parseBundle(
      JSON.stringify({
        format: format4 ? BUNDLE_FORMAT_CEREMONY : BUNDLE_FORMAT_DEFINITION,
        definition: c.definition,
        clock: c.clock,
        l1,
        ...(format4 && { panel }),
      }),
      board,
    ),
  );

const row = (r: Report, id = "4.4") => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};

const u32 = (n: number) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u64 = (n: number) => [0, 0, 0, 0, ...u32(n)];
/**
 * A board entry of `version`, by docs/spec/board.md's layout, written here
 * rather than by @abolishus/crypto's encoder: record header, election,
 * index, segment 0 and the length-prefixed payload.
 */
const entry = (version: number, election: Uint8Array, index: number, payload: Uint8Array) =>
  Uint8Array.from([
    0x00,
    0x07,
    version,
    ...election,
    ...u64(index),
    ...u32(0),
    ...u32(payload.length),
    ...payload,
  ]);
const board = (version: number, election: Uint8Array, payloads: readonly Uint8Array[]) =>
  Uint8Array.from(payloads.flatMap((p, i) => [...entry(version, election, i, p)]));

// The election a vector case's board uses.
const electionOf = (c: Case) => hex(c.board).slice(3, 35);

test("the fixtures cover every event-check code, decoding and every unverifiable reason", () => {
  expect(new Set(file.cases.map((c) => c.expected["4.4"]["code"]))).toEqual(
    new Set([
      "not-implemented",
      "unsupported-version",
      "decode",
      "unknown-contract",
      "unknown-event",
      "event-topics",
      "event-data",
    ]),
  );
  // 4.4 never passes here (docs/spec/verifier.md, Contract events).
  expect(file.cases.every((c) => c.expected["4.4"]["status"] !== "pass")).toBe(true);
});

test("the fixtures were made from the contract-event vectors as committed", () => {
  for (const [name, digest] of Object.entries(file.inputs))
    expect(createHash("sha256").update(raw(name)).digest("hex")).toBe(digest);
});

// Generous: a version-6 copy decodes six Groth16 proofs per Tier 1 addition
// (B's subgroup check included), about 4 s for events-v6-records alone.
describe("4.4 against the independent implementation", { timeout: 60_000 }, () => {
  for (const c of file.cases)
    test(c.id, () => {
      const r = run(c);
      expect(row(r)).toEqual(c.expected["4.4"]);
      expect(r.checks.find((x) => x.id === "4.4")?.kind).toBe("election");
      // Nothing here is anchored, so no record fails the election, and the
      // copy is a local file, so the verdict stays unverifiable (T-53).
      expect(row(r, "4.2").status).not.toBe("pass");
      expect(r.verdict).toBe("unverifiable");
      // The panel changes nothing.
      expect(row(run(c, hex(c.board), true))).toEqual(c.expected["4.4"]);
    });
});

describe("every contract-event vector, boarded alone", () => {
  // Each record of the contract-event vectors, under its own version and
  // against its own contracts (the definitions of `v1-records` and
  // `v2-records` name them): a record passes and leaves 4.4
  // not-implemented, an event failure decides it with its code, and an
  // encoding that doesn't decode with `decode` and its code (unverifiable,
  // since nothing is anchored).
  for (const [version, id] of [
    [1, "v1-records"],
    [2, "v2-records"],
  ] as const) {
    const c = byId(id);
    const boardVersion = hex(c.board)[2] as number;
    const ev = eventFiles[version];
    const alone = (encoding: string) =>
      row(run(c, board(boardVersion, electionOf(c), [hex(encoding)])));
    test(`version ${version}: records pass`, () => {
      for (const r of ev.records)
        expect(alone(r.encoding), r.id).toEqual({
          status: "unverifiable",
          code: "not-implemented",
        });
    });
    test(`version ${version}: event failures decide 4.4 with their code`, () => {
      for (const r of ev.eventFailures)
        expect(alone(r.encoding), r.id).toEqual({
          status: "unverifiable",
          code: r.error,
          at: { entry: 0 },
        });
    });
    test(`version ${version}: decode failures decide 4.4 with decode`, () => {
      // A board entry carries a payload of at least a record header, and
      // only a payload of type 0x0008 is a contract-event record.
      const boardable = ev.decodeErrors.filter(
        (r) => r.encoding.startsWith("0008") && r.encoding.length >= 6,
      );
      expect(boardable.length).toBeGreaterThan(0);
      for (const r of boardable)
        expect(alone(r.encoding), r.id).toEqual({
          status: "unverifiable",
          code: "decode",
          at: { entry: 0, decodeError: r.error },
        });
    });
  }
});

describe("4.4 is the first failing record in copy order", () => {
  // A pool of version-2 records with their verdicts from contract-event-v2.json.
  const c = byId("v2-records");
  const boardVersion = hex(c.board)[2] as number;
  const ev = eventFiles[2];
  const pool: {
    readonly bytes: Uint8Array;
    readonly code?: string;
    readonly decodeError?: string;
  }[] = [
    ...ev.records.slice(0, 6).map((r) => ({ bytes: hex(r.encoding) })),
    ...ev.eventFailures.slice(0, 6).map((r) => ({ bytes: hex(r.encoding), code: r.error })),
    // Only these decode failures can be boarded (as in the test above).
    ...ev.decodeErrors
      .filter((r) => r.encoding.startsWith("0008") && r.encoding.length >= 6)
      .map((r) => ({
        bytes: hex(r.encoding),
        code: "decode",
        decodeError: r.error,
      })),
  ];
  const other = new Uint8Array(32).fill(0xee);

  test("any sequence of records, some in another election's entries, is decided by the first failing record of this election, or is not-implemented", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(pool.length - 1), fc.boolean()), { maxLength: 8 }),
        (picks) => {
          const entries = picks.map(([i, mine], at) =>
            entry(
              boardVersion,
              mine ? electionOf(c) : other,
              at,
              (pool[i] as (typeof pool)[number]).bytes,
            ),
          );
          const first = picks.findIndex(
            ([i, mine]) => mine && (pool[i] as (typeof pool)[number]).code !== undefined,
          );
          const want =
            first === -1
              ? { status: "unverifiable", code: "not-implemented" }
              : (() => {
                  const p = pool[(picks[first] as [number, boolean])[0]] as (typeof pool)[number];
                  return {
                    status: "unverifiable",
                    code: p.code,
                    at: {
                      entry: first,
                      ...(p.decodeError !== undefined && { decodeError: p.decodeError }),
                    },
                  };
                })();
          expect(row(run(c, Uint8Array.from(entries.flatMap((e) => [...e]))))).toEqual(want);
        },
      ),
      { numRuns: runs(1000) },
    );
  });
});

describe("where 4.4 runs", () => {
  test("a definition that stops the board checks leaves 4.4 not reached, in formats 3 and 4", () => {
    const c = byId("v1-records");
    // A definition with a trailing byte doesn't decode (2.1).
    const broken = { ...c, definition: `${c.definition}00` };
    for (const format4 of [false, true])
      expect(row(run(broken, hex(c.board), format4))).toEqual({
        status: "unverifiable",
        code: "not-reached",
      });
  });

  test("format 1 has no definition, so 4.4 is not implemented whatever the copy holds", () => {
    const c = byId("v1-unknown-contract");
    const r = verifyBundle(
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT,
          electionId: Buffer.from(electionOf(c)).toString("hex"),
          boardEntryVersion: 1,
          clock: c.clock,
          now: "0",
          anchors: [],
        }),
        hex(c.board),
      ),
    );
    expect(row(r)).toEqual({ status: "unverifiable", code: "not-implemented" });
  });

  test("a record is judged whatever 4.1 and 4.2 find", () => {
    // These bundles' anchors come from another election's L1 evidence, so
    // 4.2 never passes; 4.4 still names the record.
    const r = run(byId("first-failure"));
    expect(row(r, "4.2").status).not.toBe("pass");
    expect(row(r)).toEqual({ status: "unverifiable", code: "event-data", at: { entry: 1 } });
  });
});

describe("a record fails 4.4 only inside the anchored extent", () => {
  // `first-failure`: an honest creation at entry 0, a failing record at 1,
  // another at 2.
  const c = byId("first-failure");
  const definition = decodeElectionDefinitionRecord(hex(c.definition));
  const entries = parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_DEFINITION,
      definition: c.definition,
      clock: c.clock,
      l1,
    }),
    hex(c.board),
  ).entries;
  const boardVersion = hex(c.board)[2] as 4;

  test("inside it, the first failing record fails 4.4", () => {
    for (const anchored of [2, 3])
      expect(eventChecks(definition, entries, boardVersion, anchored)).toEqual({
        status: "fail",
        code: "event-data",
        at: { entry: 1 },
      });
  });

  test("past it, no record is read: an appended failing record changes nothing", () => {
    for (const anchored of [0, 1])
      expect(eventChecks(definition, entries, boardVersion, anchored)).toEqual({
        status: "unverifiable",
        code: "not-implemented",
      });
  });

  test("with no authenticated extent, the first failing record leaves 4.4 unverifiable with its code", () => {
    expect(eventChecks(definition, entries, boardVersion, undefined)).toEqual({
      status: "unverifiable",
      code: "event-data",
      at: { entry: 1 },
    });
  });
});

describe("4.4 against the archive's replay", () => {
  // `first-failure`'s honest creation at entry 0, read alone (anchored 1),
  // judged against made-up replays: the archive's word is never a failure
  // (docs/spec/verifier.md 4.4; src/replay.ts; T-53, T-71).
  const c = byId("first-failure");
  const definition = decodeElectionDefinitionRecord(hex(c.definition));
  const d = definition.value;
  const entries = parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_DEFINITION,
      definition: c.definition,
      clock: c.clock,
      l1,
    }),
    hex(c.board),
  ).entries;
  const boardVersion = hex(c.board)[2] as 4;
  const version = pinnedVersion(d, RECORD_TYPES.contractEvent) as ContractEventVersion;
  const creation = decodeContractEvent(
    decodeBoardEntry(entries[0] as Uint8Array, boardVersion).payload,
    version,
  );
  // The registry's sequence: copies of the creation at every other index
  // up to one past it, each passing the event check, and the creation at its own.
  const other = (n: bigint): ContractEventRecord => ({ ...creation, n });
  const registry = [
    ...Array.from({ length: Number(creation.n) }, (_, i) => other(BigInt(i))),
    creation,
    other(creation.n + 1n),
  ];
  const roles = [
    ["election-registry", d.election_registry],
    ["trustee-registry", d.trustee_registry],
    ["group-registry", d.group_registry],
    ["board", d.board],
  ] as const;
  const proven = (count: bigint, replay: ReplayedEvidence["replay"] = null) =>
    ({
      accumulator: {
        accumulator: new Uint8Array(32),
        count,
        block: 1n,
        blockHash: new Uint8Array(32),
        timestamp: 1n,
      },
      gameIndex: 0n,
      game: new Uint8Array(20),
      outputRoot: new Uint8Array(32),
      cid: new Uint8Array(36),
      transaction: new Uint8Array(32),
      replay,
    }) satisfies ReplayedEvidence;
  const sequence = (
    role: (typeof roles)[number][0],
    over: Partial<ContractSequence> = {},
  ): ContractSequence => {
    const contract = (roles.find(([r]) => r === role) as (typeof roles)[number])[1];
    const records = role === "election-registry" ? registry : [];
    const held = BigInt(records.length);
    return {
      role,
      contract,
      evidence: { records: held > 0n ? [proven(held)] : [], reads: 1, findings: [] },
      runs: { taken: [], complete: true, spent: 0, reads: 1, findings: [] },
      held,
      records,
      ...over,
    };
  };
  const archived = (
    over: Partial<Record<(typeof roles)[number][0], Partial<ContractSequence>>> = {},
    findings: ArchivedEvents["findings"] = [],
  ): ArchivedEvents => ({
    contracts: roles.map(([role]) => sequence(role, over[role])),
    findings,
  });
  const judge = (a: ArchivedEvents, anchored = 1) =>
    eventChecks(definition, entries, boardVersion, anchored, undefined, a);

  test("the creation is the registry's held event at its index: not implemented, for the required entries", () => {
    expect(creation.n).toBeGreaterThanOrEqual(0n);
    expect(judge(archived())).toEqual({ status: "unverifiable", code: "not-implemented" });
    // Without the archive, as before.
    expect(eventChecks(definition, entries, boardVersion, 1)).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
  });

  test("a boarded record other than the held event at its index is archived-mismatch", () => {
    const changed = registry.map((r) =>
      r.n === creation.n ? { ...r, l2_block: r.l2_block + 1n } : r,
    );
    expect(judge(archived({ "election-registry": { records: changed } }))).toEqual({
      status: "unverifiable",
      code: "archived-mismatch",
      at: { entry: 0 },
    });
  });

  test("a boarded record past what its contract holds is archived-unreached", () => {
    for (const held of [0n, creation.n])
      expect(judge(archived({ "election-registry": { held } }))).toEqual({
        status: "unverifiable",
        code: "archived-unreached",
        at: { entry: 0 },
      });
  });

  test("each contract's archive is judged in role order, before the boarded records", () => {
    const at = { contract: "trustee-registry" };
    const cases: [Partial<ContractSequence>, string][] = [
      [
        {
          evidence: {
            records: [],
            reads: 1,
            findings: [{ code: "evidence-reads-over-budget", maxReads: 1 }],
          },
        },
        "evidence-reads-over-budget",
      ],
      [
        { evidence: { records: [proven(3n, "accumulator")], reads: 1, findings: [] } },
        "accumulator",
      ],
      [
        { evidence: { records: [proven(3n, "block-range")], reads: 1, findings: [] } },
        "block-range",
      ],
      [
        {
          runs: {
            taken: [],
            complete: false,
            spent: 0,
            reads: 1,
            findings: [{ code: "run-gap", n: 0n }],
          },
        },
        "run-gap",
      ],
      [
        {
          runs: {
            taken: [],
            complete: false,
            spent: 0,
            reads: 1,
            findings: [{ code: "runs-over-budget", n: 0n, maxBytes: 1, maxReads: 1 }],
          },
        },
        "runs-over-budget",
      ],
      // An event of the registry's, held by the trustee registry's archive.
      [
        { records: [{ ...creation, contract: d.trustee_registry, n: 0n }], held: 1n },
        "unknown-event",
      ],
      [
        { evidence: { records: [proven(3n, "unreached")], reads: 1, findings: [] } },
        "event-topics",
      ],
    ];
    for (const [over, code] of cases) {
      // The election registry's mismatch comes after every contract's own judgement.
      const changed = registry.map((r) =>
        r.n === creation.n ? { ...r, l2_block: r.l2_block + 1n } : r,
      );
      expect(
        judge(archived({ "trustee-registry": over, "election-registry": { records: changed } })),
        code,
      ).toEqual({ status: "unverifiable", code, at });
    }
    // An event the held count doesn't reach isn't judged.
    expect(
      judge(
        archived({ board: { records: [{ ...creation, contract: d.board, n: 0n }], held: 0n } }),
      ),
    ).toEqual({ status: "unverifiable", code: "not-implemented" });
    // The walk keeping no more references comes first.
    expect(
      judge(
        archived({ "trustee-registry": cases[1]?.[0] ?? {} }, [
          { code: "evidence-over-budget", budget: 1 },
        ]),
      ),
    ).toEqual({ status: "unverifiable", code: "evidence-over-budget", at: {} });
  });

  test("a failing boarded record still decides 4.4 first, failed inside the anchored extent", () => {
    expect(judge(archived({ "election-registry": { held: 0n } }), 3)).toEqual({
      status: "fail",
      code: "event-data",
      at: { entry: 1 },
    });
  });
});
