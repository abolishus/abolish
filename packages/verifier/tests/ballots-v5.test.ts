import { readFileSync } from "node:fs";
import {
  type AnchorClock,
  checkContractEvent,
  decodeBallot,
  decodeContractEvent,
  DecodeError,
  PARAMETERS,
  type RollingBallotChain,
  type RollingTierEvent,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { electionAdmission } from "../src/admission.ts";
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
  const record = decodeContractEvent((entries[1] as Uint8Array).subarray(51), 13);
  const checked = checkContractEvent(
    record,
    {
      electionRegistry: d.election_registry,
      trusteeRegistry: d.trustee_registry,
      groupRegistry: d.group_registry,
      board: d.board,
    },
    13,
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

  test("the admitted ballots count in the cell they name, delivered by version 5's fields with the step", () => {
    const r = admit(byId("board"));
    expect(r.candidates?.map((x) => [x.entry, x.tally?.cell])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
      [4, 0],
      [5, 0],
    ]);
    for (const x of r.candidates ?? []) {
      const record = decodeBallot(x.record, 5);
      expect(x.tally?.delivery).toBeUndefined();
      expect(x.tally?.deliveryV4).toEqual({
        cell: record.cell,
        nullifier: record.nullifier,
        vote: record.committed_vote,
        step: record.step,
      });
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

// The operator's admission before boarding (src/admission.ts) judges a
// rolling poll's ballots with the same judge as 5.1 to 5.4, given the chain
// from its own read of the registries (`rollingChain`), and never without
// it (P2-17 part 4d-2b; T-08, T-17).
describe("the operator's admission of a rolling poll's ballots", { timeout: 60_000 }, () => {
  const c = byId("board");
  const { entries } = election(c);
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error(`no panel ${c.panel}`);
  const panel = { threshold: Number(p.threshold), keys: p.keys.map(hex) };
  // A board entry's payload follows its 51-byte header; entry 0 is the transcript.
  const payloads = entries.slice(1).map((e) => e.subarray(51));

  test("without the chain no ballot is admitted", () => {
    expect(electionAdmission(hex(c.definition), panel, entries)).toEqual({
      ok: false,
      code: "unsupported-version",
    });
  });

  test("with it each ballot is admitted or rejected as the vectors' 5.1 to 5.4 do", () => {
    const admission = electionAdmission(hex(c.definition), panel, entries, undefined, chain);
    if (!admission.ok) throw new Error(admission.code);
    const results = admission.admitAll(payloads);
    // Repeats (5.7) and the window (5.5) are the caller's, so a ballot the
    // vectors reject only for those is admitted here.
    const rejected = new Map(
      c.ballots.rejected
        .filter((x) => x.code !== "repeat" && !x.code.startsWith("window-"))
        .map((x) => [x.entry, x]),
    );
    for (const [i, result] of results.entries()) {
      const want = rejected.get(i + 1);
      if (want === undefined) expect(result.ok, String(i + 1)).toBe(true);
      else
        expect(result, String(i + 1)).toEqual({
          ok: false,
          code: want.code,
          ...(want.decodeError !== undefined && { decodeError: want.decodeError }),
        });
    }
    // The five the vectors admit, and the two repeats (entries 23 and 24),
    // which only 5.7 rejects.
    expect(results.filter((r) => r.ok)).toHaveLength(c.ballots.admitted + 2);
  });

  test("a chain that doesn't give the definition's opening state is refused, never judged against", () => {
    // The first addition dropped: the opening tree is another (2.4 fails it).
    expect(() =>
      electionAdmission(hex(c.definition), panel, entries, undefined, {
        ...chain,
        events: events.slice(1),
      }),
    ).toThrow(RangeError);
  });

  test("an admitted ballot carries the step its record names, which 5.8's window is judged at", () => {
    const admission = electionAdmission(hex(c.definition), panel, entries, undefined, chain);
    if (!admission.ok) throw new Error(admission.code);
    const results = admission.admitAll(payloads);
    for (const [i, r] of results.entries()) {
      if (!r.ok) continue;
      expect(r.step, String(i + 1)).toBe(decodeBallot(payloads[i] as Uint8Array, 5).step);
    }
    // Entries 1 to 3 name step N0 or an earlier one and entries 4 and 5
    // later ones, as a registration at N0's boundary shows above.
    const steps = results.slice(0, 5).map((r) => (r.ok ? r.step : undefined));
    for (const s of steps.slice(0, 3)) expect(s).toBeLessThanOrEqual(2_966_400);
    for (const s of steps.slice(3)) expect(s).toBeGreaterThan(2_966_400);
  });
});

// A rolling path's copy, admitted by the operator or a trustee node outside
// the board's order (the view at `c_I`, P2-17 part 7c-3c-2c), is judged with
// the root its event carries, as 5.1 judges it on the board: a copy under
// another root than its step's is never one the verifier counts (T-25, T-54).
describe("the operator's admission of a rolling path's copies", { timeout: 60_000 }, () => {
  const c = byId("rolling-path");
  const { definition, entries } = election(c);
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error(`no panel ${c.panel}`);
  const panel = { threshold: Number(p.threshold), keys: p.keys.map(hex) };
  const d = definition.value;
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  // Every `RollingBallotSubmitted` of the board, by entry, with its record and supplied root.
  const copies = entries.flatMap((entry, at) => {
    if (at === 0) return [];
    try {
      const checked = checkContractEvent(
        decodeContractEvent(entry.subarray(51), 13),
        contracts,
        13,
      );
      return checked.ok && checked.event.event === "RollingBallotSubmitted"
        ? [{ at, record: checked.event.record, root: checked.event.root }]
        : [];
    } catch (e) {
      // An entry of another kind, or a record that doesn't decode.
      if (e instanceof DecodeError) return [];
      throw e;
    }
  });
  const admission = electionAdmission(hex(c.definition), panel, entries, undefined, chain);
  if (!admission.ok) throw new Error(admission.code);

  test("rejects a copy under another root than its step's (root-step-mismatch), as the vectors' 5.1 does", () => {
    const results = admission.admitAll(
      copies.map((x) => x.record),
      copies.map((x) => x.root),
    );
    const mismatched = copies.findIndex((x) => x.at === 2);
    expect(mismatched).not.toBe(-1);
    expect(results[mismatched]).toEqual({ ok: false, code: "root-step-mismatch" });
    // The other roots are their steps' (the re-vote's names a later step of
    // the same tree): each copy fares as the vectors judge it but for 5.5
    // and 5.7, the caller's.
    const rejected = new Map(
      c.ballots.rejected
        .filter((x) => x.code !== "repeat" && !x.code.startsWith("window-"))
        .map((x) => [x.entry, x.code]),
    );
    for (const [i, x] of copies.entries()) {
      const want = rejected.get(x.at);
      const got = results[i];
      if (want === undefined) expect(got?.ok, String(x.at)).toBe(true);
      else expect(got, String(x.at)).toMatchObject({ ok: false, code: want });
    }
    // `admit` judges one copy alike.
    for (const [i, x] of copies.entries())
      expect(admission.admit(x.record, x.root), String(x.at)).toEqual(results[i]);
  });

  test("without the supplied root the same copy passes 5.1 to 5.4: the root only ever rejects", () => {
    const mismatched = copies.find((x) => x.at === 2);
    if (mismatched === undefined) throw new Error("no copy at entry 2");
    expect(admission.admit(mismatched.record).ok).toBe(true);
    expect(admission.admitAll([mismatched.record]).map((r) => r.ok)).toEqual([true]);
  });

  test("refuses roots not one per payload, so no copy is judged under another's", () => {
    const records = copies.map((x) => x.record);
    expect(() => admission.admitAll(records, [copies[0]!.root])).toThrow(RangeError);
  });
});
