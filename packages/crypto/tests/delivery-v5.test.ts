import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { shapeOkV4 } from "../src/ballot-validity.ts";
import {
  checkPostingV4,
  decode,
  decodeObligationRoot,
  decodeShareComplaint,
  decodeShareComplaintBatch,
  decodeSharePosting,
  decodeShareReceipt,
  decodeShareReceiptBatch,
  H,
  ds,
  KEM_PUBLIC_KEY,
  membershipMessage,
  semaphoreField,
  type SignatureTag,
  verifyMembershipProof,
  verifyStatement,
} from "../src/index.ts";
import { ballotHash, decodeV5, rollingScope } from "./ballot-v5.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery-v5.json comes from an independent Python
// implementation of the board's delivery records under ballot version 5
// (scripts/delivery-v5-vectors.py): the rolling posting call, whose ballot's
// membership proof is checked against a root its sender supplies, and the
// version-2 receipts, complaints, batches and roots of a rolling poll. Its
// ballots carry real Semaphore proofs (snarkjs, scripts/ballot-proofs.mjs) and
// real ciphertexts to every seat. No contract reads it before P2-17 part 5,
// so this runs the call's steps as docs/spec/contracts.md orders them (Board,
// Delivery records (ballot version 5), Rolling postings) over packages/crypto's
// record codecs, Groth16 verifier, public posting check and signatures, and
// requires each case's result to be the file's.

type Result =
  | { readonly result: "accepted" }
  | {
      readonly check: "delivery" | "ballot";
      readonly code: string;
      readonly offset?: number;
      readonly position?: number;
    };

interface Election {
  readonly definitionHash: string;
  readonly ballotVersion: number;
  readonly optionTotal: number;
  readonly panelSize: number;
  readonly authorPanelSize: number;
  readonly registered: { readonly default: readonly number[]; readonly author: readonly number[] };
  readonly closesAt?: string;
  readonly cells?: readonly { readonly cell: number; readonly tier: number }[];
}

interface Seat {
  readonly seat: number;
  readonly kemKey: string;
  readonly signingSecret: string;
  readonly signingKey: string;
}

interface Vectors {
  readonly format: string;
  readonly selectors: Readonly<Record<"submitRollingPosting" | "submitPosting", string>>;
  readonly panels: { readonly default: number; readonly author: number };
  readonly seats: { readonly default: readonly Seat[]; readonly author: readonly Seat[] };
  readonly elections: Readonly<Record<string, Election>>;
  readonly ballots: readonly {
    readonly id: string;
    readonly election: string | null;
    readonly encoding: string;
    readonly ballotHash?: string;
    readonly cell?: number;
    readonly step?: number;
    readonly provedRoot?: string;
  }[];
  readonly postings: readonly ({
    readonly id: string;
    readonly call: "submitRollingPosting" | "submitPosting";
    readonly ballot: string;
    readonly posting: string;
    readonly root?: string;
    readonly registered?: Election["registered"];
    readonly timestamp?: string;
    readonly snarkjs?: boolean;
    readonly rootCheck?: "match" | "root-step-mismatch";
  } & Result)[];
  readonly calldata: readonly {
    readonly id: string;
    readonly calldata: string;
    readonly canonical: boolean;
  }[];
  readonly records: readonly ({
    readonly id: string;
    readonly call: keyof typeof CALL_TYPES;
    readonly records: readonly string[];
  } & Result)[];
}

// The elections the rolling ones are, with their questions, panels and step
// roots, from the generator of ballot-v5-records.json.
interface RecordsElection {
  readonly definitionHash: string;
  readonly questions: readonly {
    readonly optionCount: number;
    readonly minSelections: number;
    readonly maxSelections: number;
  }[];
  readonly threshold: number;
  readonly panelSize: number;
  readonly authorThreshold: number;
  readonly authorPanelSize: number;
  readonly cells: readonly {
    readonly tier: number;
    readonly steps: readonly { readonly step: number; readonly root: string }[];
  }[];
}

const load = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;
const V = load<Vectors>("delivery-v5.json");
const RECORDS = load<{ readonly elections: Readonly<Record<string, RecordsElection>> }>(
  "ballot-v5-records.json",
);
const INTAKE = load<{
  readonly elections: Readonly<Record<string, { readonly definitionHash: string }>>;
}>("intake-v4.json");

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DEFAULT = 1;
const AUTHOR = 2;
const POSTING_TYPE = 0x000d;
// The posting's fields: type and version, definition_hash, ballot_hash,
// panel, seat and m, then the ciphertext, whose sealed field's length follows
// ct_m (1,088 bytes), ct_dh (32) and pok_c and pok_z (64).
const CIPHERTEXT_AT = 3 + 32 + 32 + 1 + 1 + 32;
const SEALED_LENGTH_AT = CIPHERTEXT_AT + 1184;
// The ballot's membership proof, at the offset every ballot version keeps.
const PROOF_AT = 108;

const CALL_TYPES = {
  submitReceipts: 0x000c,
  submitComplaint: 0x000e,
  submitReceiptBatch: 0x0016,
  submitComplaintBatch: 0x0017,
  submitObligationRoot: 0x001a,
} as const;
const TAGS: Readonly<Record<number, SignatureTag>> = {
  0x000c: "abolish/v1/sig/share-receipt-2",
  0x000e: "abolish/v1/sig/share-complaint-2",
  0x0016: "abolish/v1/sig/share-receipt-batch-2",
  0x0017: "abolish/v1/sig/share-complaint-batch-2",
  0x001a: "abolish/v1/sig/obligation-root-2",
};

const byDefinition = new Map(Object.values(V.elections).map((e) => [e.definitionHash, e]));
const recordsElection = (definitionHash: string) =>
  Object.values(RECORDS.elections).find((e) => e.definitionHash === definitionHash);
const ballots = new Map(V.ballots.map((b) => [b.id, b]));
const seatsOf = (panel: number) => (panel === DEFAULT ? V.seats.default : V.seats.author);
const wordOf = (b: Uint8Array) => BigInt(`0x${toHex(b) || "0"}`);
const u16 = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);

type Registered = Election["registered"];
const panelSeats = (registered: Registered, panel: number) =>
  panel === DEFAULT ? registered.default : registered.author;

/**
 * Delivery records' steps 1 to 6 on one record of the call's type (Delivery
 * records (ballot version 5)): its election, the version its ballot version
 * fixes, its fields, its seat in its own panel's key set and, but for a
 * posting, its signature under that seat's key. Every record here frames.
 */
function deliverySteps(
  rec: Uint8Array,
  type: number,
  registered?: Registered,
): Omit<Extract<Result, { check: string }>, "check"> | undefined {
  expect(u16(rec, 0)).toBe(type);
  const e = byDefinition.get(toHex(rec.subarray(3, 35)));
  if (e === undefined) return { code: "delivery-stray" };
  if (e.ballotVersion > 5) return { code: "unknown-version", offset: 2 };
  if (rec[2] !== (e.ballotVersion >= 4 ? 2 : 1)) return { code: "profile-mismatch", offset: 2 };
  const fields: { panel: number; seat: number } =
    type === 0x000c
      ? decodeShareReceipt(rec, 2)
      : type === 0x000d
        ? decodeSharePosting(rec, 2)
        : type === 0x000e
          ? decodeShareComplaint(rec, 2)
          : type === 0x0016
            ? decodeShareReceiptBatch(rec, 2)
            : type === 0x0017
              ? decodeShareComplaintBatch(rec, 2)
              : decodeObligationRoot(rec, 2);
  const seats = panelSeats(registered ?? e.registered, fields.panel);
  if (!seats.includes(fields.seat)) return { code: "delivery-seat" };
  if (type === POSTING_TYPE) return undefined;
  const key = hex(seatsOf(fields.panel).find((s) => s.seat === fields.seat)!.signingKey);
  const tag = TAGS[type]!;
  if (!verifyStatement(key, tag, rec.subarray(3, rec.length - 64), rec.subarray(rec.length - 64)))
    return { code: "delivery-signature" };
  return undefined;
}

/** The ballot check of Rolling ballots, or of Ballots on `submitPosting`, up to its membership proof. */
function ballotCheck(
  record: Uint8Array,
  root: bigint | undefined,
  registered: Registered | undefined,
): { code: string; offset?: number } | undefined {
  const e = byDefinition.get(toHex(record.subarray(3, 35)));
  if (e === undefined) return { code: "ballot-stray" };
  if (record[2] !== e.ballotVersion) return { code: "profile-mismatch", offset: 2 };
  const rolling = root !== undefined;
  if (rolling ? e.ballotVersion !== 5 : e.ballotVersion > 4)
    return { code: "unknown-version", offset: 2 };
  const b = decodeV5(record);
  const re = recordsElection(e.definitionHash)!;
  const cell = re.cells[b.cell];
  if (cell === undefined) return { code: "ballot-cell" };
  const ctx = {
    questions: re.questions,
    threshold: re.threshold,
    panelSize: re.panelSize,
    authorThreshold: re.authorThreshold,
    authorPanelSize: re.authorPanelSize,
    definitionHash: b.definition_hash,
    cell: b.cell,
    nullifier: b.nullifier,
  };
  if (!shapeOkV4(ctx, b.committed_vote)) return { code: "validity-shape" };
  const reg = registered ?? e.registered;
  for (const [panel, hashes] of [
    [DEFAULT, b.committed_vote.share_hashes],
    [AUTHOR, b.committed_vote.author_share_hashes],
  ] as const)
    for (const [i, h] of hashes.entries())
      if (!panelSeats(reg, panel).includes(i + 1) && h.some((x) => x !== 0))
        return { code: "share-hash-unqualified" };
  if (root === undefined || root === 0n || root >= R || !proofHolds(record, cell.tier, root))
    return { code: "membership-proof" };
  return undefined;
}

/** Groth16 against the supplied root, the record's nullifier, `F(M)` and `ŝ_t`. */
function proofHolds(record: Uint8Array, tier: number, root: bigint): boolean {
  const b = decodeV5(record);
  const message = membershipMessage({
    definitionHash: b.definition_hash,
    tier,
    ballotHash: ballotHash(b),
    l1RefNumber: b.l1_ref_number,
    l1RefHash: b.l1_ref_hash,
  });
  return verifyMembershipProof(record.subarray(PROOF_AT, PROOF_AT + 256), {
    root,
    nullifier: b.nullifier,
    message: semaphoreField(message),
    scope: rollingScope(b.definition_hash, tier),
  });
}

/** submitRollingPosting's steps after its calldata (submitPosting's without a root). */
function postingCall(
  posting: Uint8Array,
  ballot: Uint8Array,
  root: bigint | undefined,
  registered?: Registered,
): Result {
  const d = deliverySteps(posting, POSTING_TYPE, registered);
  if (d !== undefined) return { check: "delivery", ...d };
  const e = byDefinition.get(toHex(posting.subarray(3, 35)))!;
  const sealed = new DataView(posting.buffer, posting.byteOffset).getUint32(SEALED_LENGTH_AT);
  if (sealed !== 4 + 64 * e.optionTotal + 16) return { check: "delivery", code: "posting-length" };
  const b = ballotCheck(ballot, root, registered);
  if (b !== undefined) return { check: "ballot", ...b };
  const p = decodeSharePosting(posting, 2);
  const v = decodeV5(ballot);
  if (
    toHex(p.definition_hash) !== toHex(v.definition_hash) ||
    toHex(p.ballot_hash) !== toHex(ballotHash(v))
  )
    return { check: "delivery", code: "posting-ballot" };
  const list =
    p.panel === DEFAULT ? v.committed_vote.share_hashes : v.committed_vote.author_share_hashes;
  const ct = posting.subarray(CIPHERTEXT_AT);
  if (toHex(H(ds("abolish/v1/share-ciphertext", ct))) !== toHex(list[p.seat - 1]!))
    return { check: "delivery", code: "posting-hash" };
  return { result: "accepted" };
}

const resultOf = (v: Result): Result =>
  "result" in v
    ? { result: v.result }
    : {
        check: v.check,
        code: v.code,
        ...(v.offset === undefined ? {} : { offset: v.offset }),
        ...(v.position === undefined ? {} : { position: v.position }),
      };

/** The call's canonical-calldata rule (Calls; Rolling postings, step 1): its arguments, or undefined. */
function rollingCalldata(cd: Uint8Array) {
  const pad = (n: number) => 32 * Math.ceil(n / 32);
  const word = (at: number) => wordOf(cd.subarray(4 + at, 4 + at + 32));
  if (cd.length < 4 + 160 || toHex(cd.subarray(0, 4)) !== V.selectors.submitRollingPosting)
    return undefined;
  if (word(32) !== 0x60n) return undefined;
  const p = Number(word(0x60));
  const second = 0x80 + pad(p);
  if (word(64) !== BigInt(second) || cd.length < 4 + second + 32) return undefined;
  const b = Number(word(second));
  if (cd.length !== 4 + second + 32 + pad(b)) return undefined;
  const zero = (from: number, to: number) => cd.subarray(4 + from, 4 + to).every((x) => x === 0);
  if (!zero(0x80 + p, second) || !zero(second + 32 + b, second + 32 + pad(b))) return undefined;
  return {
    root: word(0),
    posting: cd.slice(4 + 0x80, 4 + 0x80 + p),
    ballot: cd.slice(4 + second + 32, 4 + second + 32 + b),
  };
}

describe("delivery records under ballot version 5 (docs/spec/vectors/delivery-v5.json)", () => {
  test("format, selectors and elections", () => {
    expect(V.format).toBe("abolish-delivery-contract-vectors/1");
    expect(V.panels).toEqual({ default: DEFAULT, author: AUTHOR });
    const selector = (sig: string) =>
      toHex(keccak_256(new TextEncoder().encode(sig)).subarray(0, 4));
    expect(V.selectors).toEqual({
      submitRollingPosting: selector("submitRollingPosting(bytes32,bytes,bytes)"),
      submitPosting: selector("submitPosting(bytes,bytes)"),
    });
    // The rolling elections are ballot-v5-records.json's, the fixed one intake-v4.json's.
    expect(V.elections.rolling?.definitionHash).toBe(RECORDS.elections.rolling?.definitionHash);
    expect(V.elections["default-only"]?.definitionHash).toBe(
      RECORDS.elections["default-only"]?.definitionHash,
    );
    expect(V.elections.fixed?.definitionHash).toBe(INTAKE.elections.panels?.definitionHash);
    for (const e of Object.values(V.elections)) {
      const re = recordsElection(e.definitionHash);
      if (e.ballotVersion !== 5) continue;
      expect(re).toBeDefined();
      expect(e.optionTotal).toBe(re!.questions.reduce((n, q) => n + q.optionCount, 0));
      expect([e.panelSize, e.authorPanelSize]).toEqual([re!.panelSize, re!.authorPanelSize]);
      expect(e.cells?.map((c) => c.tier)).toEqual(re!.cells.map((c) => c.tier));
    }
  });

  test("each version-5 ballot decodes, with its ballot hash, step and proved root", () => {
    for (const v of V.ballots) {
      const record = hex(v.encoding);
      if (v.step === undefined) {
        expect(record[2]).toBe(4);
        continue;
      }
      const b = decodeV5(record);
      expect(toHex(ballotHash(b))).toBe(v.ballotHash);
      expect([b.cell, b.step]).toEqual([v.cell, v.step]);
      // A relabelled ballot carries the proof of the one it came from, and
      // names no proved root.
      const cell = recordsElection(toHex(b.definition_hash))?.cells[b.cell];
      if (v.provedRoot === undefined || cell === undefined) continue;
      // Its proof verifies against the root it was made against, a step root
      // ballot-v5-records.json's generator rebuilt from the group events.
      expect(cell.steps.map((s) => s.root)).toContain(v.provedRoot);
      expect(proofHolds(record, cell.tier, BigInt(v.provedRoot!))).toBe(true);
    }
  });

  test.each(V.postings.map((p) => [p.id, p] as const))("posting %s", (_, p) => {
    const ballot = hex(ballots.get(p.ballot)!.encoding);
    const posting = hex(p.posting);
    const root = p.root === undefined ? undefined : BigInt(p.root);
    expect(p.call).toBe(root === undefined ? "submitPosting" : "submitRollingPosting");
    expect(postingCall(posting, ballot, root, p.registered)).toEqual(resultOf(p));
    if (p.snarkjs !== undefined) {
      const b = decodeV5(ballot);
      const tier = recordsElection(toHex(b.definition_hash))!.cells[b.cell]!.tier;
      expect(proofHolds(ballot, tier, root!)).toBe(p.snarkjs);
    }
    if (!("result" in p)) return;
    // An accepted posting is a real delivery: it passes the public posting
    // check of ballot version 4, which version 5 keeps, at its own seat.
    const fields = decodeSharePosting(posting, 2);
    const b = decodeV5(ballot);
    const key = decode(KEM_PUBLIC_KEY, hex(seatsOf(fields.panel)[fields.seat - 1]!.kemKey));
    expect(
      checkPostingV4(
        { definitionHash: b.definition_hash },
        fields.panel,
        fields.seat,
        key,
        b.committed_vote,
        { ciphertext: posting.subarray(CIPHERTEXT_AT), m: fields.m },
      ),
    ).toEqual({ ok: true });
    // What the verifier makes of the ballot on its own path: a supplied root
    // that isn't the named step's is root-step-mismatch, which the board
    // can't see (Rolling postings, The root decides nothing a verifier reads).
    const steps = recordsElection(toHex(b.definition_hash))!.cells[b.cell]!.steps;
    const named = steps.find((s) => s.step === b.step)!.root;
    expect(p.rootCheck).toBe(named === p.root ? "match" : "root-step-mismatch");
  });

  test("the file covers every step of the call, on both its paths", () => {
    const codes = new Set(V.postings.map((p) => ("code" in p ? `${p.check}/${p.code}` : "ok")));
    expect([...codes].sort()).toEqual(
      [
        "ok",
        "delivery/delivery-stray",
        "delivery/profile-mismatch",
        "delivery/delivery-seat",
        "delivery/posting-length",
        "ballot/ballot-stray",
        "ballot/profile-mismatch",
        "ballot/unknown-version",
        "ballot/validity-shape",
        "ballot/ballot-cell",
        "ballot/share-hash-unqualified",
        "ballot/membership-proof",
        "delivery/posting-ballot",
        "delivery/posting-hash",
      ].sort(),
    );
    // A root the board accepts and the verifier rejects, and the roots no
    // proof can be made against.
    expect(V.postings.some((p) => p.rootCheck === "root-step-mismatch")).toBe(true);
    // A root at or above r is refused, never reduced: the aliased root's
    // reduction is the step's own, which the proof holds against.
    const aliased = V.postings.find((p) => p.id === "membership-root-aliased")!;
    const dan = hex(ballots.get(aliased.ballot)!.encoding);
    expect(BigInt(aliased.root!)).toBeGreaterThanOrEqual(R);
    expect(proofHolds(dan, 0, BigInt(aliased.root!) % R)).toBe(true);
    for (const r of ["0", R.toString(), aliased.root!, (2n ** 256n - 1n).toString()])
      expect(V.postings.find((p) => p.root === r && "code" in p)).toMatchObject({
        code: "membership-proof",
      });
  });

  test("calldata: the canonical encoding carries the case's arguments, and no other encoding passes", () => {
    for (const c of V.calldata)
      expect(rollingCalldata(hex(c.calldata)) !== undefined).toBe(c.canonical);
    const canonical = V.calldata.find((c) => c.canonical)!;
    const args = rollingCalldata(hex(canonical.calldata))!;
    const ok = V.postings.find((p) => p.id === "ok-default-1")!;
    expect(String(args.root)).toBe(ok.root);
    expect(toHex(args.posting)).toBe(ok.posting);
    expect(toHex(args.ballot)).toBe(ballots.get(ok.ballot)!.encoding);
  });

  test.each(V.records.map((r) => [r.id, r] as const))("record %s through its call", (_, r) => {
    const type = CALL_TYPES[r.call];
    let result: Result = { result: "accepted" };
    for (const [position, enc] of r.records.entries()) {
      const d = deliverySteps(hex(enc), type);
      if (d !== undefined) {
        result = { check: "delivery", ...d, position };
        break;
      }
    }
    expect(result).toEqual(resultOf(r));
  });
});
