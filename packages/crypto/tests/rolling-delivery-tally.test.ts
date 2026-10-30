import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ballotHashV4,
  checkDeliveryV2,
  decodeBallot,
  decodeElectionDefinitionV7,
  deliveryBallotHashV2,
  type DeliveryBallotV4,
  POLL_CLASSES,
  tallyRules,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// What 5.9 and the counted set read of a rolling poll (docs/spec/verifier.md,
// Counted set and tally; delivery.md, Versions; tally.md, Rolling tiers):
// ballot version 5's hash, which binds the step, for its version-2 delivery
// records, and each rolling tier's rules. The hashes are
// docs/spec/vectors/ballot-v5-records.json's, from an independent Python
// implementation (scripts/ballot-v5-records-vectors.py).

interface Vectors {
  readonly elections: Readonly<
    Record<
      string,
      {
        readonly definition: string;
        readonly threshold: string;
        readonly panelSize: string;
        readonly questions: readonly {
          readonly optionCount: number;
          readonly minSelections: number;
          readonly maxSelections: number;
        }[];
      }
    >
  >;
  readonly ballots: readonly {
    readonly id: string;
    readonly election: string;
    readonly encoding: string;
    readonly ballotHash: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("ballot-v5-records.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const definitionOf = (id: string) => {
  const e = vectors.elections[id];
  if (e === undefined) throw new Error(`no election ${id}`);
  return { version: 7 as const, value: decodeElectionDefinitionV7(hex(e.definition)) };
};

/** Every vector ballot that decodes as version 5, with its delivery fields. */
const decoded = vectors.ballots.flatMap((b) => {
  try {
    const r = decodeBallot(hex(b.encoding), 5);
    const fields: DeliveryBallotV4 = {
      cell: r.cell,
      nullifier: r.nullifier,
      vote: r.committed_vote,
      step: r.step,
    };
    return [{ id: b.id, definitionHash: r.definition_hash, fields, want: b.ballotHash }];
  } catch {
    return [];
  }
});

describe("deliveryBallotHashV2", () => {
  test("a version-5 ballot's is its ballot hash, the step bound (T-38)", () => {
    expect(decoded.length).toBeGreaterThan(10);
    for (const b of decoded)
      expect(
        Buffer.from(deliveryBallotHashV2(b.definitionHash, b.fields)).toString("hex"),
        b.id,
      ).toBe(b.want);
  });

  test("another step, or the same fields without one, is another hash", () => {
    const b = decoded[0];
    if (b === undefined) throw new Error("no ballot");
    const own = deliveryBallotHashV2(b.definitionHash, b.fields);
    const step = b.fields.step ?? 0;
    const moved = deliveryBallotHashV2(b.definitionHash, { ...b.fields, step: step + 1 });
    const { step: _, ...v4 } = b.fields;
    const asV4 = deliveryBallotHashV2(b.definitionHash, v4);
    expect(moved).not.toEqual(own);
    expect(asV4).not.toEqual(own);
    expect(asV4).toEqual(
      ballotHashV4(
        { definitionHash: b.definitionHash, cell: v4.cell, nullifier: v4.nullifier },
        v4.vote,
      ),
    );
  });

  test("the delivery check refuses ballots of versions 4 and 5 together", () => {
    const [a, b] = decoded.filter((x) => x.fields.vote.author_vss.length === 0);
    if (a === undefined || b === undefined) throw new Error("no default-only ballots");
    const { step: _, ...v4 } = b.fields;
    const call = (ballots: readonly DeliveryBallotV4[]) =>
      checkDeliveryV2(
        {
          definitionHash: a.definitionHash,
          panelSize: a.fields.vote.share_hashes.length,
          authorPanelSize: 0,
          registered: { default: [], author: [] },
          segments: { delivery: 10n, complaint: 11n },
          deadlines: { delivery: 100n, complaint: 200n },
        },
        ballots,
        [],
      );
    expect(() => call([a.fields, v4])).toThrow(/versions 4 and 5/);
    expect(call([a.fields]).ballots[0]?.ballotHash).toEqual(
      deliveryBallotHashV2(a.definitionHash, a.fields),
    );
  });
});

describe("tallyRules under a rolling definition", () => {
  test("without an author panel, the definition's own rules (tally.md, Rolling tiers)", () => {
    const e = vectors.elections["default-only"];
    if (e === undefined) throw new Error("no election");
    const rules = tallyRules(definitionOf("default-only"));
    expect(rules.threshold).toBe(Number(e.threshold));
    expect(rules.panelSize).toBe(Number(e.panelSize));
    expect(rules.questions).toEqual(
      e.questions.map(({ optionCount, minSelections, maxSelections }) => ({
        optionCount,
        minSelections,
        maxSelections,
      })),
    );
    expect(rules.optionCount).toBe(e.questions.reduce((n, q) => n + q.optionCount, 0));
  });

  test("beside an author panel it is refused: its halves are tallied per panel (T-37)", () => {
    expect(() => tallyRules(definitionOf("rolling"))).toThrow(/per panel/);
  });

  test("a rolling definition that isn't well-formed is refused (T-28)", () => {
    const d = definitionOf("default-only");
    // A civic referendum held rolling fails `rolling-class`.
    const civic = { ...d, value: { ...d.value, poll_class: POLL_CLASSES.civicReferendum } };
    expect(() => tallyRules(civic)).toThrow(/well-formed/);
  });
});
