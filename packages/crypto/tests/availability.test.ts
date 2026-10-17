import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  AVAILABILITY_POINTS,
  type AvailabilityAttestation,
  availabilityAttestationMessage,
  type AvailabilityElection,
  type AvailabilityEvent,
  availabilityWindows,
  BALLOT_FETCH_ALLOWANCE,
  checkAvailability,
  COUNTED_FETCH_ALLOWANCE,
  countedAttestations,
  DecodeError,
  decodeAvailabilityAttestation,
  decodeAvailabilityComplaint,
  encodeAvailabilityAttestation,
  EncodeError,
  encodeAvailabilityComplaint,
  type AvailabilityComplaint,
  availabilityComplaintMessage,
  MAX_ATTESTED_ROOTS,
  PARAMETERS,
  RECORD_TYPES,
  signAvailabilityAttestation,
  signAvailabilityComplaint,
  verifyStatement,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/availability.json comes from an independent Python
// implementation of docs/spec/availability.md (scripts/availability-vectors.py,
// with its own strict decoder, P-256 ECDSA, windows and check), so these bytes
// and verdicts never come from the code under test.

type Fields = Readonly<Record<string, string | number | readonly string[]>>;

interface Vectors {
  readonly format: string;
  readonly tags: { readonly attestation: string; readonly complaint: string };
  readonly recordTypes: { readonly attestation: string; readonly complaint: string };
  readonly version: number;
  readonly allowances: { readonly ballot: string; readonly counted: string };
  readonly records: readonly {
    readonly id: string;
    readonly kind: "attestation" | "complaint";
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly fields: Fields;
    readonly message: string;
    readonly signature: string;
    readonly encoding: string;
  }[];
  readonly decodeErrors: readonly {
    readonly id: string;
    readonly kind: "attestation" | "complaint";
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly windows: readonly {
    readonly id: string;
    readonly closesAt: string;
    readonly l1InclusionBound: string;
    readonly countedDue: string;
    readonly forcedInclusion: string;
    readonly margin: string;
    readonly result: Readonly<Record<string, string>>;
  }[];
  readonly checks: readonly {
    readonly id: string;
    readonly election: {
      readonly definitionHash: string;
      readonly panels: readonly {
        readonly panel: 1 | 2;
        readonly threshold: number;
        readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
      }[];
      readonly checkpoints: { readonly ballot: string | null; readonly counted: string | null };
      readonly deadlines: { readonly ballot: string; readonly counted: string };
    };
    readonly events: readonly { readonly payload: string; readonly submittedAt: string }[];
    readonly result: unknown;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("availability.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const ATTESTATION_TAG = "abolish/v1/sig/availability-attestation";
const COMPLAINT_TAG = "abolish/v1/sig/availability-complaint";

const str = (v: unknown) => v as string;
const num = (v: unknown) => v as number;

function attestationFields(f: Fields) {
  return {
    definition_hash: hex(str(f["definitionHash"])),
    panel: num(f["panel"]) as 1 | 2,
    seat: num(f["seat"]),
    point: num(f["point"]) as 1 | 2,
    checkpoint_hash: hex(str(f["checkpointHash"])),
    roots: (f["roots"] as readonly string[]).map(hex),
  };
}

function complaintFields(f: Fields) {
  return {
    definition_hash: hex(str(f["definitionHash"])),
    panel: num(f["panel"]) as 1 | 2,
    seat: num(f["seat"]),
    point: num(f["point"]) as 1 | 2,
    checkpoint_hash: hex(str(f["checkpointHash"])),
    cid: hex(str(f["cid"])),
  };
}

// Bytes as hex and bigints as decimal, recursively, so a report compares
// with the file's.
function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function electionOf(e: Vectors["checks"][number]["election"]): AvailabilityElection {
  return {
    definitionHash: hex(e.definitionHash),
    panels: e.panels.map((p) => ({
      panel: p.panel,
      threshold: p.threshold,
      registered: p.registered.map((k) => ({ index: k.index, signingKey: hex(k.signingKey) })),
    })),
    checkpoints: {
      ballot: e.checkpoints.ballot === null ? null : hex(e.checkpoints.ballot),
      counted: e.checkpoints.counted === null ? null : hex(e.checkpoints.counted),
    },
    deadlines: { ballot: BigInt(e.deadlines.ballot), counted: BigInt(e.deadlines.counted) },
  };
}

const eventsOf = (c: Vectors["checks"][number]): AvailabilityEvent[] =>
  c.events.map((e) => ({ payload: hex(e.payload), submittedAt: BigInt(e.submittedAt) }));

const record = (id: string) => {
  const r = vectors.records.find((x) => x.id === id);
  if (r === undefined) throw new Error(`availability.json: no record ${id}`);
  return r;
};

const allAttest = vectors.checks.find((c) => c.id === "all-attest");
if (allAttest === undefined) throw new Error("availability.json: no all-attest check");
const base = electionOf(allAttest.election);
const honestEvents = eventsOf(allAttest);

describe("availability vectors (docs/spec/vectors/availability.json)", () => {
  test("the file is the availability format for record types 0x001b and 0x001c, version 1", () => {
    expect(vectors.format).toBe("abolish-availability-vectors/1");
    expect(vectors.tags).toEqual({ attestation: ATTESTATION_TAG, complaint: COMPLAINT_TAG });
    expect(vectors.recordTypes).toEqual({
      attestation: `0x${RECORD_TYPES.availabilityAttestation.toString(16).padStart(4, "0")}`,
      complaint: `0x${RECORD_TYPES.availabilityComplaint.toString(16).padStart(4, "0")}`,
    });
    expect(vectors.version).toBe(1);
    expect(vectors.allowances).toEqual({
      ballot: String(BALLOT_FETCH_ALLOWANCE),
      counted: String(COUNTED_FETCH_ALLOWANCE),
    });
    expect(BigInt(PARAMETERS.BALLOT_FETCH_ALLOWANCE)).toBe(BALLOT_FETCH_ALLOWANCE);
    expect(MAX_ATTESTED_ROOTS).toBe(2 * PARAMETERS.MAX_TRUSTEES);
  });

  test("every record is re-made byte for byte from its seat's secret, and decodes to its fields", () => {
    expect(vectors.records.length).toBeGreaterThan(0);
    for (const v of vectors.records) {
      const secret = hex(v.signingSecret);
      if (v.kind === "attestation") {
        const fields = attestationFields(v.fields);
        expect(availabilityAttestationMessage(fields), v.id).toEqual(hex(v.message));
        const signed = signAvailabilityAttestation(secret, fields);
        expect(signed.signature, v.id).toEqual(hex(v.signature));
        expect(encodeAvailabilityAttestation(signed), v.id).toEqual(hex(v.encoding));
        expect(decodeAvailabilityAttestation(hex(v.encoding), 1), v.id).toEqual(signed);
        expect(
          verifyStatement(hex(v.signingKey), ATTESTATION_TAG, hex(v.message), signed.signature),
        ).toBe(true);
      } else {
        const fields = complaintFields(v.fields);
        expect(availabilityComplaintMessage(fields), v.id).toEqual(hex(v.message));
        const signed = signAvailabilityComplaint(secret, fields);
        expect(signed.signature, v.id).toEqual(hex(v.signature));
        expect(encodeAvailabilityComplaint(signed), v.id).toEqual(hex(v.encoding));
        expect(decodeAvailabilityComplaint(hex(v.encoding), 1), v.id).toEqual(signed);
        expect(
          verifyStatement(hex(v.signingKey), COMPLAINT_TAG, hex(v.message), signed.signature),
        ).toBe(true);
      }
    }
  });

  test("every decode rejection has the file's code at the file's offset", () => {
    expect(vectors.decodeErrors.length).toBeGreaterThan(0);
    for (const v of vectors.decodeErrors) {
      const b = hex(v.encoding);
      const run = () =>
        v.kind === "attestation"
          ? decodeAvailabilityAttestation(b, 1)
          : decodeAvailabilityComplaint(b, 1);
      let err: unknown;
      try {
        run();
      } catch (e) {
        err = e;
      }
      expect(err, v.id).toBeInstanceOf(DecodeError);
      expect(
        { code: (err as DecodeError).code, offset: (err as DecodeError).offset },
        v.id,
      ).toEqual({
        code: v.error,
        offset: v.offset,
      });
    }
  });

  test("the windows are the file's", () => {
    for (const v of vectors.windows) {
      const w = availabilityWindows(
        BigInt(v.closesAt),
        BigInt(v.l1InclusionBound),
        BigInt(v.countedDue),
        {
          forcedInclusion: BigInt(v.forcedInclusion),
          margin: BigInt(v.margin),
        },
      );
      expect(plain(w), v.id).toEqual(v.result);
    }
  });

  test("every availability check gives the file's verdict, points, codes and rejections", () => {
    expect(vectors.checks.length).toBeGreaterThan(0);
    for (const c of vectors.checks) {
      const r = checkAvailability(electionOf(c.election), eventsOf(c));
      expect(plain(r), c.id).toEqual(c.result);
    }
  });
});

describe("availability records", () => {
  const a1 = record("attestation-ballot-extent");
  const secret1 = hex(a1.signingSecret);
  const fields1 = attestationFields(a1.fields);

  test("the encoder refuses what has no encoding", () => {
    const signed = signAvailabilityAttestation(secret1, fields1);
    const root = new Uint8Array(32);
    const root2 = Uint8Array.from(root, (_, i) => (i === 31 ? 1 : 0));
    expect(() => encodeAvailabilityAttestation({ ...signed, roots: [root] })).toThrow(EncodeError);
    const counted = { ...signed, point: AVAILABILITY_POINTS.countedExtent };
    expect(() => encodeAvailabilityAttestation({ ...counted, roots: [root2, root] })).toThrow(
      EncodeError,
    );
    expect(() => encodeAvailabilityAttestation({ ...counted, roots: [root, root] })).toThrow(
      EncodeError,
    );
    expect(() =>
      encodeAvailabilityAttestation({
        ...counted,
        roots: Array.from({ length: MAX_ATTESTED_ROOTS + 1 }, (_, i) =>
          Uint8Array.of(...new Uint8Array(31), i),
        ),
      }),
    ).toThrow(EncodeError);
    expect(encodeAvailabilityAttestation({ ...counted, roots: [root, root2] }).length).toBe(
      138 + 64,
    );
    const c = record("complaint-raw");
    const complaint = signAvailabilityComplaint(hex(c.signingSecret), complaintFields(c.fields));
    const cid = Uint8Array.from(complaint.cid);
    cid[1] = 0x71;
    expect(() => encodeAvailabilityComplaint({ ...complaint, cid })).toThrow(EncodeError);
    expect(() => availabilityComplaintMessage({ ...complaint, cid })).toThrow(EncodeError);
  });

  test("the signed message starts with the record header, and only it verifies", () => {
    const m = availabilityAttestationMessage(fields1);
    expect(Array.from(m.subarray(0, 3))).toEqual([0x00, 0x1b, 0x01]);
    expect(m.length).toBe(74);
    const { signature } = signAvailabilityAttestation(secret1, fields1);
    const key = hex(a1.signingKey);
    expect(verifyStatement(key, ATTESTATION_TAG, m, signature)).toBe(true);
    expect(verifyStatement(key, ATTESTATION_TAG, m.subarray(3), signature)).toBe(false);
    // The same seat's statement under the complaint's tag doesn't verify.
    expect(verifyStatement(key, COMPLAINT_TAG, m, signature)).toBe(false);
  });

  test("the windows refuse a negative t_S, and follow F and R", () => {
    expect(() => availabilityWindows(0n, 0n, -1n, { forcedInclusion: 0n, margin: 0n })).toThrow(
      RangeError,
    );
    const hour = 3600n;
    const w = availabilityWindows(0n, 0n, 0n, { forcedInclusion: 13n * hour, margin: hour });
    expect(w.ballotDeadline - w.ballotCutoff).toBe(13n * hour);
    expect(w.countedCutoff).toBe(COUNTED_FETCH_ALLOWANCE);
    expect(w.summing - w.countedDeadline).toBe(hour);
  });
});

describe("the availability check", () => {
  test("its inputs are checked", () => {
    expect(() => checkAvailability({ ...base, definitionHash: new Uint8Array(31) }, [])).toThrow(
      RangeError,
    );
    expect(() => checkAvailability({ ...base, panels: [] }, [])).toThrow(RangeError);
    const author = { panel: 2 as const, threshold: 2, registered: [] };
    expect(() => checkAvailability({ ...base, panels: [author] }, [])).toThrow(RangeError);
    const [d] = base.panels;
    if (d === undefined) throw new Error("no default panel");
    expect(() => checkAvailability({ ...base, panels: [{ ...d, threshold: 0 }] }, [])).toThrow(
      RangeError,
    );
    const twice = [...d.registered, ...d.registered.slice(0, 1)];
    expect(() => checkAvailability({ ...base, panels: [{ ...d, registered: twice }] }, [])).toThrow(
      RangeError,
    );
    expect(() =>
      checkAvailability(base, [{ payload: new Uint8Array(), submittedAt: -1n }]),
    ).toThrow(RangeError);
    expect(() =>
      checkAvailability(base, [
        { payload: new Uint8Array(), submittedAt: 2n },
        { payload: new Uint8Array(), submittedAt: 1n },
      ]),
    ).toThrow(RangeError);
  });

  test("the default panel's counted-extent attestations are what delivery reads, with their roots", () => {
    const r = checkAvailability(base, honestEvents);
    const counted = countedAttestations(r);
    expect(counted.map((a) => a.seat)).toEqual([1, 2, 3, 4]);
    for (const a of counted) expect(a.roots.length).toBe(2);
  });

  test("each check is needed: without the deadline, the checkpoint or the threshold a short quorum passes", () => {
    // Mutation-style, against the file's own failing cases: each fails only
    // through the check it names.
    const failing = (id: string) => {
      const c = vectors.checks.find((x) => x.id === id);
      if (c === undefined) throw new Error(`no check ${id}`);
      return { election: electionOf(c.election), events: eventsOf(c) };
    };
    const late = failing("late");
    expect(checkAvailability(late.election, late.events).verdict).toBe("unavailable");
    const far = { ballot: 10n ** 12n, counted: 10n ** 12n };
    expect(checkAvailability({ ...late.election, deadlines: far }, late.events).verdict).toBe(
      "available",
    );
    const wrong = failing("wrong-checkpoint");
    expect(checkAvailability(wrong.election, wrong.events).verdict).toBe("unavailable");
    const short = failing("quorum-short-ballot");
    expect(checkAvailability(short.election, short.events).verdict).toBe("unavailable");
    const [d] = short.election.panels;
    if (d === undefined) throw new Error("no default panel");
    expect(
      checkAvailability({ ...short.election, panels: [{ ...d, threshold: 2 }] }, short.events)
        .verdict,
    ).toBe("available");
  });
});

describe("availability properties", () => {
  const a = record("attestation-counted-three-roots");
  const c = record("complaint-raw");
  const honestA = hex(a.encoding);
  const honestC = hex(c.encoding);
  const secretA = hex(a.signingSecret);

  test("attestations round-trip, and a signed one counts only for its own seat, point and checkpoint", () => {
    const hash = fc.uint8Array({ minLength: 32, maxLength: 32 });
    fc.assert(
      fc.property(
        fc.record({
          seat: fc.integer({ min: 0, max: 255 }),
          point: fc.constantFrom(1 as const, 2 as const),
          checkpoint_hash: hash,
          roots: fc.uniqueArray(hash, {
            maxLength: 4,
            selector: (h) => Buffer.from(h).toString("hex"),
          }),
        }),
        (f) => {
          const roots = f.point === 1 ? [] : [...f.roots].sort((x, y) => Buffer.compare(x, y));
          const fields = {
            ...attestationFields(a.fields),
            seat: f.seat,
            point: f.point,
            checkpoint_hash: f.checkpoint_hash,
            roots,
          };
          const s: AvailabilityAttestation = signAvailabilityAttestation(secretA, fields);
          const b = encodeAvailabilityAttestation(s);
          expect(b.length).toBe(138 + 32 * roots.length);
          expect(decodeAvailabilityAttestation(b, 1)).toEqual(s);
          const r = checkAvailability(
            { ...base, checkpoints: { ballot: f.checkpoint_hash, counted: f.checkpoint_hash } },
            [{ payload: b, submittedAt: 0n }],
          );
          const line = r.points[f.point - 1]?.panels[0];
          // Seat 4's secret signed it: it counts only as seat 4's.
          expect(line?.attested.map((x) => x.seat)).toEqual(f.seat === 4 ? [4] : []);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  }, 60_000);

  test("any changed byte of a record is rejected or doesn't count", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(honestA, honestC),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (honest, i, x) => {
          const at = i % honest.length;
          const b = Uint8Array.from(honest);
          b[at] = (b[at] as number) ^ x;
          const r = checkAvailability(base, [{ payload: b, submittedAt: 0n }]);
          expect(r.records.every((l) => l.code !== "valid")).toBe(true);
        },
      ),
      { numRuns },
    );
  }, 60_000);

  test("every accepted encoding re-encodes to itself", () => {
    const tails = fc.uint8Array({ minLength: 0, maxLength: 200 });
    fc.assert(
      fc.property(
        fc.oneof(
          tails,
          tails.map((t) => Uint8Array.of(0x00, 0x1b, 0x01, ...t)),
          tails.map((t) => Uint8Array.of(0x00, 0x1c, 0x01, ...t)),
          fc
            .uint8Array({ minLength: 64, maxLength: 64 })
            .map((sig) => Uint8Array.of(...honestA.subarray(0, honestA.length - 64), ...sig)),
          fc
            .uint8Array({ minLength: 64, maxLength: 64 })
            .map((sig) => Uint8Array.of(...honestC.subarray(0, 106), ...sig)),
        ),
        (b) => {
          let attestation: AvailabilityAttestation | undefined;
          let complaint: AvailabilityComplaint | undefined;
          try {
            if (b[1] === 0x1c) complaint = decodeAvailabilityComplaint(b, 1);
            else attestation = decodeAvailabilityAttestation(b, 1);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          if (attestation !== undefined)
            expect(encodeAvailabilityAttestation(attestation)).toEqual(b);
          if (complaint !== undefined) expect(encodeAvailabilityComplaint(complaint)).toEqual(b);
        },
      ),
      { numRuns },
    );
  }, 60_000);
});
