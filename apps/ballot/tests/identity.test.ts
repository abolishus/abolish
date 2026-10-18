import { BABYJUBJUB_ORDER } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  type BackupCredential,
  type Membership,
  parseStoredBackupCredential,
  parseStoredIdentity,
  storedBackupCredential,
  storedIdentity,
  type VotingIdentity,
} from "../src/identity.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const be32 = (n: bigint) =>
  Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 0xffn));

const secret = fc.bigInt({ min: 1n, max: BABYJUBJUB_ORDER - 1n }).map(be32);

// None to three memberships, at most one per tier, in ascending order of tier.
const memberships = fc
  .subarray([0, 1, 2])
  .chain((tiers) =>
    fc.tuple(
      ...tiers.map((tier) =>
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map((group) => ({ tier, group })),
      ),
    ),
  );

const tier0Request = fc.record({
  region: fc.nat({ max: 0xffff_ffff }),
  acceptedAt: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
});

// A Tier 0 request only while there is no Tier 0 membership, and the
// recovered flag only beside one.
const identity = fc
  .tuple(secret, memberships, fc.option(tier0Request, { nil: undefined }), fc.boolean())
  .map(([secret, memberships, request, recovered]): VotingIdentity =>
    memberships[0]?.tier === 0
      ? recovered
        ? { secret, memberships, recovered: true }
        : { secret, memberships }
      : request === undefined
        ? { secret, memberships }
        : { secret, memberships, tier0Request: request },
  );

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 3,
  secret: be32(7n),
  memberships: [{ tier: 0, group: 5n }],
  tier0Request: null,
  recovered: false,
  ...over,
});

// oxlint-disable-next-line no-sparse-arrays -- a hole is what is refused
const HOLED = [{ tier: 0, group: 5n }, , { tier: 2, group: 1n }];

describe("parseStoredIdentity", () => {
  test("reads back exactly what storedIdentity stores", () => {
    fc.assert(
      fc.property(identity, (id: VotingIdentity) => {
        const back = parseStoredIdentity(storedIdentity(id));
        expect(back).toEqual(id);
      }),
      { numRuns },
    );
  });

  test("reads a fresh identity with no membership, waiting or not on a Tier 0 request", () => {
    expect(parseStoredIdentity(record({ memberships: [] }))).toEqual({
      secret: be32(7n),
      memberships: [],
    });
    const tier0Request = { region: 4_294_967_295, acceptedAt: 1_760_000_000_000 };
    expect(
      parseStoredIdentity(record({ memberships: [{ tier: 1, group: 2n }], tier0Request })),
    ).toEqual({ secret: be32(7n), memberships: [{ tier: 1, group: 2n }], tier0Request });
  });

  test("reads a recovered identity beside its Tier 0 membership, with its other tiers", () => {
    expect(parseStoredIdentity(record({ recovered: true }))).toEqual({
      secret: be32(7n),
      memberships: [{ tier: 0, group: 5n }],
      recovered: true,
    });
    const memberships = [
      { tier: 0, group: 5n },
      { tier: 2, group: 1n },
    ];
    expect(parseStoredIdentity(record({ memberships, recovered: true }))).toEqual({
      secret: be32(7n),
      memberships,
      recovered: true,
    });
  });

  test("hands out a copy of the secret, so zeroing it leaves the stored value whole", () => {
    const stored = record();
    const back = parseStoredIdentity(stored);
    back?.secret.fill(0);
    expect(stored["secret"]).toEqual(be32(7n));
  });

  test.each<[string, unknown]>([
    ["not an object", "voter"],
    ["null", null],
    ["an array", [1, be32(7n), []]],
    ["version 1", { v: 1, secret: be32(7n), memberships: [{ tier: 0, group: 5n }] }],
    ["version 1 with this version's keys", record({ v: 1 })],
    ["version 2", { v: 2, secret: be32(7n), memberships: [], tier0Request: null }],
    ["version 2 with this version's keys", record({ v: 2 })],
    ["another version", record({ v: 4 })],
    ["a version as a string", record({ v: "3" })],
    ["an extra key", record({ receipts: [] })],
    ["a missing key", { v: 3, secret: be32(7n), memberships: [] }],
    ["no request key", { v: 3, secret: be32(7n), memberships: [], recovered: false }],
    ["no recovered key", { v: 3, secret: be32(7n), memberships: [], tier0Request: null }],
    ["a recovered flag as a number", record({ recovered: 1 })],
    ["a recovered flag as a string", record({ recovered: "true" })],
    ["a recovered flag as null", record({ recovered: null })],
    ["recovered with no membership", record({ memberships: [], recovered: true })],
    [
      "recovered with no Tier 0 membership",
      record({ memberships: [{ tier: 1, group: 2n }], recovered: true }),
    ],
    [
      "recovered beside a Tier 0 request",
      record({
        memberships: [{ tier: 1, group: 2n }],
        tier0Request: { region: 0, acceptedAt: 0 },
        recovered: true,
      }),
    ],
    ["a secret of 0", record({ secret: be32(0n) })],
    ["a secret of l", record({ secret: be32(BABYJUBJUB_ORDER) })],
    ["a secret above l", record({ secret: be32(2n ** 256n - 1n) })],
    ["a short secret", record({ secret: new Uint8Array(31).fill(1) })],
    ["a long secret", record({ secret: new Uint8Array(33).fill(1) })],
    ["a secret that isn't bytes", record({ secret: Array.from(be32(7n)) })],
    ["a secret as an ArrayBuffer", record({ secret: be32(7n).buffer })],
    ["memberships that aren't a list", record({ memberships: { tier: 0, group: 5n } })],
    [
      "four memberships",
      record({
        memberships: [0, 1, 2, 2].map((tier) => ({ tier, group: 1n })),
      }),
    ],
    [
      "memberships out of order",
      record({
        memberships: [
          { tier: 1, group: 1n },
          { tier: 0, group: 2n },
        ],
      }),
    ],
    [
      "two in one tier",
      record({
        memberships: [
          { tier: 0, group: 1n },
          { tier: 0, group: 2n },
        ],
      }),
    ],
    ["a tier the brief doesn't have", record({ memberships: [{ tier: 3, group: 1n }] })],
    ["a fractional tier", record({ memberships: [{ tier: 0.5, group: 1n }] })],
    ["a tier as a string", record({ memberships: [{ tier: "0", group: 1n }] })],
    ["a negative group", record({ memberships: [{ tier: 0, group: -1n }] })],
    ["a group past u64", record({ memberships: [{ tier: 0, group: 2n ** 64n }] })],
    ["a group as a number", record({ memberships: [{ tier: 0, group: 5 }] })],
    [
      "a membership with an extra key",
      record({ memberships: [{ tier: 0, group: 5n, region: 0 }] }),
    ],
    ["a membership with a missing key", record({ memberships: [{ tier: 0 }] })],
    ["a list with a hole", record({ memberships: HOLED })],
    ["a tier of -0", record({ memberships: [{ tier: -0, group: 1n }] })],
    [
      "a list with a property beside its entries",
      record({ memberships: Object.assign([{ tier: 0, group: 1n }], { extra: 1 }) }),
    ],
    [
      "a Tier 0 request beside a Tier 0 membership",
      record({ tier0Request: { region: 0, acceptedAt: 0 } }),
    ],
    ...(
      [
        ["a request that isn't an object", 0],
        ["a request as undefined", undefined],
        ["a request with an extra key", { region: 0, acceptedAt: 0, group: 5n }],
        ["a request with a missing key", { region: 0 }],
        ["a negative region", { region: -1, acceptedAt: 0 }],
        ["a region past u32", { region: 2 ** 32, acceptedAt: 0 }],
        ["a fractional region", { region: 0.5, acceptedAt: 0 }],
        ["a region of -0", { region: -0, acceptedAt: 0 }],
        ["a region as a string", { region: "0", acceptedAt: 0 }],
        ["a region as a bigint", { region: 0n, acceptedAt: 0 }],
        ["a negative time", { region: 0, acceptedAt: -1 }],
        ["a time of -0", { region: 0, acceptedAt: -0 }],
        ["a time past safe integers", { region: 0, acceptedAt: 2 ** 53 }],
        ["a fractional time", { region: 0, acceptedAt: 1.5 }],
        ["a time as a Date", { region: 0, acceptedAt: new Date(0) }],
      ] as const
    ).map(([what, tier0Request]): [string, unknown] => [
      what,
      record({ memberships: [], tier0Request }),
    ]),
  ])("refuses %s", (_, value) => {
    expect(parseStoredIdentity(value)).toBeUndefined();
  });

  test("refuses any secret at or above l, and any of the wrong length", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.bigInt({ min: BABYJUBJUB_ORDER, max: 2n ** 256n - 1n }).map(be32),
          fc.uint8Array({ maxLength: 64 }).filter((b) => b.length !== 32),
        ),
        (bytes) => {
          expect(parseStoredIdentity(record({ secret: bytes }))).toBeUndefined();
        },
      ),
      { numRuns },
    );
  });

  test("refuses any membership list out of order or with a repeated tier", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(0, 1, 2), { minLength: 2, maxLength: 3 })
          .filter((tiers) => tiers.some((t, i) => i > 0 && t <= (tiers[i - 1] as number))),
        (tiers) => {
          const list: Membership[] = tiers.map((tier) => ({ tier, group: 1n }));
          expect(parseStoredIdentity(record({ memberships: list }))).toBeUndefined();
        },
      ),
      { numRuns },
    );
  });
});

describe("storedIdentity", () => {
  test("refuses to store what it couldn't read back", () => {
    expect(() =>
      storedIdentity({ secret: be32(0n), memberships: [{ tier: 0, group: 1n }] }),
    ).toThrow(TypeError);
    expect(() =>
      storedIdentity({
        secret: be32(7n),
        memberships: [{ tier: 0, group: 1n }],
        tier0Request: { region: 0, acceptedAt: 0 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      storedIdentity({
        secret: be32(7n),
        memberships: [],
        tier0Request: { region: 2 ** 32, acceptedAt: 0 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      storedIdentity({ secret: be32(7n), memberships: [{ tier: 1, group: 1n }], recovered: true }),
    ).toThrow(TypeError);
  });

  test("stores copies, so the caller's secret can be zeroed", () => {
    const mine = be32(7n);
    const stored = storedIdentity({ secret: mine, memberships: [{ tier: 0, group: 1n }] });
    mine.fill(0);
    expect(stored["secret"]).toEqual(be32(7n));
  });
});

// The backup passkey's record, kept beside the identity under its own key.
const backupCredential = fc
  .tuple(
    fc.uint8Array({ minLength: 16, maxLength: 1023 }),
    fc.boolean(),
    fc.option(fc.nat({ max: Number.MAX_SAFE_INTEGER }), { nil: undefined }),
  )
  .map(([credentialId, backedUp, storedAt]): BackupCredential =>
    storedAt === undefined ? { credentialId, backedUp } : { credentialId, backedUp, storedAt },
  );

const backupRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  credentialId: new Uint8Array(16).fill(4),
  backedUp: true,
  storedAt: null,
  ...over,
});

describe("parseStoredBackupCredential", () => {
  test("reads back exactly what storedBackupCredential stores, as a copy", () => {
    fc.assert(
      fc.property(backupCredential, (credential) => {
        const record = storedBackupCredential(credential);
        const back = parseStoredBackupCredential(record);
        expect(back).toEqual(credential);
        (record["credentialId"] as Uint8Array).fill(0xff);
        expect(back?.credentialId).toEqual(credential.credentialId);
      }),
      { numRuns },
    );
  });

  test.each<[string, unknown]>([
    ["another version", backupRecord({ v: 2 })],
    ["a credential ID of 15 bytes", backupRecord({ credentialId: new Uint8Array(15) })],
    ["a credential ID of 1,024 bytes", backupRecord({ credentialId: new Uint8Array(1024) })],
    ["a credential ID as an ArrayBuffer", backupRecord({ credentialId: new ArrayBuffer(16) })],
    ["a credential ID as a list", backupRecord({ credentialId: Array(16).fill(4) })],
    ["a flag that isn't a boolean", backupRecord({ backedUp: 1 })],
    ["a negative time", backupRecord({ storedAt: -1 })],
    ["-0 as a time", backupRecord({ storedAt: -0 })],
    ["a fractional time", backupRecord({ storedAt: 1.5 })],
    ["a time past 2^53", backupRecord({ storedAt: 2 ** 53 })],
    ["a time as a string", backupRecord({ storedAt: "1" })],
    ["an extra key", backupRecord({ extra: true })],
    ["a list", [backupRecord()]],
    ["null", null],
  ])("refuses %s", (_, value) => {
    expect(parseStoredBackupCredential(value)).toBeUndefined();
  });

  test("refuses a record without one of its keys", () => {
    for (const key of Object.keys(backupRecord())) {
      const r = backupRecord();
      delete r[key];
      expect(parseStoredBackupCredential(r)).toBeUndefined();
    }
  });

  test("storedBackupCredential refuses to store what it couldn't read back", () => {
    expect(() =>
      storedBackupCredential({ credentialId: new Uint8Array(8), backedUp: true }),
    ).toThrow(TypeError);
    expect(() =>
      storedBackupCredential({
        credentialId: new Uint8Array(16),
        backedUp: false,
        storedAt: -5,
      }),
    ).toThrow(TypeError);
  });
});
