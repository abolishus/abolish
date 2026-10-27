import { readFileSync } from "node:fs";
import {
  type AnchorClock,
  checkContractEvent,
  decodeContractEvent,
  PARAMETERS,
  type RollingBallotChain,
  type RollingTierEvent,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks, judgeFor } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { authorRunOf, decodeDefinition, isRolling, readDefinition } from "../src/definition.ts";
import { type Report, splitEntries } from "../src/index.ts";

// Ballot admission (5.1 to 5.5, 5.7) under a rolling definition (definition
// version 7, `electorate_mode` 2), whose ballots (version 5) name the
// root-clock step their membership proof used: each is judged against the
// root of that step of its cell's tier, which @abolishus/crypto computes from
// the group registry's events and the definition's registration time, by
// every path a rolling poll has, with the rolling paths' supplied roots held
// to the step's own (docs/spec/verifier.md, Ballot admission; P2-17 part
// 4d-2a). verifyBundle still stops a rolling poll at 2.3 until it gives those
// events from the run, so these call `ceremonyChecks` and `ballotChecks` as
// it will. Fixtures: docs/spec/vectors/verifier-ballots-v5.json
// (packages/crypto/scripts/verifier-ballots-v5-vectors.py, an independent
// implementation that rebuilds every step root from the events, with
// snarkjs's verdict on every membership proof).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots: NonNullable<Report["ballots"]>;
}

interface File {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: readonly string[] }>
  >;
  readonly events: readonly {
    readonly block: string;
    readonly timestamp: string;
    readonly group: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  }[];
  readonly registeredAt: string;
  readonly cases: readonly Case[];
}

const file = JSON.parse(readFileSync(new URL("verifier-ballots-v5.json", VECTORS), "utf8")) as File;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const clock: AnchorClock = {
  epoch: BigInt(file.clock["epoch"] ?? ""),
  period: BigInt(file.clock["period"] ?? ""),
  deadline: BigInt(file.clock["deadline"] ?? ""),
  lastSegment: Number(file.clock["lastSegment"]),
};
const events: RollingTierEvent[] = file.events.map((e) => {
  const at = {
    blockNumber: BigInt(e.block),
    timestamp: BigInt(e.timestamp),
    groupId: BigInt(e.group),
  };
  return e.remove === undefined
    ? { ...at, kind: "add", commitments: (e.add ?? []).map(BigInt) }
    : { ...at, kind: "remove", indices: e.remove.map(BigInt) };
});
const chain: RollingBallotChain = { events, registeredAt: BigInt(file.registeredAt) };
const tau = (step: number) =>
  BigInt(step) * BigInt(PARAMETERS.ROOT_PERIOD) + BigInt(PARAMETERS.ROOT_OFFSET);

/** A case's definition, its ceremony's registered key set and its board's entries. */
function election(c: Case) {
  const definition = decodeDefinition(hex(c.definition));
  const { stubHash } = readDefinition(definition);
  const { entries } = splitEntries(hex(c.board));
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error(`no panel ${c.panel}`);
  const panel = { threshold: Number(p.threshold), keys: p.keys.map(hex) };
  const ceremony = ceremonyChecks(
    definition.value,
    stubHash,
    panel,
    authorRunOf(definition),
    entries,
    5,
  );
  return { definition, entries, ceremony };
}

// A row's empty `at` is left out of the vectors.
const plain = (rows: ReadonlyMap<string, { status: string; code?: string; at?: object }>) =>
  Object.fromEntries(
    [...rows].map(([id, { status, code, at }]) => [
      id,
      {
        status,
        ...(code !== undefined && { code }),
        ...(at !== undefined && Object.keys(at).length > 0 && { at }),
      },
    ]),
  );

/** The root the rolling path's entry 1 supplies for step N0's ballot, read through the event check. */
function rootOfStepN0(): bigint {
  const { definition, entries } = election(byId("rolling-path"));
  const d = definition.value;
  const record = decodeContractEvent((entries[1] as Uint8Array).subarray(51), 11);
  const checked = checkContractEvent(
    record,
    {
      electionRegistry: d.election_registry,
      trusteeRegistry: d.trustee_registry,
      groupRegistry: d.group_registry,
      board: d.board,
    },
    11,
  );
  if (!checked.ok || checked.event.event !== "RollingBallotSubmitted")
    throw new Error("entry 1 isn't a rolling ballot");
  return checked.event.root;
}

function admit(c: Case, rolling: RollingBallotChain | "none" = chain) {
  const { definition, entries, ceremony } = election(c);
  return ballotChecks(
    definition,
    ceremony.registered,
    ceremony.authorRegistered,
    entries,
    5,
    clock,
    undefined,
    rolling === "none" ? undefined : rolling,
  );
}

test("every definition is a rolling version 7", () => {
  for (const c of file.cases) {
    const { definition } = election(c);
    expect(isRolling(definition), c.id).toBe(true);
  }
});

describe("the vectors' rows and ballots", { timeout: 60_000 }, () => {
  for (const c of file.cases)
    test(c.id, () => {
      const { ceremony } = election(c);
      const r = admit(c);
      const rows = { ...plain(ceremony.rows), ...plain(r.rows) };
      for (const [id, want] of Object.entries(c.expected)) expect(rows[id], id).toEqual(want);
      expect(r.report).toEqual(c.ballots);
    });
});

describe("what a rolling ballot is judged against", { timeout: 60_000 }, () => {
  test("without the events no ballot is judged: every row is not reached", () => {
    const r = admit(byId("board"), "none");
    expect(plain(r.rows)).toEqual(
      Object.fromEntries(
        ["5.1", "5.2", "5.3", "5.4", "5.5", "5.7"].map((id) => [
          id,
          { status: "unverifiable", code: "not-reached" },
        ]),
      ),
    );
    expect(r.report).toBeUndefined();
  });

  test("events that don't give the definition's opening state are refused, never judged against", () => {
    // The first addition dropped: the opening tree is another (2.4 fails it).
    expect(() => admit(byId("board"), { ...chain, events: events.slice(1) })).toThrow(RangeError);
  });

  test("the registration time is the chain's: a later one leaves earlier steps unaccepted", () => {
    // Registered at step N0's boundary: N0 and every earlier step are no
    // longer inside the poll, so their ballots are root-step-range, and the
    // later steps' ballots are admitted as before.
    const r = admit(byId("board"), { ...chain, registeredAt: tau(2_966_400) });
    const codes = new Map(r.report?.rejected.map((x) => [x.entry, x.code]));
    for (const entry of [1, 2, 3]) expect(codes.get(entry), String(entry)).toBe("root-step-range");
    for (const entry of [4, 5]) expect(codes.has(entry), String(entry)).toBe(false);
  });

  test("the admitted ballots count in the cell they name, with no delivery fields yet", () => {
    const r = admit(byId("board"));
    expect(r.candidates?.map((x) => [x.entry, x.tally?.cell])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
      [4, 0],
      [5, 0],
    ]);
    for (const x of r.candidates ?? []) {
      expect(x.tally?.delivery).toBeUndefined();
      expect(x.tally?.deliveryV4).toBeUndefined();
    }
  });

  test("a supplied root only ever rejects: the step's own admits as no root does, any other is a mismatch", () => {
    const { definition, entries, ceremony } = election(byId("board"));
    const judge = judgeFor(definition, ceremony.registered, ceremony.authorRegistered, chain);
    if (typeof judge !== "function") throw new Error("no judge");
    // Entry 1's payload, step N0's ballot: a board entry's payload follows its 51-byte header.
    const ballot = (entries[1] as Uint8Array).subarray(51);
    const alone = judge(ballot).checked;
    expect(alone.ok).toBe(true);
    // The rolling path's vectors supply step N0's root for this ballot.
    const own = judge(ballot, rootOfStepN0()).checked;
    expect(own).toEqual(alone);
    expect(judge(ballot, 1n).checked).toEqual({ ok: false, code: "root-step-mismatch" });
  });
});
