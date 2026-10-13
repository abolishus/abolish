import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeElectionDefinitionRecord,
  type ElectionDefinitionV4,
  electionDefinitionV4Rule,
  electionStubV4Hash,
  encodeElectionDefinitionV4,
  identityKey,
  receiptKeyJudgement,
  receiptKeyRecordFromWord,
  receiptKeysCastCheck,
} from "../src/index.ts";
import { hex, readVectorFile } from "./spec-vectors.ts";

// Properties of election-definition version 4's receipt keys
// (docs/spec/election-definition.md, Layout (version 4), Receipt keys): any
// list of canonical keys round-trips, `receipt-keys` accepts exactly the
// non-empty strictly ascending lists, the keys are in the stub, and a key's
// judgement is settled once read at or after `opens_at` (T-26, T-31, T-69).
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const opts = { numRuns };

const typical = (() => {
  const v = readVectorFile("election-definition-v4.json").vectors.find(
    (x) => x.id === "definition-v4-typical",
  );
  if (v === undefined) throw new Error("definition-v4-typical is missing");
  return decodeElectionDefinitionRecord(hex(v.encoding)).value as ElectionDefinitionV4;
})();

// Secret scalars well inside [1, n − 1]; their keys are canonical by construction.
const key = fc
  .bigInt({ min: 1n, max: (1n << 255n) - 1n })
  .map((d) => identityKey(hex(d.toString(16).padStart(64, "0"))));
const keys = fc.array(key, { minLength: 0, maxLength: 4 });

const compare = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const ascending = (ks: readonly Uint8Array[]) =>
  ks.every((k, i) => i === 0 || compare(ks[i - 1] as Uint8Array, k) < 0);

describe("definition version 4's receipt keys", () => {
  test("every list of up to 4 canonical keys round-trips under version 4", () => {
    fc.assert(
      fc.property(keys, (ks) => {
        const d = { ...typical, receipt_keys: ks };
        const bytes = encodeElectionDefinitionV4(d);
        const record = decodeElectionDefinitionRecord(bytes);
        expect(record.version).toBe(4);
        expect(record.value).toEqual(d);
        expect(encodeElectionDefinitionV4(record.value as ElectionDefinitionV4)).toEqual(bytes);
      }),
      opts,
    );
  });

  test("receipt-keys accepts exactly the non-empty, strictly ascending lists", () => {
    fc.assert(
      fc.property(keys, (ks) => {
        const ok = ks.length > 0 && ascending(ks);
        expect(electionDefinitionV4Rule({ ...typical, receipt_keys: ks })).toBe(
          ok ? undefined : "receipt-keys",
        );
      }),
      opts,
    );
  });

  test("changing the keys changes the stub hash, so the ceremony binds them", () => {
    fc.assert(
      fc.property(keys, keys, (a, b) => {
        fc.pre(a.length !== b.length || a.some((k, i) => compare(k, b[i] as Uint8Array) !== 0));
        expect(electionStubV4Hash({ ...typical, receipt_keys: a })).not.toEqual(
          electionStubV4Hash({ ...typical, receipt_keys: b }),
        );
      }),
      opts,
    );
  });

  test("a flipped byte in a key is rejected or decodes to another canonical definition", () => {
    const bytes = encodeElectionDefinitionV4(typical);
    const keysAt = bytes.length - 33 * typical.receipt_keys.length;
    fc.assert(
      fc.property(
        fc.integer({ min: keysAt, max: bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, mask) => {
          const flipped = new Uint8Array(bytes);
          flipped[at] = (flipped[at] as number) ^ mask;
          try {
            const record = decodeElectionDefinitionRecord(flipped);
            expect(encodeElectionDefinitionV4(record.value as ElectionDefinitionV4)).toEqual(
              flipped,
            );
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            expect((e as DecodeError).code).toBe("non-canonical");
          }
        },
      ),
      opts,
    );
  });
});

describe("a listed key's judgement", () => {
  const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
  // A record the anchor can hold: a registration at r (0: none) and a
  // retirement at t (0: none, else at or after r).
  const record = fc
    .tuple(u64, u64, fc.boolean(), fc.boolean())
    .map(([a, b, registered, retired]) => {
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const registeredAt = registered ? (lo === 0n ? 1n : lo) : 0n;
      const retiredAt = registered && retired ? (hi < registeredAt ? registeredAt : hi) : 0n;
      return { registeredAt, retiredAt };
    });
  const latest = (r: { registeredAt: bigint; retiredAt: bigint }) =>
    r.retiredAt > r.registeredAt ? r.retiredAt : r.registeredAt;

  test("read at or after opens_at, the judgement doesn't depend on the block", () => {
    fc.assert(
      fc.property(record, u64, u64, u64, (r, opensAt, x, y) => {
        // Two blocks at or after both opens_at and the record's last write.
        const floor = opensAt > latest(r) ? opensAt : latest(r);
        const span = (1n << 64n) - floor;
        const p1 = floor + (x % span);
        const p2 = floor + (y % span);
        expect(receiptKeyJudgement(r, opensAt, p1)).toBe(receiptKeyJudgement(r, opensAt, p2));
        expect(receiptKeyJudgement(r, opensAt, p1)).not.toBe("unsettled");
      }),
      opts,
    );
  });

  test("a write after opens_at never changes the judgement", () => {
    fc.assert(
      fc.property(record, u64, (r, opensAt) => {
        const at = latest(r) > opensAt ? latest(r) : opensAt;
        // The same record without its writes after opens_at.
        const before = {
          registeredAt: r.registeredAt > opensAt ? 0n : r.registeredAt,
          retiredAt: r.registeredAt > opensAt || r.retiredAt > opensAt ? 0n : r.retiredAt,
        };
        expect(receiptKeyJudgement(r, opensAt, at)).toBe(receiptKeyJudgement(before, opensAt, at));
      }),
      opts,
    );
  });

  test("a key judges only if registered before opens_at and not retired by then", () => {
    fc.assert(
      fc.property(record, u64, (r, opensAt) => {
        const at = latest(r) > opensAt ? latest(r) : opensAt;
        const judges =
          r.registeredAt !== 0n &&
          r.registeredAt < opensAt &&
          (r.retiredAt === 0n || r.retiredAt > opensAt);
        expect(receiptKeyJudgement(r, opensAt, at) === "judges").toBe(judges);
      }),
      opts,
    );
  });

  const word = (r: { registeredAt: bigint; retiredAt: bigint }, high = 0n) =>
    hex(((high << 128n) | (r.retiredAt << 64n) | r.registeredAt).toString(16).padStart(64, "0"));

  test("a word round-trips to its record at any block at or after its last write", () => {
    fc.assert(
      fc.property(record, u64, (r, x) => {
        const at = latest(r) + (x % ((1n << 64n) - latest(r)));
        expect(receiptKeyRecordFromWord(word(r), at)).toEqual(r);
        // A block before the last write can't hold it.
        if (latest(r) > 0n)
          expect(receiptKeyRecordFromWord(word(r), latest(r) - 1n)).toBeUndefined();
      }),
      opts,
    );
  });

  test("a word with any of its high 128 bits set is never read", () => {
    fc.assert(
      fc.property(record, fc.bigInt({ min: 1n, max: (1n << 128n) - 1n }), (r, high) => {
        expect(receiptKeyRecordFromWord(word(r, high), (1n << 64n) - 1n)).toBeUndefined();
        // An opens_at the record alone would let the client cast under.
        const opensAt = latest(r) + 1n;
        fc.pre(opensAt < 1n << 64n);
        expect(receiptKeysCastCheck([word(r)], opensAt, opensAt).castable).toBe(
          r.registeredAt !== 0n && r.retiredAt === 0n,
        );
        expect(receiptKeysCastCheck([word(r, high)], opensAt, opensAt)).toEqual({
          castable: false,
          code: "receipt-key-unjudged",
          key: 0,
        });
      }),
      opts,
    );
  });

  test("read at or after opens_at, the client casts exactly when every key judges", () => {
    fc.assert(
      fc.property(fc.array(record, { minLength: 1, maxLength: 4 }), u64, (rs, opensAt) => {
        const at = rs.reduce((m, r) => (latest(r) > m ? latest(r) : m), opensAt);
        const firstNot = rs.findIndex((r) => receiptKeyJudgement(r, opensAt, at) !== "judges");
        expect(
          receiptKeysCastCheck(
            rs.map((r) => word(r)),
            opensAt,
            at,
          ),
        ).toEqual(
          firstNot === -1
            ? { castable: true }
            : { castable: false, code: "receipt-key-unjudged", key: firstNot },
        );
      }),
      opts,
    );
  });

  test("a key the client accepts before opens_at judges unless retired in between", () => {
    fc.assert(
      fc.property(record, u64, u64, (r, opensAt, x) => {
        fc.pre(latest(r) < opensAt);
        // A block before opens_at, at or after the record's last write.
        const at = latest(r) + (x % (opensAt - latest(r)));
        const accepted = receiptKeysCastCheck([word(r)], opensAt, at).castable;
        expect(accepted).toBe(r.registeredAt !== 0n && r.retiredAt === 0n);
        // With no write between the read and opens_at, it judges the election.
        expect(receiptKeyJudgement(r, opensAt, opensAt) === "judges").toBe(accepted);
      }),
      opts,
    );
  });
});
