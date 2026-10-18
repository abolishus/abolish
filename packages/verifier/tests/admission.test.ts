import { readFileSync } from "node:fs";
import fc from "fast-check";
import {
  decodeBallot,
  decodeBoardEntry,
  decodeElectionDefinition,
  membershipMessage,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  electionAdmission,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// `electionAdmission`, the one-ballot admission a board operator runs before
// boarding, against the verifier's own report over the same fixtures
// (docs/spec/vectors/verifier-ballots.json, whose expected rows come from an
// independent implementation): every ballot it admits is one 5.1 to 5.4
// admit, and every one it rejects is rejected there under the same code, so
// the operator boards exactly what the verifier admits by those rows.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
}

const file = read("verifier-ballots.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: string[] }>
  >;
  readonly cases: readonly Case[];
};
const l1File = read("l1-anchor.json") as {
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

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const panelOf = (name: string) => {
  const p = file.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: Number(p.threshold), keys: p.keys.map(hex) };
};

const bundleOf = (c: Case) =>
  parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_CEREMONY,
      definition: c.definition,
      clock: file.clock,
      l1: {
        firstSegment: closed.firstSegment,
        header: closed.block.header,
        nodes: closed.nodes,
        checkpoints: closed.checkpoints,
      },
      panel: file.panels[c.panel],
    }),
    hex(c.board),
  );

const BALLOT = 0x0002;
// These fixtures' definitions pin board-entry version 5, which every profile needs.
const payloadOf = (entry: Uint8Array) => decodeBoardEntry(entry, 5).payload;

/** Each ballot entry's verdict by `admit`, keyed by its position in the copy. */
function admissions(c: Case) {
  const entries = bundleOf(c).entries;
  const admission = electionAdmission(hex(c.definition), panelOf(c.panel), entries);
  if (!admission.ok) throw new Error(`election refused: ${admission.code}`);
  const verdicts = new Map<number, string>();
  for (const [at, entry] of entries.entries()) {
    const payload = payloadOf(entry);
    if ((((payload[0] as number) << 8) | (payload[1] as number)) !== BALLOT) continue;
    const r = admission.admit(payload);
    verdicts.set(at, r.ok ? "admitted" : r.code);
  }
  return verdicts;
}

// What `admit` can't decide from one ballot: its entry's window (5.5) and
// whether an earlier copy stands (5.7). An entry rejected for either passed
// 5.1 to 5.4.
const LATER = new Set([
  "window-before-open",
  "window-after-close",
  "window-boarded-late",
  "repeat",
]);

/** The same, from the verifier's report over the whole copy, by 5.1 to 5.4. */
function reported(r: Report, ballots: ReadonlyMap<number, string>) {
  const rejected = new Map(
    (r.ballots?.rejected ?? [])
      .filter((x) => !LATER.has(x.code))
      .map((x) => [x.entry, x.code] as const),
  );
  return new Map([...ballots.keys()].map((at) => [at, rejected.get(at) ?? "admitted"] as const));
}

describe("admits exactly the ballots the verifier's 5.1 to 5.4 admit", () => {
  // Each case verifies its whole bundle, membership proofs included, which
  // can pass the default timeout on a loaded runner.
  for (const id of ["mixed", "admitted", "repeats", "repeat-of-rejected", "unqualified-first"])
    test(id, { timeout: 60_000 }, () => {
      const c = byId(id);
      const ours = admissions(c);
      const report = verifyBundle(bundleOf(c));
      expect(ours).toEqual(reported(report, ours));
    });

  test("the fixtures exercise admission and several rejection codes", () => {
    const codes = new Set(
      ["mixed", "unqualified-first"].flatMap((id) => [...admissions(byId(id)).values()]),
    );
    expect(codes).toContain("admitted");
    for (const code of ["ballot-stray", "ballot-tier", "validity-shape", "membership-proof"])
      expect(codes).toContain(code);
  });

  test("a ballot's verdict doesn't depend on the other entries given", { timeout: 60_000 }, () => {
    // Only the transcript is needed: admission is per ballot (T-52).
    const c = byId("mixed");
    const entries = bundleOf(c).entries;
    const full = admissions(c);
    const alone = electionAdmission(hex(c.definition), panelOf(c.panel), entries.slice(0, 1));
    if (!alone.ok) throw new Error(alone.code);
    for (const [at, verdict] of full) {
      const r = alone.admit(payloadOf(entries[at] as Uint8Array));
      expect(r.ok ? "admitted" : r.code).toBe(verdict);
    }
  });
});

describe("admitAll gives each payload the verdict admit gives, its membership proofs batched", () => {
  for (const id of ["mixed", "admitted", "repeats", "repeat-of-rejected", "unqualified-first"])
    test(`${id}: the verifier's 5.1 to 5.4 verdicts`, { timeout: 60_000 }, () => {
      const c = byId(id);
      const entries = bundleOf(c).entries;
      const admission = electionAdmission(hex(c.definition), panelOf(c.panel), entries);
      if (!admission.ok) throw new Error(admission.code);
      const ats = [...entries.keys()].filter((at) => {
        const payload = payloadOf(entries[at] as Uint8Array);
        return (((payload[0] as number) << 8) | (payload[1] as number)) === BALLOT;
      });
      const all = admission.admitAll(ats.map((at) => payloadOf(entries[at] as Uint8Array)));
      const ours = new Map(
        ats.map((at, i) => {
          const r = all[i] as (typeof all)[number];
          return [at, r.ok ? "admitted" : r.code] as const;
        }),
      );
      expect(ours).toEqual(reported(verifyBundle(bundleOf(c)), ours));
    });

  test("any multiset of payloads, ballots or not, in any order and past a batch of 64", () => {
    const c = byId("mixed");
    const entries = bundleOf(c).entries;
    const admission = electionAdmission(hex(c.definition), panelOf(c.panel), entries);
    if (!admission.ok) throw new Error(admission.code);
    const payloads = [...entries.map((e) => payloadOf(e)), new Uint8Array(), Uint8Array.of(0, 2)];
    const alone = payloads.map((p) => admission.admit(p));
    // Each run checks up to 80 Groth16 proofs, so the runs are capped.
    fc.assert(
      fc.property(
        fc.array(fc.nat(payloads.length - 1), { maxLength: 80, size: "max" }),
        (picks) => {
          expect(admission.admitAll(picks.map((i) => payloads[i] as Uint8Array))).toEqual(
            picks.map((i) => alone[i]),
          );
        },
      ),
      { numRuns: Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 3) },
    );
    expect(admission.admitAll([])).toEqual([]);
  }, 120_000);
});

describe("hands the caller what 5.8 needs", () => {
  test("the definition's L1 chain and each admitted ballot's L1 block and ballot hash, as its record gives them", () => {
    // 5.8 is the caller's: it judges the block against the finalized L1
    // chain the definition names, so both must be the record's own fields.
    const c = byId("admitted");
    const entries = bundleOf(c).entries;
    const admission = electionAdmission(hex(c.definition), panelOf(c.panel), entries);
    if (!admission.ok) throw new Error(admission.code);
    const d = decodeElectionDefinition(hex(c.definition));
    expect(admission.l1ChainId).toBe(d.l1_chain_id);
    const version = pinnedVersion(d, RECORD_TYPES.ballot) as 1 | 2 | 3 | 4;
    let seen = 0;
    for (const entry of entries.slice(1)) {
      const payload = payloadOf(entry);
      const r = admission.admit(payload);
      if (!r.ok) throw new Error(r.code);
      const record = decodeBallot(payload, version as 1);
      expect(r.l1RefNumber).toBe(record.l1_ref_number);
      expect(r.l1RefHash).toEqual(new Uint8Array(record.l1_ref_hash));
      // `M` binds the ballot hash, so the one handed over is the one the
      // membership proof was checked against.
      expect(
        membershipMessage({
          definitionHash: record.definition_hash,
          tier: r.tier,
          ballotHash: r.ballotHash,
          l1RefNumber: r.l1RefNumber,
          l1RefHash: r.l1RefHash,
        }),
      ).toEqual(r.message);
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("refuses every ballot of an election the verifier can't admit ballots for", () => {
  const refusal = (c: Case, panel = panelOf(c.panel), entries = bundleOf(c).entries) => {
    const r = electionAdmission(hex(c.definition), panel, entries);
    return r.ok ? "ok" : r.code;
  };
  test.each([
    ["quorum", "ceremony-quorum"],
    ["participation", "ceremony-participation"],
    ["other-key", "not-reached"],
    ["root-zero", "not-reached"],
    ["ballot-v2", "profile-combination"],
    ["ballot-v5-other-key", "unsupported-version"],
  ])("%s: %s", (id, code) => {
    expect(refusal(byId(id))).toBe(code);
  });

  test("another panel than the one the definition names", () => {
    expect(refusal(byId("admitted"), panelOf("panel-4-k2"))).toBe("panel-unpinned");
  });

  test("a board without the transcript", () => {
    const c = byId("admitted");
    expect(refusal(c, panelOf(c.panel), [])).toBe("ceremony-transcript-missing");
    // Every other entry, but not the transcript.
    expect(refusal(c, panelOf(c.panel), bundleOf(c).entries.slice(1))).toBe(
      "ceremony-transcript-missing",
    );
  });

  test("a definition that doesn't decode", () => {
    const c = byId("admitted");
    const bytes = hex(c.definition);
    expect(refusal({ ...c, definition: Buffer.from(bytes.subarray(0, 40)).toString("hex") })).toBe(
      "definition-decode",
    );
    // Version 0 is no release's: a decoding failure, as 2.1 reports it.
    const zero = bytes.slice();
    zero[2] = 0;
    expect(refusal({ ...c, definition: Buffer.from(zero).toString("hex") })).toBe(
      "definition-decode",
    );
  });
});

describe("never throws on a submitted payload", () => {
  const c = byId("admitted");
  const entries = bundleOf(c).entries;
  const admission = electionAdmission(hex(c.definition), panelOf(c.panel), entries);
  if (!admission.ok) throw new Error(admission.code);
  const ballot = payloadOf(entries[1] as Uint8Array);

  test("the admitted ballot, then other record types, are judged", () => {
    expect(admission.admit(ballot).ok).toBe(true);
    // The transcript itself is no ballot.
    expect(admission.admit(payloadOf(entries[0] as Uint8Array))).toEqual({
      ok: false,
      code: "decode",
      decodeError: "unexpected-record-type",
    });
    expect(admission.admit(new Uint8Array())).toMatchObject({ ok: false, code: "decode" });
  });

  test(
    "any truncation, extension or byte flip is rejected, never admitted as another ballot",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.nat({ max: ballot.length - 1 }).map((n) => ballot.slice(0, n)),
            fc
              .uint8Array({ minLength: 1, maxLength: 8 })
              .map((x) => Uint8Array.from([...ballot, ...x])),
            fc
              .tuple(fc.nat({ max: ballot.length - 1 }), fc.integer({ min: 1, max: 255 }))
              .map(([i, x]) => {
                const b = ballot.slice();
                b[i] = (b[i] as number) ^ x;
                return b;
              }),
          ),
          (changed) => {
            expect(admission.admit(changed).ok).toBe(false);
          },
        ),
        { numRuns: Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 200) },
      );
    },
  );
});
