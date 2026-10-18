import { BABYJUBJUB_ORDER, identityBackupLocator, openIdentityBackup } from "@abolishus/crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  authenticatorFlags,
  BACKUP_USER_NAME,
  backupCreationOptions,
  backupRequestOptions,
  type BackupSteps,
  backUp,
  createBackupPasskey,
  type Credentials,
  evaluateBackupPasskey,
  fetchIdentityBackup,
  putIdentityBackup,
} from "../src/backup.ts";
import type { BackupCredential, BackupCredentialRead, IdentityRead } from "../src/identity.ts";
import { PROTOCOL_VERSION } from "../src/worker/protocol.ts";
import { BallotSession } from "../src/worker/session.ts";

// The backup passkey and the backup (src/backup.ts; ADR 0017, option A;
// docs/spec/identity-backup.md): the ceremonies' options, what the client
// accepts of their answers, the request that stores the envelope, and a
// backup's steps against a stand-in authenticator, with the real worker
// session's seal, opened here by @abolishus/crypto (T-10, T-18, T-20, T-41).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/identity-backup.json", import.meta.url), "utf8"),
) as { prfSalt: string };

const RP_ID = "ballot-staging.up.railway.app";
const API = "https://api-staging.abolish.us";
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const be32 = (n: bigint) =>
  Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 0xffn));
const zeroed = (b: Uint8Array) => b.every((x) => x === 0);

const UV = 0x04;
const BE = 0x08;
const BS = 0x10;

/** Authenticator data: an RP ID hash, the flags (UP and `flags`) and a zero counter. */
const authData = (flags: number) => {
  const data = new Uint8Array(37);
  data[32] = 0x01 | flags;
  return data.buffer;
};

interface Answer {
  readonly rawId?: Uint8Array;
  readonly flags?: number;
  /** The PRF's `results.first`; `null` for no results at all. */
  readonly prf?: Uint8Array | null;
  readonly enabled?: boolean;
}

/** A stand-in authenticator: answers each ceremony as told and records the options it was given. */
function authenticator(answers: { create?: Answer | Error; get?: Answer | Error } = {}) {
  const created: CredentialCreationOptions[] = [];
  const got: CredentialRequestOptions[] = [];
  const handed: ArrayBuffer[] = [];
  const credential = (answer: Answer, create: boolean) => {
    const rawId = (answer.rawId ?? new Uint8Array(16).fill(9)).slice().buffer;
    const data = authData(answer.flags ?? UV | BE | BS);
    const first =
      answer.prf === null ? undefined : (answer.prf ?? new Uint8Array(32).fill(5)).slice().buffer;
    if (first !== undefined) handed.push(first);
    const prf = {
      ...(create && { enabled: answer.enabled ?? true }),
      ...(first !== undefined && { results: { first } }),
    };
    return {
      type: "public-key",
      rawId,
      response: create ? { getAuthenticatorData: () => data } : { authenticatorData: data },
      getClientExtensionResults: () => ({ prf }),
    };
  };
  const credentials: Credentials = {
    create: async (options) => {
      created.push(options as CredentialCreationOptions);
      const answer = answers.create ?? {};
      if (answer instanceof Error) throw answer;
      return credential(answer, true) as unknown as Credential;
    },
    get: async (options) => {
      got.push(options as CredentialRequestOptions);
      const answer = answers.get ?? {};
      if (answer instanceof Error) throw answer;
      return credential(answer, false) as unknown as Credential;
    },
  };
  return { credentials, created, got, handed };
}

describe("the ceremonies' options", () => {
  test("a creation asks for a discoverable, user-verified passkey of the RP ID, naming no one, with the spec's PRF salt", () => {
    const handle = new Uint8Array(32).fill(1);
    const challenge = new Uint8Array(32).fill(2);
    const { publicKey } = backupCreationOptions(RP_ID, handle, challenge);
    expect(publicKey?.rp).toEqual({ id: RP_ID, name: "Abolish ballot" });
    expect(publicKey?.user).toEqual({
      id: handle,
      name: BACKUP_USER_NAME,
      displayName: BACKUP_USER_NAME,
    });
    expect(publicKey?.challenge).toEqual(challenge);
    expect(publicKey?.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(publicKey?.attestation).toBe("none");
    expect(publicKey?.excludeCredentials).toBeUndefined();
    const first = publicKey?.extensions?.prf?.eval?.first as Uint8Array;
    expect(toHex(first)).toBe(VECTORS.prfSalt);
  });

  test("an evaluation allows the kept credential alone, or any discoverable one, with user verification and the salt", () => {
    const id = new Uint8Array(20).fill(3);
    const challenge = new Uint8Array(32).fill(4);
    const kept = backupRequestOptions(RP_ID, challenge, id).publicKey;
    expect(kept?.rpId).toBe(RP_ID);
    expect(kept?.userVerification).toBe("required");
    expect(kept?.allowCredentials).toEqual([{ type: "public-key", id }]);
    expect(toHex(kept?.extensions?.prf?.eval?.first as Uint8Array)).toBe(VECTORS.prfSalt);
    expect(backupRequestOptions(RP_ID, challenge, undefined).publicKey?.allowCredentials).toEqual(
      [],
    );
  });
});

describe("authenticatorFlags", () => {
  test("reads UV, BE and BS from the flags byte, refusing short data and BS without BE", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (data) => {
        const flags = authenticatorFlags(data);
        const byte = data[32] ?? 0;
        if (data.length < 37 || ((byte & BS) !== 0 && (byte & BE) === 0))
          expect(flags).toBeUndefined();
        else
          expect(flags).toEqual({
            uv: (byte & UV) !== 0,
            be: (byte & BE) !== 0,
            bs: (byte & BS) !== 0,
          });
      }),
      { numRuns },
    );
  });
});

describe("createBackupPasskey", () => {
  test("a passkey that answers the PRF at creation gives it, and the browser's copy is zeroed", async () => {
    const prf = new Uint8Array(32).fill(7);
    const rawId = new Uint8Array(24).fill(8);
    const { credentials, created, handed } = authenticator({ create: { rawId, prf } });
    const result = await createBackupPasskey(credentials, RP_ID);
    expect(result).toEqual({
      ok: true,
      credentialId: rawId,
      flags: { uv: true, be: true, bs: true },
      prf,
    });
    expect(handed.every((b) => zeroed(new Uint8Array(b)))).toBe(true);
    expect(created[0]?.publicKey?.rp.id).toBe(RP_ID);
  });

  test("each creation draws a fresh user handle and challenge", async () => {
    const { credentials, created } = authenticator();
    await createBackupPasskey(credentials, RP_ID);
    await createBackupPasskey(credentials, RP_ID);
    const [a, b] = created.map((o) => o.publicKey);
    expect(toHex(a?.user.id as Uint8Array)).not.toBe(toHex(b?.user.id as Uint8Array));
    expect(toHex(a?.challenge as Uint8Array)).not.toBe(toHex(b?.challenge as Uint8Array));
    expect(a?.user.id).toHaveProperty("length", 32);
  });

  test("a PRF enabled but not answered at creation is left to an evaluation", async () => {
    const { credentials } = authenticator({ create: { prf: null, enabled: true } });
    const result = await createBackupPasskey(credentials, RP_ID);
    expect(result.ok && result.prf).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  test.each<[string, Answer | Error, string]>([
    ["no PRF support", { prf: null, enabled: false }, "no-prf"],
    ["no user verification", { flags: BE | BS }, "no-uv"],
    ["a PRF output of 31 bytes", { prf: new Uint8Array(31) }, "failed"],
    ["a PRF output of 33 bytes", { prf: new Uint8Array(33) }, "failed"],
    ["BS without BE", { flags: UV | BS }, "failed"],
    ["a credential ID of 15 bytes", { rawId: new Uint8Array(15) }, "failed"],
    ["a credential ID of 1,024 bytes", { rawId: new Uint8Array(1024) }, "failed"],
    ["the voter cancelling", new DOMException("no", "NotAllowedError"), "cancelled"],
    ["an excluded credential", new DOMException("no", "InvalidStateError"), "failed"],
    ["any other error", new TypeError("no"), "failed"],
  ])("%s is refused", async (_, answer, problem) => {
    const { credentials, handed } = authenticator({ create: answer });
    expect(await createBackupPasskey(credentials, RP_ID)).toEqual({ ok: false, problem });
    expect(handed.every((b) => zeroed(new Uint8Array(b)))).toBe(true);
  });

  test("an answer outside WebAuthn's forms is refused", async () => {
    for (const answer of [null, {}, { type: "password" }, { type: "public-key", rawId: "x" }]) {
      const credentials: Credentials = {
        create: async () => answer as Credential | null,
        get: async () => null,
      };
      expect(await createBackupPasskey(credentials, RP_ID)).toEqual({
        ok: false,
        problem: "failed",
      });
    }
  });
});

describe("evaluateBackupPasskey", () => {
  const rawId = new Uint8Array(16).fill(9);

  test("the kept credential's PRF, user verified, with its flags", async () => {
    const prf = new Uint8Array(32).fill(6);
    const { credentials, got, handed } = authenticator({ get: { rawId, prf, flags: UV | BE } });
    expect(await evaluateBackupPasskey(credentials, RP_ID, rawId)).toEqual({
      ok: true,
      credentialId: rawId,
      flags: { uv: true, be: true, bs: false },
      prf,
    });
    expect(got[0]?.publicKey?.allowCredentials).toEqual([{ type: "public-key", id: rawId }]);
    expect(handed.every((b) => zeroed(new Uint8Array(b)))).toBe(true);
  });

  test.each<[string, Answer | Error, string]>([
    ["another credential", { rawId: new Uint8Array(16).fill(1) }, "failed"],
    ["no PRF output", { rawId, prf: null }, "no-prf"],
    ["no user verification", { rawId, flags: BE }, "no-uv"],
    ["a PRF output of 16 bytes", { rawId, prf: new Uint8Array(16) }, "failed"],
    ["the voter cancelling", new DOMException("no", "NotAllowedError"), "cancelled"],
  ])("%s is refused", async (_, answer, problem) => {
    const { credentials, handed } = authenticator({ get: answer });
    expect(await evaluateBackupPasskey(credentials, RP_ID, rawId)).toEqual({ ok: false, problem });
    expect(handed.every((b) => zeroed(new Uint8Array(b)))).toBe(true);
  });

  test("with no kept credential, any discoverable credential of the RP ID answers", async () => {
    const other = new Uint8Array(40).fill(2);
    const { credentials, got } = authenticator({ get: { rawId: other } });
    const result = await evaluateBackupPasskey(credentials, RP_ID, undefined);
    expect(result.ok && result.credentialId).toEqual(other);
    expect(got[0]?.publicKey?.allowCredentials).toEqual([]);
  });
});

describe("putIdentityBackup", () => {
  const locator = new Uint8Array(32).fill(0xab);
  const envelope = new Uint8Array(63).fill(0x0a);
  const respond = (status: number, body: unknown) => async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  test("posts the locator and envelope as lowercase hex in the body, with no credential, referrer or redirect", async () => {
    const calls: [string, RequestInit][] = [];
    const answer = await putIdentityBackup({ api: API }, locator, envelope, async (url, init) => {
      calls.push([url, init]);
      return new Response("{}", { status: 200 });
    });
    expect(answer).toBe("stored");
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/backups`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      locator: "ab".repeat(32),
      envelope: "0a".repeat(63),
    });
  });

  test.each<[string, number, unknown, string]>([
    ["the route's refusal", 422, { code: "BACKUP_REJECTED" }, "rejected"],
    ["a body outside the route's forms", 400, { code: "BAD_REQUEST" }, "rejected"],
    ["another code at 422", 422, { code: "REGION_UNKNOWN" }, "unreachable"],
    ["the refusal at another status", 403, { code: "BACKUP_REJECTED" }, "unreachable"],
    ["a bare 400", 400, "Bad Request", "unreachable"],
    ["a 200 with a body", 200, { stored: true }, "unreachable"],
    ["a 200 with a list", 200, [], "unreachable"],
    ["a 200 that isn't JSON", 200, "<html>", "unreachable"],
    ["a proxy's 502", 502, "Bad Gateway", "unreachable"],
    ["an answer past 4 KiB", 200, " ".repeat(5000) + "{}", "unreachable"],
  ])("%s reads as %s", async (_, status, body, expected) => {
    expect(await putIdentityBackup({ api: API }, locator, envelope, respond(status, body))).toBe(
      expected,
    );
  });

  test("a network failure is unreachable", async () => {
    expect(
      await putIdentityBackup({ api: API }, locator, envelope, async () => {
        throw new TypeError("offline");
      }),
    ).toBe("unreachable");
  });
});

describe("fetchIdentityBackup", () => {
  const locator = new Uint8Array(32).fill(0xcd);
  const respond = (status: number, body: unknown) => async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  test("posts the locator in the body and reads the envelope back", async () => {
    const calls: [string, RequestInit][] = [];
    const answer = await fetchIdentityBackup({ api: API }, locator, async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ envelope: "0a".repeat(63) }), { status: 200 });
    });
    expect(answer).toEqual({ kind: "found", envelope: new Uint8Array(63).fill(0x0a) });
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/backups/fetch`);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(JSON.parse(init.body as string)).toEqual({ locator: "cd".repeat(32) });
  });

  test.each<[string, number, unknown, string]>([
    ["the route's not-found", 404, { code: "BACKUP_NOT_FOUND" }, "not-found"],
    ["a bare 404", 404, "Not Found", "unreachable"],
    ["not-found at another status", 422, { code: "BACKUP_NOT_FOUND" }, "unreachable"],
    ["an envelope of 62 bytes", 200, { envelope: "0a".repeat(62) }, "unreachable"],
    ["an envelope in uppercase hex", 200, { envelope: "0A".repeat(63) }, "unreachable"],
    ["an extra key", 200, { envelope: "0a".repeat(63), extra: 1 }, "unreachable"],
    ["an envelope at another status", 201, { envelope: "0a".repeat(63) }, "unreachable"],
    ["a list", 200, [], "unreachable"],
  ])("%s reads as %s", async (_, status, body, kind) => {
    expect(await fetchIdentityBackup({ api: API }, locator, respond(status, body))).toEqual({
      kind,
    });
  });
});

describe("backUp", () => {
  const SECRET = be32(BABYJUBJUB_ORDER - 2n);
  const PRF = new Uint8Array(32).fill(0x33);
  const RAW_ID = new Uint8Array(32).fill(0x44);

  /** A backup's steps over the real worker session, recording what each was given. */
  function steps(
    options: {
      held?: BackupCredentialRead;
      identity?: IdentityRead["kind"];
      create?: Answer | Error;
      get?: Answer | Error;
      keep?: "saved" | "unwritable";
      worker?: "fails";
      put?: "stored" | "rejected" | "unreachable";
      fetch?: "kept" | "other" | "not-found" | "unreachable";
    } = {},
  ) {
    const auth = authenticator({
      create: options.create ?? { rawId: RAW_ID, prf: PRF },
      get: options.get ?? { rawId: RAW_ID, prf: PRF },
    });
    const kept: BackupCredential[] = [];
    const sealedWith: { prf: Uint8Array; secret: Uint8Array }[] = [];
    const secrets: Uint8Array[] = [];
    const stored: { locator: string; envelope: Uint8Array }[] = [];
    const order: string[] = [];
    const session = new BallotSession();
    const s: BackupSteps = {
      credentials: auth.credentials,
      rpId: RP_ID,
      identity: async () => {
        order.push("identity");
        const kind = options.identity ?? "found";
        if (kind !== "found") return { kind };
        const secret = SECRET.slice();
        secrets.push(secret);
        return { kind, identity: { secret, memberships: [{ tier: 0, group: 5n }] } };
      },
      credential: async () => options.held ?? { kind: "none" },
      keep: async (credential) => {
        order.push("keep");
        kept.push(credential);
        return options.keep ?? "saved";
      },
      seal: async (prf, secret) => {
        order.push("seal");
        if (options.worker === "fails") throw new Error("the ballot worker failed");
        // As postMessage does: the worker gets copies.
        sealedWith.push({ prf: prf.slice(), secret: secret.slice() });
        return session.backupSeal({
          v: PROTOCOL_VERSION,
          id: 1,
          kind: "backup-seal",
          prf: prf.slice(),
          secret: secret.slice(),
        });
      },
      put: async (locator, envelope) => {
        order.push("put");
        stored.push({ locator: toHex(locator), envelope });
        return options.put ?? "stored";
      },
      fetch: async (locator) => {
        order.push("fetch");
        const last = stored.at(-1);
        const kind = options.fetch ?? "kept";
        if (kind === "not-found" || kind === "unreachable") return { kind };
        if (last === undefined || last.locator !== toHex(locator)) return { kind: "not-found" };
        const envelope = last.envelope.slice();
        if (kind === "other") envelope[62] = (envelope[62] as number) ^ 1;
        return { kind: "found", envelope };
      },
      now: () => 1_700_000_000_000,
    };
    return { s, auth, kept, sealedWith, secrets, stored, order };
  }

  test("with no backup passkey, makes one, keeps it before anything else, and stores an envelope that opens to the identity", async () => {
    const t = steps();
    expect(await backUp(t.s)).toEqual({ kind: "stored", syncable: true, backedUp: true });
    expect(t.auth.created).toHaveLength(1);
    expect(t.auth.got).toHaveLength(0);
    expect(t.order).toEqual(["identity", "keep", "identity", "seal", "put", "fetch", "keep"]);
    expect(t.kept).toEqual([
      { credentialId: RAW_ID, backedUp: true },
      { credentialId: RAW_ID, backedUp: true, storedAt: 1_700_000_000_000 },
    ]);
    const [{ locator, envelope }] = t.stored as [{ locator: string; envelope: Uint8Array }];
    expect(locator).toBe(toHex(identityBackupLocator(PRF)));
    expect(toHex(openIdentityBackup(PRF, envelope))).toBe(toHex(SECRET));
    // The page's copies of the secret are zeroed once sent.
    expect(t.secrets.every(zeroed)).toBe(true);
  });

  test("a passkey that answers no PRF at creation is evaluated once, by its ID", async () => {
    const t = steps({ create: { rawId: RAW_ID, prf: null, enabled: true } });
    expect(await backUp(t.s)).toEqual({ kind: "stored", syncable: true, backedUp: true });
    expect(t.auth.got).toHaveLength(1);
    expect(t.auth.got[0]?.publicKey?.allowCredentials).toEqual([
      { type: "public-key", id: RAW_ID },
    ]);
    expect(toHex(openIdentityBackup(PRF, t.stored[0]?.envelope as Uint8Array))).toBe(toHex(SECRET));
  });

  test("with a kept passkey, evaluates it and never makes another; its BS is read anew", async () => {
    const t = steps({
      held: { kind: "found", credential: { credentialId: RAW_ID, backedUp: true } },
      get: { rawId: RAW_ID, prf: PRF, flags: UV | BE },
    });
    expect(await backUp(t.s)).toEqual({ kind: "stored", syncable: true, backedUp: false });
    expect(t.auth.created).toHaveLength(0);
    expect(t.auth.got[0]?.publicKey?.allowCredentials).toEqual([
      { type: "public-key", id: RAW_ID },
    ]);
    expect(t.kept).toEqual([
      { credentialId: RAW_ID, backedUp: false, storedAt: 1_700_000_000_000 },
    ]);
  });

  test("each backup seals afresh: two envelopes under one locator, both opening", async () => {
    const t = steps();
    await backUp(t.s);
    await backUp(t.s);
    const [a, b] = t.stored as [
      { locator: string; envelope: Uint8Array },
      { locator: string; envelope: Uint8Array },
    ];
    expect(a.locator).toBe(b.locator);
    expect(toHex(a.envelope)).not.toBe(toHex(b.envelope));
    for (const { envelope } of [a, b])
      expect(toHex(openIdentityBackup(PRF, envelope))).toBe(toHex(SECRET));
  });

  test.each<[string, Parameters<typeof steps>[0], string, number]>([
    ["an unreadable backup credential", { held: { kind: "unreadable" } }, "unreadable", 0],
    ["no identity", { identity: "none" }, "no-identity", 0],
    ["an unreadable identity", { identity: "unreadable" }, "unreadable", 0],
    ["a cancelled creation", { create: new DOMException("no", "NotAllowedError") }, "cancelled", 1],
    ["no PRF support", { create: { rawId: RAW_ID, prf: null, enabled: false } }, "no-prf", 1],
    ["no user verification", { create: { rawId: RAW_ID, flags: BE | BS } }, "no-uv", 1],
  ])("%s stops it before anything is kept or sealed", async (_, options, problem, ceremonies) => {
    const t = steps(options);
    expect(await backUp(t.s)).toEqual({ kind: "stopped", problem });
    expect(t.auth.created.length + t.auth.got.length).toBe(ceremonies);
    expect(t.kept).toHaveLength(0);
    expect(t.sealedWith).toHaveLength(0);
    expect(t.stored).toHaveLength(0);
  });

  test("a new passkey's ID the browser won't keep stops it before the seal", async () => {
    const t = steps({ keep: "unwritable" });
    expect(await backUp(t.s)).toEqual({ kind: "stopped", problem: "unwritable" });
    expect(t.sealedWith).toHaveLength(0);
  });

  test("a failed evaluation after a kept creation stops it, with the passkey kept for the next try", async () => {
    const t = steps({
      create: { rawId: RAW_ID, prf: null, enabled: true },
      get: new DOMException("no", "NotAllowedError"),
    });
    expect(await backUp(t.s)).toEqual({ kind: "stopped", problem: "cancelled" });
    expect(t.kept).toEqual([{ credentialId: RAW_ID, backedUp: true }]);
    expect(t.sealedWith).toHaveLength(0);
  });

  test("an identity gone by the time of the seal stops it", async () => {
    let reads = 0;
    const t = steps();
    const s: BackupSteps = {
      ...t.s,
      identity: async () => (reads++ === 0 ? t.s.identity() : { kind: "none" }),
    };
    expect(await backUp(s)).toEqual({ kind: "stopped", problem: "no-identity" });
    expect(t.sealedWith).toHaveLength(0);
  });

  test("a failed worker stops it, with the page's secret zeroed", async () => {
    const t = steps({ worker: "fails" });
    expect(await backUp(t.s)).toEqual({ kind: "stopped", problem: "worker-failed" });
    expect(t.secrets.every(zeroed)).toBe(true);
    expect(t.stored).toHaveLength(0);
  });

  test.each<[string, Parameters<typeof steps>[0], string]>([
    ["no envelope", { fetch: "not-found" }, "not-kept"],
    ["another envelope", { fetch: "other" }, "not-kept"],
    ["no answer", { fetch: "unreachable" }, "unreachable"],
  ])(
    "a read-back giving %s stops it, and the record keeps no time",
    async (_, options, problem) => {
      const t = steps(options);
      expect(await backUp(t.s)).toEqual({ kind: "stopped", problem });
      expect(t.kept).toEqual([{ credentialId: RAW_ID, backedUp: true }]);
    },
  );

  test.each(["rejected", "unreachable"] as const)(
    "a route answering %s stops it, and the record keeps no time",
    async (answer) => {
      const t = steps({ put: answer });
      expect(await backUp(t.s)).toEqual({ kind: "stopped", problem: answer });
      expect(t.kept).toEqual([{ credentialId: RAW_ID, backedUp: true }]);
    },
  );

  test("the PRF output handed to the seal is zeroed on the page once sent", async () => {
    const prfs: Uint8Array[] = [];
    const t = steps();
    const s: BackupSteps = {
      ...t.s,
      seal: (prf, secret) => {
        prfs.push(prf);
        return t.s.seal(prf, secret);
      },
    };
    await backUp(s);
    expect(prfs).toHaveLength(1);
    expect(zeroed(prfs[0] as Uint8Array)).toBe(true);
    expect(toHex(t.sealedWith[0]?.prf as Uint8Array)).toBe(toHex(PRF));
  });
});
