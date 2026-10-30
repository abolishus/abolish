import { readFileSync } from "node:fs";
import {
  type AnchorClock,
  electionAuthorStubV7Hash,
  ELECTORATE_MODES,
  type RollingBallotChain,
  type RollingTierEvent,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { electionAdmission } from "../src/admission.ts";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { type Report, splitEntries } from "../src/index.ts";

// The author panel's run (2.5, 3.1, 3.2) and ballot admission (5.1 to 5.5,
// 5.7) under a rolling definition (definition version 7, `electorate_mode`
// 2; ballot version 5) beside an author panel: the author run is read as a
// fixed poll's is, over version 7's author stub, and each ballot's author
// half is judged against the author panel's own registered key set, approved
// on the board, never against the default panel's alone (docs/spec/verifier.md,
// Key ceremony, step 5, and Ballot admission; P2-17 part 4d-2b-2b-2b-2a;
// T-37, T-17). Fixtures: docs/spec/vectors/verifier-ballots-v5-author.json
// (packages/crypto/scripts/verifier-ballots-v5-author-vectors.py, an
// independent implementation that rebuilds every step root from the events
// and checks both runs, with snarkjs's verdict on every membership proof).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots?: NonNullable<Report["ballots"]>;
}

interface File {
  readonly clock: Readonly<Record<string, string>>;
  readonly panel: { readonly threshold: string; readonly keys: readonly string[] };
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

const file = JSON.parse(
  readFileSync(new URL("verifier-ballots-v5-author.json", VECTORS), "utf8"),
) as File;
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
const panel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };
// Board-entry version 7, which carries the author approvals.
const BOARD = 7;

/** A case's definition, both runs' checks and its board's entries. */
function election(c: Case) {
  const definition = decodeDefinition(hex(c.definition));
  const { stubHash } = readDefinition(definition);
  const { entries } = splitEntries(hex(c.board));
  const ceremony = ceremonyChecks(
    definition.value,
    stubHash,
    panel,
    authorRunOf(definition),
    entries,
    BOARD,
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

function admit(c: Case) {
  const { definition, entries, ceremony } = election(c);
  return ballotChecks(
    definition,
    ceremony.registered,
    ceremony.authorRegistered,
    entries,
    BOARD,
    clock,
    undefined,
    chain,
  );
}

test("every definition is a rolling version 7 with an author panel, run over version 7's author stub", () => {
  for (const c of file.cases) {
    const { definition } = election(c);
    if (definition.version !== 7) throw new Error(`${c.id}: not version 7`);
    expect(definition.value.electorate_mode, c.id).toBe(ELECTORATE_MODES.rolling);
    expect(definition.value.author_keys.length, c.id).toBe(3);
    expect(authorRunOf(definition)?.stubHash, c.id).toEqual(
      electionAuthorStubV7Hash(definition.value),
    );
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

describe("the author panel's own run decides its seats", { timeout: 60_000 }, () => {
  test("its approved key set is the run's registered seats, and nothing is registered without the approvals", () => {
    expect(election(byId("author-mixed")).ceremony.authorRegistered?.map((k) => k.index)).toEqual([
      1, 2,
    ]);
    expect(
      election(byId("author-every-seat")).ceremony.authorRegistered?.map((k) => k.index),
    ).toEqual([1, 2, 3]);
    for (const id of ["approvals-missing", "approvals-short", "author-other-stub"]) {
      const { ceremony } = election(byId(id));
      expect(ceremony.registered, id).toBeUndefined();
      expect(ceremony.authorRegistered, id).toBeUndefined();
    }
  });

  test("read without the author run, as before, no ballot is judged over the default panel alone", () => {
    // The default run alone registers its seats, but a rolling ballot's
    // author half has no key set to be judged against: admission stops (T-37).
    const c = byId("author-mixed");
    const definition = decodeDefinition(hex(c.definition));
    const { entries } = splitEntries(hex(c.board));
    const ceremony = ceremonyChecks(
      definition.value,
      readDefinition(definition).stubHash,
      panel,
      undefined,
      entries,
      BOARD,
    );
    expect(ceremony.authorRegistered).toBeUndefined();
    const r = ballotChecks(
      definition,
      ceremony.registered,
      ceremony.authorRegistered,
      entries,
      BOARD,
      clock,
      undefined,
      chain,
    );
    expect(r.rows.get("5.1")).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.report).toBeUndefined();
  });

  test("an author share hash at a seat the author run didn't register is rejected, at one it did admitted", () => {
    const mixed = byId("author-mixed").ballots;
    expect(mixed?.rejected.find((x) => x.entry === 6)).toEqual({
      entry: 6,
      code: "share-hash-unqualified",
      panel: 2,
      seat: 3,
    });
    expect(byId("author-every-seat").ballots).toEqual({ admitted: 1, rejected: [], repeats: [] });
  });
});

// The operator's admission before boarding (src/admission.ts) reads the
// author run as 3.1 and 3.2 do, so it judges a rolling poll's author halves
// with the same judge as 5.1 to 5.4 (T-08, T-17, T-37).
describe(
  "the operator's admission of a rolling poll beside an author panel",
  { timeout: 60_000 },
  () => {
    test("each ballot is admitted or rejected as the vectors' 5.1 to 5.4 do", () => {
      const c = byId("author-mixed");
      const { entries } = election(c);
      // A board entry's payload follows its 51-byte header; entries 0 to 2
      // are the transcripts and the approvals.
      const payloads = entries.slice(3).map((e) => e.subarray(51));
      const admission = electionAdmission(hex(c.definition), panel, entries, undefined, chain);
      if (!admission.ok) throw new Error(admission.code);
      const results = admission.admitAll(payloads);
      // Repeats (5.7) are the caller's, so the repeat is admitted here.
      const rejected = new Map(
        (c.ballots?.rejected ?? []).filter((x) => x.code !== "repeat").map((x) => [x.entry, x]),
      );
      for (const [i, result] of results.entries()) {
        const want = rejected.get(i + 3);
        if (want === undefined) expect(result.ok, String(i + 3)).toBe(true);
        else expect(result, String(i + 3)).toEqual({ ok: false, code: want.code });
      }
      expect(results.filter((r) => r.ok)).toHaveLength((c.ballots?.admitted ?? 0) + 1);
    });

    test("without the author approvals the election isn't admitted at all", () => {
      for (const id of ["approvals-missing", "approvals-short", "author-other-stub"]) {
        const c = byId(id);
        const admission = electionAdmission(
          hex(c.definition),
          panel,
          splitEntries(hex(c.board)).entries,
          undefined,
          chain,
        );
        expect(admission.ok, id).toBe(false);
      }
    });
  },
);
