// Recovering the voting identity on a new device (src/recovery.ts; ADR 0017,
// option A, step 6; docs/spec/identity-backup.md, Opening): a recovery's
// steps against a stand-in authenticator, with the real worker session's
// locator and open over a group registry log made in tests/poll.ts, the
// envelope sealed here by @abolishus/crypto (T-11, T-18, T-20, T-41).

import { sealIdentityBackup } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import type { Credentials } from "../src/backup.ts";
import type { BackupCredential, IdentityRead } from "../src/identity.ts";
import type { LoadedRegistry } from "../src/load.ts";
import { recover, type RecoverySteps } from "../src/recovery.ts";
import { PROTOCOL_VERSION } from "../src/worker/protocol.ts";
import { BallotSession } from "../src/worker/session.ts";
import {
  cellLeaves,
  definition,
  GROUP,
  members,
  OTHER_GROUP,
  registrars,
  registryWith,
} from "./poll.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const RP_ID = "ballot-staging.up.railway.app";
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const zeroed = (b: Uint8Array) => b.every((x) => x === 0);

const UV = 0x04;
const BE = 0x08;
const BS = 0x10;

const PRF = new Uint8Array(32).fill(0x33);
const RAW_ID = new Uint8Array(32).fill(0x44);
// Every member but members[0] is in GROUP (region 3) in this log, from block 20 (tests/poll.ts).
const REGISTRY: LoadedRegistry = {
  ok: true,
  block: 1_000n,
  timestamp: 0n,
  records: registryWith(cellLeaves.slice(1)),
};
const SECRET = members[2] as Uint8Array;

interface Answer {
  readonly flags?: number;
  /** The PRF's `results.first`; `null` for none. */
  readonly prf?: Uint8Array | null;
}

/** A stand-in authenticator for evaluations: answers as told and records the options it was given. */
function authenticator(answer: Answer | Error = {}) {
  const got: CredentialRequestOptions[] = [];
  const handed: ArrayBuffer[] = [];
  const credentials: Credentials = {
    create: () => Promise.reject(new Error("a recovery makes no passkey")),
    get: async (options) => {
      got.push(options as CredentialRequestOptions);
      if (answer instanceof Error) throw answer;
      const data = new Uint8Array(37);
      data[32] = 0x01 | (answer.flags ?? UV | BE | BS);
      const first = answer.prf === null ? undefined : (answer.prf ?? PRF).slice().buffer;
      if (first !== undefined) handed.push(first);
      return {
        type: "public-key",
        rawId: RAW_ID.slice().buffer,
        response: { authenticatorData: data.buffer },
        getClientExtensionResults: () => ({
          prf: first === undefined ? {} : { results: { first } },
        }),
      } as unknown as Credential;
    },
  };
  return { credentials, got, handed };
}

/** A recovery's steps over the real worker session, recording what each was given. */
function steps(
  options: {
    held?: IdentityRead["kind"];
    answer?: Answer | Error;
    secret?: Uint8Array;
    sealedWith?: Uint8Array;
    fetch?: "found" | "other" | "not-found" | "unreachable";
    registry?: LoadedRegistry;
    worker?: "fails" | "another";
    restore?: "restored" | "exists" | "unwritable";
  } = {},
) {
  const auth = authenticator(options.answer);
  const session = new BallotSession();
  const { locator: stored, envelope } = sealIdentityBackup(
    options.sealedWith ?? PRF,
    (options.secret ?? SECRET).slice(),
  );
  const order: string[] = [];
  const handedPrf: Uint8Array[] = [];
  const restored: { secret: Uint8Array; given: Uint8Array; group: bigint }[] = [];
  const kept: BackupCredential[] = [];
  const s: RecoverySteps = {
    credentials: auth.credentials,
    rpId: RP_ID,
    identity: async () => {
      order.push("identity");
      const kind = options.held ?? "none";
      if (kind !== "found") return { kind };
      return { kind, identity: { secret: SECRET.slice(), memberships: [] } };
    },
    locate: async (prf) => {
      order.push("locate");
      handedPrf.push(prf);
      if (options.worker === "fails") throw new Error("the ballot worker failed");
      // As postMessage does: the worker gets a copy.
      return session.backupLocator({
        v: PROTOCOL_VERSION,
        id: 1,
        kind: "backup-locator",
        prf: prf.slice(),
      });
    },
    fetch: async (locator) => {
      order.push("fetch");
      const kind = options.fetch ?? "found";
      if (kind === "not-found" || kind === "unreachable") return { kind };
      if (toHex(locator) !== toHex(stored)) return { kind: "not-found" };
      const bytes = envelope.slice();
      if (kind === "other") bytes[62] = (bytes[62] as number) ^ 1;
      return { kind: "found", envelope: bytes };
    },
    registry: async () => {
      order.push("registry");
      return options.registry ?? REGISTRY;
    },
    open: async (bytes, { block, records }) => {
      order.push("open");
      const opener = options.worker === "another" ? new BallotSession() : session;
      return opener.backupOpen({
        v: PROTOCOL_VERSION,
        id: 2,
        kind: "backup-open",
        envelope: bytes,
        block,
        groups: [
          { group_id: GROUP, region: 3 },
          { group_id: OTHER_GROUP, region: 7 },
        ],
        records,
        registry: definition.group_registry,
        chainId: definition.l2_chain_id,
        version: 13,
        ...registrars,
      });
    },
    restore: async (secret, group) => {
      order.push("restore");
      restored.push({ secret, given: secret.slice(), group });
      return options.restore ?? "restored";
    },
    keep: async (credential) => {
      order.push("keep");
      kept.push(credential);
      return "saved";
    },
  };
  return { s, auth, order, handedPrf, restored, kept };
}

describe("recover", () => {
  test("evaluates any discoverable backup passkey, opens its envelope, and keeps the identity in the group counting it, and the passkey", async () => {
    const t = steps();
    expect(await recover(t.s)).toEqual({
      kind: "restored",
      group: GROUP,
      region: 3,
      syncable: true,
      backedUp: true,
    });
    expect(t.order).toEqual(["identity", "locate", "fetch", "registry", "open", "restore", "keep"]);
    // Discoverable: no credential allowed, so any of the RP ID's passkeys may answer.
    expect(t.auth.got).toHaveLength(1);
    expect(t.auth.got[0]?.publicKey?.allowCredentials).toEqual([]);
    expect(t.auth.got[0]?.publicKey?.rpId).toBe(RP_ID);
    expect(t.auth.got[0]?.publicKey?.userVerification).toBe("required");
    expect(t.restored).toHaveLength(1);
    expect(toHex(t.restored[0]?.given as Uint8Array)).toBe(toHex(SECRET));
    expect(t.restored[0]?.group).toBe(GROUP);
    // No stored time: the device didn't store the envelope, so the offer asks to renew it.
    expect(t.kept).toEqual([{ credentialId: RAW_ID, backedUp: true }]);
    // The page's copies of the PRF output and the secret are zeroed, and the browser's.
    expect(t.handedPrf.every(zeroed)).toBe(true);
    expect(t.auth.handed.every((b) => zeroed(new Uint8Array(b)))).toBe(true);
    expect(zeroed(t.restored[0]?.secret as Uint8Array)).toBe(true);
  });

  test("recovers any registered identity sealed under any PRF output", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.constantFrom(members[1] as Uint8Array, members[2] as Uint8Array),
        async (prf, secret) => {
          const t = steps({ answer: { prf }, sealedWith: prf, secret });
          expect(await recover(t.s)).toMatchObject({ kind: "restored", group: GROUP });
          expect(toHex(t.restored[0]?.given as Uint8Array)).toBe(toHex(secret));
        },
      ),
      { numRuns: Math.min(numRuns, 20) },
    );
  });

  test("reports a passkey that can't sync, or isn't synced yet", async () => {
    expect(await recover(steps({ answer: { flags: UV } }).s)).toMatchObject({
      syncable: false,
      backedUp: false,
    });
    const t = steps({ answer: { flags: UV | BE } });
    expect(await recover(t.s)).toMatchObject({ syncable: true, backedUp: false });
    expect(t.kept).toEqual([{ credentialId: RAW_ID, backedUp: false }]);
  });

  test.each([
    ["found", "exists"],
    ["unreadable", "unreadable"],
  ] as const)(
    "a device holding an identity (%s) runs no ceremony and replaces nothing",
    async (held, problem) => {
      const t = steps({ held });
      expect(await recover(t.s)).toEqual({ kind: "stopped", problem });
      expect(t.auth.got).toHaveLength(0);
      expect(t.order).toEqual(["identity"]);
    },
  );

  test.each([
    ["a cancelled ceremony", new DOMException("closed", "NotAllowedError"), "cancelled"],
    ["another error", new Error("nope"), "failed"],
    ["no PRF", { prf: null }, "no-prf"],
    ["no user verification", { flags: BE | BS }, "no-uv"],
  ] as const)("%s stops before the worker sees anything", async (_, answer, problem) => {
    const t = steps({ answer });
    expect(await recover(t.s)).toEqual({ kind: "stopped", problem });
    expect(t.order).toEqual(["identity"]);
    expect(t.auth.handed.every((b) => zeroed(new Uint8Array(b)))).toBe(true);
  });

  test("a worker that fails at the locator stops the recovery, with the PRF output zeroed", async () => {
    const t = steps({ worker: "fails" });
    expect(await recover(t.s)).toEqual({ kind: "stopped", problem: "worker-failed" });
    expect(t.handedPrf.every(zeroed)).toBe(true);
    expect(t.order).toEqual(["identity", "locate"]);
  });

  test("no envelope for this passkey asks for another; an unreachable route says so", async () => {
    for (const [fetch, problem] of [
      ["not-found", "no-backup"],
      ["unreachable", "unreachable"],
    ] as const) {
      const t = steps({ fetch });
      expect(await recover(t.s)).toEqual({ kind: "stopped", problem });
      expect(t.order).toEqual(["identity", "locate", "fetch"]);
    }
    // An envelope stored under another passkey's locator isn't this one's.
    const t = steps({ sealedWith: new Uint8Array(32).fill(0x34) });
    expect(await recover(t.s)).toEqual({ kind: "stopped", problem: "no-backup" });
  });

  test("an envelope that doesn't open is damaged, and nothing is kept", async () => {
    const t = steps({ fetch: "other" });
    expect(await recover(t.s)).toEqual({ kind: "stopped", problem: "damaged" });
    expect(t.restored).toHaveLength(0);
    expect(t.kept).toHaveLength(0);
  });

  test("a registry not read, or a history the release's registrars didn't log, stops before the open keeps anything", async () => {
    const t = steps({ registry: { ok: false, problem: "unreachable" } });
    expect(await recover(t.s)).toEqual({
      kind: "stopped",
      problem: "registry",
      load: "unreachable",
    });
    expect(t.order).not.toContain("open");
    const records = REGISTRY.ok ? REGISTRY.records : [];
    const refused = steps({
      registry: { ...REGISTRY, records: [new Uint8Array([0, 8]), ...records.slice(1)] },
    });
    expect(await recover(refused.s)).toEqual({ kind: "stopped", problem: "registry-refused" });
    expect(refused.restored).toHaveLength(0);
  });

  test("an identity counted in no published group is never kept", async () => {
    for (const t of [
      steps({ secret: members[0] as Uint8Array }),
      // Read before its addition landed (block 20).
      steps({ registry: { ...REGISTRY, block: 19n } }),
    ]) {
      expect(await recover(t.s)).toEqual({ kind: "stopped", problem: "not-registered" });
      expect(t.restored).toHaveLength(0);
      expect(t.kept).toHaveLength(0);
    }
  });

  test("an open in another worker than the locator's fails, never opening with a stale PRF output", async () => {
    const t = steps({ worker: "another" });
    expect(await recover(t.s)).toEqual({ kind: "stopped", problem: "worker-failed" });
    expect(t.restored).toHaveLength(0);
  });

  test("an identity the device came to hold meanwhile, or a store refused, stops with the secret zeroed and no passkey kept", async () => {
    for (const restore of ["exists", "unwritable"] as const) {
      const t = steps({ restore });
      expect(await recover(t.s)).toEqual({ kind: "stopped", problem: restore });
      expect(zeroed(t.restored[0]?.secret as Uint8Array)).toBe(true);
      expect(t.kept).toHaveLength(0);
    }
  });
});
