import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  type BallotHalves,
  checkPanelDestruction,
  checkPartialTally,
  decode,
  DecodeError,
  decodeElectionDefinitionV6,
  decodePanelDestructionStatement,
  decodePanelSummedShareMessage,
  decodePartialOpening,
  element,
  encodePartialOpening,
  GROUP_ORDER,
  identityKey,
  list,
  openCell,
  openPanelSummedShares,
  openPartialCell,
  panelDestructionStatementMessage,
  panelTallyRules,
  type PartialCellCheck,
  type PartialOpening,
  partialOpeningMessage,
  type PartialTallyCheck,
  type PartialTallyElection,
  type Share,
  signPanelDestructionStatement,
  signPartialOpening,
  sortPartialOpenings,
  type TallyRules,
  tallyRules,
} from "../src/index.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import { sealSummedSharesWith } from "../src/summed-share.ts";
import { electionDefinitionV6Hash } from "../src/protocol.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/panel-tally.json comes from an independent Python
// implementation of docs/spec/tally.md, Author panel
// (scripts/panel-tally-vectors.py, with its own decoders, sums, combination,
// KEM, AEAD, P-256 ECDSA and per-cell checks over ballot-v4-vectors.py's two
// sharings), so these bytes and verdicts never come from the code under test.

type Json = { readonly v: string; readonly r: string };
type HalvesJson = readonly { readonly vss: string; readonly authorVss: string }[];

interface PanelJson {
  readonly threshold: number;
  readonly panelSize: number;
  readonly registered: readonly {
    readonly index: number;
    readonly signingKey: string;
    readonly kem: { readonly seed: string; readonly x: string; readonly publicKey: string };
  }[];
  readonly seats: readonly {
    readonly index: number;
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly kem: { readonly seed: string; readonly x: string; readonly publicKey: string };
  }[];
}

interface Vectors {
  readonly format: string;
  readonly tags: Record<string, string>;
  readonly versions: { readonly tallyOpening: number; readonly summedShare: number };
  readonly election: {
    readonly definition: string;
    readonly definitionHash: string;
    readonly ceremonyTranscriptHash: string;
    readonly authorTranscriptHash: string;
    readonly optionCount: number;
    readonly default: PanelJson;
    readonly author: PanelJson;
    readonly cells: readonly HalvesJson[];
    readonly counts: readonly (readonly string[])[];
    readonly partialOpenings: readonly {
      readonly default: readonly Json[];
      readonly author: readonly Json[];
    }[];
  };
  readonly combinations: readonly {
    readonly id: string;
    readonly cell: number;
    readonly panel: 1 | 2;
    readonly summed: Record<string, readonly Json[]>;
    readonly combined?: readonly number[];
    readonly opening?: readonly Json[];
    readonly result?: { readonly ok: false; readonly code: string; readonly excluded: number[] };
  }[];
  readonly singleAuthorSeat: {
    readonly definition: string;
    readonly cell: HalvesJson;
    readonly summed: readonly Json[];
    readonly opening: readonly Json[];
    readonly counts: readonly string[];
  };
  readonly openings: readonly {
    readonly id: string;
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly definitionHash: string;
    readonly cell: number;
    readonly panel: number;
    readonly aggregateHash: string;
    readonly signer: number;
    readonly opening: readonly Json[];
    readonly message: string;
    readonly signature: string;
    readonly encoding: string;
  }[];
  readonly decodeErrors: readonly DecodeVector[];
  readonly tallies: readonly {
    readonly id: string;
    readonly cells: readonly HalvesJson[];
    readonly authorDeadline: number;
    readonly entries: readonly { readonly segment: number; readonly payload: string }[];
    readonly result: unknown;
  }[];
  readonly summedShares: {
    readonly messages: readonly {
      readonly id: string;
      readonly cell: number;
      readonly panel: 1 | 2;
      readonly sender: number;
      readonly recipient: number;
      readonly summed: readonly Json[];
      readonly mu: string;
      readonly e: string;
      readonly encoding: string;
    }[];
    readonly decodeErrors: readonly DecodeVector[];
    readonly receiving: readonly {
      readonly id: string;
      readonly panel: 1 | 2;
      readonly recipient: number;
      readonly encoding: string;
      readonly result: string;
    }[];
  };
  readonly destruction: {
    readonly statements: readonly {
      readonly id: string;
      readonly panel: 1 | 2;
      readonly signer: number;
      readonly signingSecret: string;
      readonly message: string;
      readonly encoding: string;
    }[];
    readonly decodeErrors: readonly DecodeVector[];
    readonly reports: readonly {
      readonly id: string;
      readonly entries: readonly { readonly segment: number; readonly payload: string }[];
      readonly firstPassing: readonly {
        readonly default: number | null;
        readonly author: number | null;
      }[];
      readonly windowSegment: number;
      readonly result: unknown;
    }[];
  };
}

interface DecodeVector {
  readonly id: string;
  readonly encoding: string;
  readonly error: string;
  readonly offset: number;
}

const vectors = JSON.parse(
  readFileSync(new URL("panel-tally.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const VSS = list(list(element, 16), 64);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const shares = (s: readonly Json[]): Share[] =>
  s.map(({ v, r }) => ({ v: BigInt(v), r: BigInt(r) }));
const sharesJson = (s: readonly Share[]) =>
  s.map(({ v, r }) => ({ v: v.toString(), r: r.toString() }));

const definition = {
  version: 6 as const,
  value: decodeElectionDefinitionV6(hex(vectors.election.definition)),
};
const defaultRules = panelTallyRules(definition, 1);
const authorRules = panelTallyRules(definition, 2);
const rulesOf = (panel: 1 | 2) => (panel === 1 ? defaultRules : authorRules);

const halves = (cell: HalvesJson): BallotHalves[] =>
  cell.map((b) => ({
    vss: decode(VSS, hex(b.vss)) as BallotHalves["vss"],
    author_vss: decode(VSS, hex(b.authorVss)) as BallotHalves["author_vss"],
  }));
const halfOf = (cell: readonly BallotHalves[], panel: 1 | 2) =>
  cell.map((b) => (panel === 1 ? b.vss : b.author_vss));

const registeredOf = (p: PanelJson) =>
  p.registered.map((k) => ({ index: k.index, signingKey: hex(k.signingKey) }));
const election: PartialTallyElection = {
  definitionHash: hex(vectors.election.definitionHash),
  defaultRules,
  authorRules,
  registered: {
    default: registeredOf(vectors.election.default),
    author: registeredOf(vectors.election.author),
  },
};

/** The check's output in the vector file's shape: counts as decimal strings. */
function asVector(r: PartialTallyCheck): unknown {
  const cell = (c: PartialCellCheck) =>
    c.ok ? { ...c, counts: c.counts.map((x) => x.toString()) } : { ...c };
  return { ...r, cells: r.cells.map(cell) };
}

function decodeError(f: () => unknown): DecodeError {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e;
    throw e;
  }
  throw new Error("decoded");
}

describe("panel-tally.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-panel-tally-vectors/1");
    expect(vectors.tags["partialOpening"]).toBe("abolish/v1/sig/partial-opening");
    expect(vectors.versions).toEqual({ tallyOpening: 3, summedShare: 2, destruction: 2 });
    expect(toHex(electionDefinitionV6Hash(definition.value))).toBe(vectors.election.definitionHash);
  });

  test("each panel's rules are its own threshold and size over the definition's options", () => {
    expect(defaultRules).toMatchObject({ optionCount: 3, threshold: 2, panelSize: 3, panel: 1 });
    expect(authorRules).toMatchObject({ optionCount: 3, threshold: 2, panelSize: 3, panel: 2 });
  });

  test("each cell's two partial openings sum to its counts mod ℓ", () => {
    vectors.election.partialOpenings.forEach((p, i) => {
      const author = shares(p.author);
      const counts = shares(p.default).map((d, j) => (d.v + (author[j] as Share).v) % GROUP_ORDER);
      expect(counts.map(String)).toEqual(vectors.election.counts[i]);
    });
  });

  test.each(vectors.combinations)("combination $id", (v) => {
    const cell = halves(vectors.election.cells[v.cell] as HalvesJson);
    const summed = new Map(Object.entries(v.summed).map(([i, s]) => [Number(i), shares(s)]));
    const got = openPartialCell(rulesOf(v.panel), halfOf(cell, v.panel), summed);
    if (v.result !== undefined) {
      expect(got).toEqual(v.result);
      return;
    }
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.combined).toEqual(v.combined);
    expect(sharesJson(got.opening)).toEqual(v.opening);
  });

  test("a 1-of-1 author panel's one summed share list is its partial opening", () => {
    const v = vectors.singleAuthorSeat;
    const single = { version: 6 as const, value: decodeElectionDefinitionV6(hex(v.definition)) };
    const rules = panelTallyRules(single, 2);
    expect(rules.threshold).toBe(1);
    const got = openPartialCell(rules, halfOf(halves(v.cell), 2), new Map([[1, shares(v.summed)]]));
    expect(got.ok && sharesJson(got.opening)).toEqual(v.opening);
  });

  test.each(vectors.openings)("$id is re-made byte for byte", (v) => {
    const secret = hex(v.signingSecret);
    expect(toHex(identityKey(secret))).toBe(v.signingKey);
    const statement = {
      definition_hash: hex(v.definitionHash),
      cell: v.cell,
      panel: v.panel,
      aggregate_hash: hex(v.aggregateHash),
      signer: v.signer,
      opening: shares(v.opening),
    };
    expect(toHex(partialOpeningMessage(statement))).toBe(v.message);
    const signed = signPartialOpening(secret, statement);
    expect(toHex(signed.signature)).toBe(v.signature);
    expect(toHex(encodePartialOpening(signed))).toBe(v.encoding);
    expect(decodePartialOpening(hex(v.encoding), 3)).toEqual(signed);
  });

  test.each(vectors.decodeErrors)("opening $id is rejected with $error at $offset", (v) => {
    const e = decodeError(() => decodePartialOpening(hex(v.encoding), 3));
    expect([e.code, e.offset]).toEqual([v.error, v.offset]);
  });

  test.each(vectors.tallies)("tally $id", (v) => {
    const cells = v.cells.map(halves);
    const entries = v.entries.map((x) => ({ segment: x.segment, payload: hex(x.payload) }));
    expect(asVector(checkPartialTally(election, cells, entries, v.authorDeadline))).toEqual(
      v.result,
    );
  });
});

describe("panel-tally.json: summed-share messages, version 2", () => {
  const panelJson = (panel: 1 | 2) =>
    panel === 1 ? vectors.election.default : vectors.election.author;
  const transcript = (panel: 1 | 2) =>
    hex(
      panel === 1 ? vectors.election.ceremonyTranscriptHash : vectors.election.authorTranscriptHash,
    );
  const registered = (panel: 1 | 2) =>
    checkedKeySetForTests(
      panelJson(panel).registered.map((k) => ({
        index: k.index,
        signingKey: hex(k.signingKey),
        kemKey: kemKeyPairWith(hex(k.kem.seed), BigInt(k.kem.x)).publicKey,
      })),
      transcript(panel),
    );
  const sets = { 1: registered(1), 2: registered(2) };
  const aggregates = (panel: 1 | 2) =>
    vectors.election.cells.map((c) => aggregateCell(rulesOf(panel), halfOf(halves(c), panel)));
  const kem = (panel: 1 | 2, i: number) => {
    const s = panelJson(panel).seats[i - 1];
    if (s === undefined) throw new Error(`no seat ${i}`);
    return { secret: hex(s.signingSecret), kem: kemKeyPairWith(hex(s.kem.seed), BigInt(s.kem.x)) };
  };

  test.each(vectors.summedShares.messages)("$id is re-made byte for byte and opens", (v) => {
    const aggregate = aggregates(v.panel)[v.cell];
    if (aggregate === undefined) throw new Error("no cell");
    const sealed = sealSummedSharesWith(
      {
        definitionHash: hex(vectors.election.definitionHash),
        panel: v.panel,
        ceremonyTranscriptHash: transcript(v.panel),
        rules: rulesOf(v.panel),
        cells: vectors.election.cells.length,
        cell: v.cell,
        aggregate,
      },
      sets[v.panel],
      { index: v.sender, signingSecret: kem(v.panel, v.sender).secret },
      v.recipient,
      shares(v.summed),
      hex(v.mu),
      BigInt(v.e),
    );
    expect(toHex(sealed)).toBe(v.encoding);
    const got = openPanelSummedShares(
      { definition, panel: v.panel, aggregates: aggregates(v.panel), registered: sets[v.panel] },
      { index: v.recipient, secretKey: kem(v.panel, v.recipient).kem.secretKey },
      sealed,
    );
    expect(got).toEqual({ ok: true, cell: v.cell, sender: v.sender, summed: shares(v.summed) });
  });

  test.each(vectors.summedShares.decodeErrors)("$id is rejected with $error at $offset", (v) => {
    const e = decodeError(() => decodePanelSummedShareMessage(hex(v.encoding), 2));
    expect([e.code, e.offset]).toEqual([v.error, v.offset]);
  });

  test.each(vectors.summedShares.receiving)("receiving $id: $result", (v) => {
    const got = openPanelSummedShares(
      { definition, panel: v.panel, aggregates: aggregates(v.panel), registered: sets[v.panel] },
      { index: v.recipient, secretKey: kem(v.panel, v.recipient).kem.secretKey },
      hex(v.encoding),
    );
    expect(got.ok ? "ok" : got.code).toBe(v.result);
  });

  test("a version-2 message needs the panel's own transcript's key set", () => {
    // The author panel's key set checked for the default transcript: a set
    // from another run could put any key under an author seat (T-37).
    const wrong = checkedKeySetForTests([...sets[2]], transcript(1));
    const v = vectors.summedShares.receiving[0];
    if (v === undefined) throw new Error("no case");
    expect(() =>
      openPanelSummedShares(
        { definition, panel: 2, aggregates: aggregates(2), registered: wrong },
        { index: v.recipient, secretKey: kem(2, v.recipient).kem.secretKey },
        hex(v.encoding),
      ),
    ).toThrow(TypeError);
  });
});

describe("panel-tally.json: destruction statements, version 2", () => {
  const d = vectors.destruction;

  test.each(d.statements)("$id is re-made byte for byte", (v) => {
    const fields = {
      definition_hash: hex(vectors.election.definitionHash),
      panel: v.panel,
      signer: v.signer,
    };
    expect(toHex(panelDestructionStatementMessage(fields))).toBe(v.message);
    const signed = signPanelDestructionStatement(hex(v.signingSecret), fields);
    expect(decodePanelDestructionStatement(hex(v.encoding), 2)).toEqual(signed);
  });

  test.each(d.decodeErrors)("$id is rejected with $error at $offset", (v) => {
    const e = decodeError(() => decodePanelDestructionStatement(hex(v.encoding), 2));
    expect([e.code, e.offset]).toEqual([v.error, v.offset]);
  });

  test.each(d.reports)("report $id", (v) => {
    const got = checkPanelDestruction(
      { definitionHash: election.definitionHash, registered: election.registered },
      v.entries.map((x) => ({ segment: x.segment, payload: hex(x.payload) })),
      { firstPassing: v.firstPassing, windowSegment: v.windowSegment },
      2,
    );
    expect(got).toEqual(v.result);
  });
});

describe("the per-panel tally's guards", () => {
  test("tallyRules refuses version 6 with an author panel: its halves are tallied per panel", () => {
    expect(() => tallyRules(definition)).toThrow(RangeError);
  });

  test("panelTallyRules refuses a definition without an author panel", () => {
    const value = {
      ...definition.value,
      author_threshold: 0,
      author_keys: [],
      author_transcript_hash: new Uint8Array(32),
    };
    expect(() => panelTallyRules({ version: 6, value }, 1)).toThrow(RangeError);
  });

  test("only an author panel's rules allow k = 1", () => {
    const one: TallyRules = { ...defaultRules, threshold: 1 };
    expect(() => aggregateCell(one, [])).toThrow(RangeError);
    expect(() => aggregateCell({ ...one, panel: 2 }, [])).not.toThrow();
    const { panel: _, ...noPanel } = one;
    expect(() => aggregateCell(noPanel, [])).toThrow(RangeError);
  });

  test("a panel's half is never opened with the version-1 range checks, nor a whole cell as a half", () => {
    expect(() => openCell(defaultRules, [], new Map())).toThrow(RangeError);
    const { panel: _, ...whole } = defaultRules;
    expect(() => openPartialCell(whole, [], new Map())).toThrow(RangeError);
  });

  test("a signed partial opening is attributed only under the panel it names", () => {
    const [first] = vectors.openings;
    if (first === undefined) throw new Error("no opening");
    const secret = hex(first.signingSecret);
    const key = identityKey(secret);
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2),
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 0, max: 3 }),
        (panel, signer, cell) => {
          const o = signPartialOpening(secret, {
            definition_hash: election.definitionHash,
            cell,
            panel,
            aggregate_hash: hex(first.aggregateHash),
            signer,
            opening: shares(first.opening),
          });
          const seat = [{ index: signer, signingKey: key }];
          const sorted = (registered: PartialTallyElection["registered"]) =>
            sortPartialOpenings({ ...election, registered }, 4, [
              { segment: 0, payload: encodePartialOpening(o) },
            ])[0];
          const own = panel === 1 ? { default: seat, author: [] } : { default: [], author: seat };
          const other = panel === 1 ? { default: [], author: seat } : { default: seat, author: [] };
          expect(sorted(own)).toMatchObject({ signer, cell });
          expect(sorted(other)).toMatchObject({ signer: null, cell });
        },
      ),
      { numRuns },
    );
  });

  test("partial openings round-trip through the codec for any fields", () => {
    const scalar = fc.bigInt({ min: 0n, max: 2n ** 252n });
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.integer({ min: 0, max: 255 }),
        fc.array(fc.record({ v: scalar, r: scalar }), { maxLength: 8 }),
        (definition_hash, cell, panel, aggregate_hash, signer, opening) => {
          const [first] = vectors.openings;
          if (first === undefined) throw new Error("no opening");
          const o: PartialOpening = {
            definition_hash,
            cell,
            panel,
            aggregate_hash,
            signer,
            opening,
            signature: hex(first.signature),
          };
          const b = encodePartialOpening(o);
          expect(decodePartialOpening(b, 3)).toEqual(o);
          expect(encodePartialOpening(decodePartialOpening(b, 3))).toEqual(b);
        },
      ),
      { numRuns },
    );
  });
});
