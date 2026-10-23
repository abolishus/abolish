import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  type CellAggregate,
  checkTally,
  type CommittedVote,
  decode,
  decodeTallyOpening,
  element,
  list,
  sortTallyOpenings,
  type TallyElection,
  tallyOpeningBoarding,
  type WholeOpeningVersion,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// The board operator's Boarding rule for a tally opening (docs/spec/tally.md,
// Opening record, Boarding), judged against docs/spec/vectors/
// tally-opening.json, which an independent Python implementation wrote
// (scripts/tally-opening-vectors.py): each election's openings come with
// that implementation's sorting, attribution and per-opening verdicts, from
// which each one's boarding verdict follows without the code under test.

interface Report {
  readonly at: number;
  readonly signer: number | null;
}

interface Election {
  readonly id: string;
  readonly cells: readonly (readonly string[])[];
  readonly openings: readonly string[];
  readonly result: {
    readonly cells: readonly {
      readonly passing: readonly Report[];
      readonly failing: readonly (Report & { readonly code: string; readonly option?: number })[];
    }[];
    readonly stray: readonly Report[];
    readonly rejected: readonly { readonly at: number; readonly error: string }[];
  };
}

const vectors = JSON.parse(readFileSync(new URL("tally-opening.json", SPEC_VECTORS), "utf8")) as {
  readonly election: {
    readonly definitionHash: string;
    readonly rules: TallyElection["rules"];
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
  };
  readonly elections: readonly Election[];
  readonly version2: { readonly elections: readonly Election[] };
};

// Every run verifies a signature per opening on its board, twice over.
const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 200);
const VSS = list(list(element, 16), 64);

const election: TallyElection = {
  definitionHash: hex(vectors.election.definitionHash),
  rules: vectors.election.rules,
  registered: vectors.election.registered.map((k) => ({
    index: k.index,
    signingKey: hex(k.signingKey),
  })),
};

// Each election's cells decoded and summed once: the properties judge
// hundreds of boards over the same few.
const ballots = new Map<Election, CommittedVote["vss"][][]>();
const ballotsOf = (e: Election) => {
  let cells = ballots.get(e);
  if (cells === undefined) {
    cells = e.cells.map((c) => c.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]));
    ballots.set(e, cells);
  }
  return cells;
};
const aggregates = new Map<Election, CellAggregate[]>();
const aggregatesOf = (e: Election) => {
  let summed = aggregates.get(e);
  if (summed === undefined) {
    summed = ballotsOf(e).map((cell) => aggregateCell(election.rules, cell));
    aggregates.set(e, summed);
  }
  return summed;
};
const byId = (id: string) => {
  const e = vectors.elections.find((x) => x.id === id);
  if (e === undefined) throw new Error(`no election ${id}`);
  return e;
};

/**
 * The verdict for opening `at` boarded after the ones before it, read off
 * the vector's own report: its decoding, sorting and per-opening code, its
 * attribution, and the earlier openings the vector attributes to the same
 * seat in the same cell.
 */
function expected(e: Election, at: number): unknown {
  const rejected = e.result.rejected.find((r) => r.at === at);
  if (rejected !== undefined) return { ok: false, code: "decode", error: rejected.error };
  if (e.result.stray.some((r) => r.at === at)) return { ok: false, code: "tally-stray" };
  for (const [cell, c] of e.result.cells.entries()) {
    const failing = c.failing.find((f) => f.at === at);
    if (failing !== undefined)
      return {
        ok: false,
        code: failing.code,
        ...(failing.option !== undefined && { option: failing.option }),
      };
    const passing = c.passing.find((p) => p.at === at);
    if (passing === undefined) continue;
    if (passing.signer === null) return { ok: false, code: "tally-unattributed" };
    const earlier = [...c.passing, ...c.failing]
      .filter((r) => r.at < at && r.signer === passing.signer)
      .sort((a, b) => a.at - b.at)[0];
    if (earlier === undefined) return { ok: true, cell, signer: passing.signer };
    // The signed message is the record between its 3-byte header and its
    // 64-byte signature (docs/spec/tally.md, Signature).
    const message = (i: number) => {
      const record = hex(e.openings[i] as string);
      return Buffer.from(record.subarray(3, record.length - 64));
    };
    const same = message(earlier.at).equals(message(at));
    return { ok: false, code: same ? "tally-repeat" : "tally-second", of: earlier.at };
  }
  throw new Error(`opening ${at} of ${e.id} isn't in its report`);
}

const judge = (
  e: Election,
  payload: Uint8Array,
  boarded: readonly Uint8Array[],
  pinned: WholeOpeningVersion = 1,
) => tallyOpeningBoarding(election, aggregatesOf(e), boarded, payload, pinned);

describe("the Boarding rule over tally-opening.json", () => {
  for (const [pinned, elections] of [
    [1, vectors.elections],
    [2, vectors.version2.elections],
  ] as const)
    test.each(elections)(`version ${pinned}: each opening of $id after the ones before it`, (e) => {
      const payloads = e.openings.map(hex);
      for (const [at, payload] of payloads.entries())
        expect(judge(e, payload, payloads.slice(0, at), pinned)).toEqual(expected(e, at));
    });

  test("boards a passing opening of a cell whose count is out of range: the opening alone is judged", () => {
    const e = byId("range");
    expect(judge(e, hex(e.openings[0] as string), [])).toEqual({ ok: true, cell: 0, signer: 1 });
  });
});

describe("one opening per seat and cell", () => {
  const signed = byId("signed");
  const seat1 = hex(signed.openings[0] as string);
  const seat2 = hex(signed.openings[1] as string);

  test("refuses the same opening again as a repeat, which anyone can replay", () => {
    expect(judge(signed, seat1, [seat1])).toEqual({ ok: false, code: "tally-repeat", of: 0 });
    expect(judge(signed, seat1, [seat2, seat1, seat1])).toEqual({
      ok: false,
      code: "tally-repeat",
      of: 1,
    });
  });

  test("refuses a passing opening as a second once the seat's failing one is on the board", () => {
    const failing = byId("failing-attributed");
    expect(failing.cells).toEqual(signed.cells);
    const first = hex(failing.openings[0] as string);
    expect(sortTallyOpenings(election, 2, [first], 1)[0]).toMatchObject({ cell: 0, signer: 1 });
    expect(judge(signed, seat1, [first])).toEqual({ ok: false, code: "tally-second", of: 0 });
  });

  test("is kept by attribution: an unattributed opening naming the seat never blocks it", () => {
    // The seat's own opening with its signature broken: it still names seat
    // 1 and opens the cell, but nothing attributes it.
    const forged = Uint8Array.from(seat1);
    forged[forged.length - 1] = (forged[forged.length - 1] as number) ^ 1;
    expect(decodeTallyOpening(forged, 1)).toMatchObject({ cell: 0, signer: 1 });
    expect(judge(signed, forged, [])).toEqual({ ok: false, code: "tally-unattributed" });
    expect(judge(signed, seat1, [forged])).toEqual({ ok: true, cell: 0, signer: 1 });
  });

  test("leaves another seat's opening of the cell, and the seat's of another cell, alone", () => {
    const duplicates = byId("duplicates");
    expect(duplicates.cells).toEqual(signed.cells);
    const seat2OfCell0 = hex(duplicates.openings[1] as string);
    expect(judge(signed, seat2OfCell0, [seat1])).toEqual({ ok: true, cell: 0, signer: 2 });
    expect(judge(signed, seat2, [seat2OfCell0, seat1])).toEqual({ ok: true, cell: 1, signer: 2 });
  });

  test("leaves the seat's stray opening of another definition alone, though it names the cell", () => {
    const stray = byId("stray");
    const other = hex(stray.openings[2] as string);
    expect(stray.result.stray).toContainEqual({ at: 2, signer: 2 });
    expect(decodeTallyOpening(other, 1)).toMatchObject({ cell: 0, signer: 2 });
    const seat2OfCell0 = hex(byId("duplicates").openings[1] as string);
    expect(judge(signed, seat2OfCell0, [other])).toEqual({ ok: true, cell: 0, signer: 2 });
  });

  test("passes over earlier entries that don't decode under the pin", () => {
    const unpinned = byId("unpinned-version");
    const [, rejected, , truncated] = unpinned.openings.map(hex);
    expect(judge(signed, seat1, [rejected as Uint8Array, truncated as Uint8Array])).toEqual({
      ok: true,
      cell: 0,
      signer: 1,
    });
  });

  test("decodes under the pinned version only", () => {
    expect(judge(signed, seat1, [], 2)).toEqual({
      ok: false,
      code: "decode",
      error: "profile-mismatch",
    });
  });
});

describe("the Boarding rule's properties", { timeout: 60_000 }, () => {
  test("boards exactly the openings that pass their cell's checks, attributed, the seat's first there", () => {
    // A model from the cell checks: checkTally over the board with the
    // opening appended lists it among its cell's passing openings, signed,
    // and no earlier entry is an attributed opening of the cell by its seat.
    const arb = fc.constantFrom(...vectors.elections).chain((e) =>
      fc.record({
        e: fc.constant(e),
        board: fc.array(fc.constantFrom(...e.openings), { maxLength: 6 }),
        payload: fc.constantFrom(...e.openings),
      }),
    );
    fc.assert(
      fc.property(arb, ({ e, board, payload }) => {
        const boarded = board.map(hex);
        const opening = hex(payload);
        const verdict = judge(e, opening, boarded);
        const all = [...boarded, opening];
        const at = boarded.length;
        const check = checkTally(election, ballotsOf(e), all, 1);
        const cell = check.cells.findIndex((c) => c.passing.some((p) => p.at === at));
        const passing = check.cells[cell]?.passing.find((p) => p.at === at);
        const sorted = sortTallyOpenings(election, e.cells.length, all, 1);
        const taken = sorted.some(
          (o) =>
            !("error" in o) &&
            o.at < at &&
            o.cell === cell &&
            o.signer !== null &&
            o.signer === passing?.signer,
        );
        const boards = passing !== undefined && passing.signer !== null && !taken;
        expect(verdict.ok).toBe(boards);
        if (verdict.ok) expect(verdict).toEqual({ ok: true, cell, signer: passing?.signer });
      }),
      { numRuns },
    );
  });

  test("refuses every single-byte change of an opening it boards", () => {
    const e = byId("signed");
    const openings = e.openings.map(hex);
    fc.assert(
      fc.property(
        fc.constantFrom(...openings),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (opening, i, flip) => {
          const changed = Uint8Array.from(opening);
          const at = i % changed.length;
          changed[at] = (changed[at] as number) ^ flip;
          expect(judge(e, changed, []).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  });
});

describe("the Boarding rule's arguments", () => {
  const e = byId("signed");
  const payload = hex(e.openings[0] as string);
  const aggregates = aggregatesOf(e);

  test("refuses a partition of no cells or of more than 256", () => {
    expect(() => tallyOpeningBoarding(election, [], [], payload, 1)).toThrow(RangeError);
    const many = Array.from({ length: 257 }, () => aggregates[0] as CellAggregate);
    expect(() => tallyOpeningBoarding(election, many, [], payload, 1)).toThrow(RangeError);
  });

  test("refuses an aggregate of another number of options", () => {
    const short = [(aggregates[0] as CellAggregate).slice(1), aggregates[1] as CellAggregate];
    expect(() => tallyOpeningBoarding(election, short, [], payload, 1)).toThrow(RangeError);
  });

  test("refuses a definition hash that isn't 32 bytes", () => {
    const bad = { ...election, definitionHash: new Uint8Array(31) };
    expect(() => tallyOpeningBoarding(bad, aggregates, [], payload, 1)).toThrow(RangeError);
  });
});
