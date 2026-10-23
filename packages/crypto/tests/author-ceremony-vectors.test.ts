import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import {
  type AuthorApprovalContext,
  authorApprovalsRefusal,
  authorPanelId,
  BOARD_PAYLOAD_TYPES_V5,
  BOARD_PAYLOAD_TYPES_V7,
  boardEntryHash,
  boardPayloadTypes,
  type CeremonyCheck,
  type CeremonyParams,
  ceremonyContext,
  checkAuthorApprovals,
  checkCeremonyTranscript,
  checkContractEvent,
  DecodeError,
  decodeAuthorApprovals,
  decodeBoardEntry,
  decodeCeremonyRegistration,
  decodeContractEvent,
  encodeAuthorApprovals,
  KEM_PUBLIC_KEY,
  keySetEntry,
  keySetHash,
  type Panel,
  PanelError,
  panelId,
  RECORD_TYPES,
  type RegisteredKeys,
  signAuthorCeremonyRegistration,
  verifyAuthorCeremonyRegistration,
  verifyCeremonyRegistration,
} from "../src/index.ts";
import { encode } from "../src/codec.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/author-ceremony.json and author-registration.json come
// from independent Python implementations (scripts/author-ceremony-vectors.py
// and scripts/author-registration-vectors.py), so these expected values never
// come from the code under test.

type Kind = "default" | "author";

interface Result {
  readonly ok: boolean;
  readonly code?: string;
  readonly hash?: string;
  readonly keySetHash?: string;
  readonly seats?: readonly { readonly index: number; readonly reasons: readonly string[] }[];
  readonly registered?: readonly {
    readonly index: number;
    readonly kemKey: string;
    readonly signingKey: string;
  }[];
}

interface Vectors {
  readonly format: string;
  readonly election: {
    readonly l2ChainId: string;
    readonly trusteeRegistry: string;
    readonly electionId: string;
    readonly stubHash: string;
    readonly authorStubHash: string;
  };
  readonly panels: Readonly<
    Record<
      string,
      {
        readonly kind: Kind;
        readonly threshold: number;
        readonly identitySecrets: readonly string[];
        readonly keys: readonly string[];
        readonly panelId: string;
      }
    >
  >;
  readonly transcripts: readonly {
    readonly id: string;
    readonly panel: string;
    readonly kind: Kind;
    readonly context: string;
    readonly transcript: string;
    readonly result: Result;
  }[];
  readonly contexts: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly kind: Kind;
    readonly stubHash: string;
    readonly code: string;
  }[];
  readonly records: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly record: string;
  }[];
  readonly approvals: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly records: readonly string[];
    readonly result: {
      readonly ok: boolean;
      readonly code?: string;
      readonly seats?: readonly number[];
    };
  }[];
  readonly boarding: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly record: string;
    readonly boarded: boolean;
    readonly refusal: string | null;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly record: string;
    readonly error: string;
  }[];
  readonly boardEntries: readonly {
    readonly id: string;
    readonly version: 5 | 7;
    readonly entry: string;
    readonly error: string | null;
    readonly entryHash?: string;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("author-ceremony.json", SPEC_VECTORS), "utf8"),
) as Vectors;

interface RegistrationVectors {
  readonly format: string;
  readonly election: Vectors["election"] & {
    readonly definitionHash: string;
    readonly contracts: Readonly<
      Record<"election-registry" | "trustee-registry" | "group-registry" | "board", string>
    >;
  };
  readonly registrations: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly registration: string;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly record: string;
    readonly registration: string;
    readonly read: boolean;
  }[];
  readonly cases: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly records: readonly string[];
    readonly events: readonly string[];
    readonly recorded?: string;
    readonly result: { readonly ok: boolean; readonly code?: string; readonly seats?: number[] };
  }[];
}

const R = JSON.parse(
  readFileSync(new URL("author-registration.json", SPEC_VECTORS), "utf8"),
) as RegistrationVectors;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const panelOf = (name: string): Panel => {
  const p = V.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
};

const DEFAULT = panelOf("default-4");
// The vectors' default-panel run sits beside the 2-of-3 author panel.
const AUTHOR = panelOf("author-3");

const election = {
  l2ChainId: BigInt(V.election.l2ChainId),
  trusteeRegistry: hex(V.election.trusteeRegistry),
  electionId: hex(V.election.electionId),
};

// Each run's parameters as the spec builds them: the author run over the
// author stub with the author panel identifier, each run's duplicate-key
// reading the other panel's identity keys.
function params(name: string, kind: Kind): Omit<CeremonyParams, "runId"> {
  return kind === "author"
    ? {
        ...election,
        stubHash: hex(V.election.authorStubHash),
        panel: panelOf(name),
        panelKind: "author",
        otherPanelKeys: DEFAULT.keys,
      }
    : {
        ...election,
        stubHash: hex(V.election.stubHash),
        panel: panelOf(name),
        otherPanelKeys: AUTHOR.keys,
      };
}

function asVector(r: CeremonyCheck): Result {
  if (!r.ok)
    return r.seats === undefined
      ? { ok: false, code: r.code }
      : { ok: false, code: r.code, seats: r.seats };
  return {
    ok: true,
    hash: toHex(r.hash),
    seats: r.seats,
    registered: r.registered.map((k) => ({
      index: k.index,
      kemKey: toHex(encode(KEM_PUBLIC_KEY, k.kemKey)),
      signingKey: toHex(k.signingKey),
    })),
    keySetHash: toHex(keySetHash(r.registered.map(keySetEntry))),
  };
}

const transcriptOf = (id: string) => {
  const t = V.transcripts.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no transcript ${id}`);
  return t;
};

// The approvals context of an author transcript, from its own check.
function approvalContext(id: string): AuthorApprovalContext {
  const t = transcriptOf(id);
  const r = checkCeremonyTranscript(params(t.panel, "author"), hex(t.transcript), 1);
  if (!r.ok) throw new Error(`${id} doesn't check`);
  return {
    ...election,
    authorStubHash: hex(V.election.authorStubHash),
    panel: panelOf(t.panel),
    authorTranscriptHash: r.hash,
    registered: r.registered,
  };
}

const recordOf = (id: string) => {
  const r = V.records.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no record ${id}`);
  return hex(r.record);
};

describe("author-ceremony.json", () => {
  test("is the format this reader knows", () => {
    expect(V.format).toBe("abolish-author-ceremony-vectors/1");
  });

  test.each(Object.entries(V.panels))("%s's identifier is its kind's", (_, p) => {
    const panel = { threshold: p.threshold, keys: p.keys.map(hex) };
    expect(toHex(p.kind === "author" ? authorPanelId(panel) : panelId(panel))).toBe(p.panelId);
  });

  test.each(V.transcripts.map((t) => [t.id, t] as const))(
    "%s checks as the vector says, under its run's context",
    (_, t) => {
      const p = params(t.panel, t.kind);
      const r = checkCeremonyTranscript(p, hex(t.transcript), 1);
      expect(asVector(r)).toEqual(t.result);
      const runId = hex(t.transcript).subarray(3, 35);
      expect(toHex(ceremonyContext({ ...p, runId }))).toBe(t.context);
    },
    60_000,
  );

  test.each(V.contexts.map((c) => [c.id, c] as const))(
    "%s: a transcript never checks under another run's context",
    (_, c) => {
      const t = transcriptOf(c.transcript);
      const base = params(t.panel, "author");
      const p: Omit<CeremonyParams, "runId"> = {
        ...base,
        stubHash: hex(c.stubHash),
        panelKind: c.kind,
      };
      expect(checkCeremonyTranscript(p, hex(t.transcript), 1)).toEqual({
        ok: false,
        code: c.code,
      });
    },
  );

  test("duplicate-key reads the other panel's keys only from the keys it is given", () => {
    // Without the default panel's keys, the borrowed signing key goes unseen.
    const t = transcriptOf("author-duplicate-default");
    const others = { ...params(t.panel, "author"), otherPanelKeys: panelOf("author-1").keys };
    const r = checkCeremonyTranscript(others, hex(t.transcript), 1);
    expect(r.ok && r.seats.every((s) => s.reasons.length === 0)).toBe(true);
  });

  test.each(V.records.map((r) => [r.id, r] as const))(
    "record %s decodes strictly and re-encodes to its bytes",
    (_, r) => {
      const bytes = hex(r.record);
      expect(bytes.length).toBe(39 + 65 * decodeAuthorApprovals(bytes, 1).approvals.length);
      expect(encodeAuthorApprovals(decodeAuthorApprovals(bytes, 1))).toEqual(bytes);
    },
  );

  test("an author seat's approval is reproduced and verifies only as an author statement", () => {
    const ctx = approvalContext("author-honest-3");
    const p = V.panels["author-3"];
    const record = decodeAuthorApprovals(recordOf("all"), 1);
    for (const { index, signature } of record.approvals) {
      const reg = {
        l2ChainId: ctx.l2ChainId,
        trusteeRegistry: ctx.trusteeRegistry,
        index,
        stubHash: ctx.authorStubHash,
        ceremonyTranscriptHash: ctx.authorTranscriptHash,
        keySetHash: keySetHash(ctx.registered.map(keySetEntry)),
      };
      const secret = hex(p?.identitySecrets[index - 1] ?? "");
      // RFC 6979 nonces, so the signature is the generator's byte for byte.
      expect(signAuthorCeremonyRegistration(secret, AUTHOR, reg)).toEqual(signature);
      expect(verifyAuthorCeremonyRegistration(AUTHOR, reg, signature)).toBe(true);
      // The default-panel form of the identifier is another statement (T-37).
      expect(verifyCeremonyRegistration(AUTHOR, reg, signature)).toBe(false);
    }
  });

  test.each(V.approvals.map((a) => [a.id, a] as const))(
    "approvals %s check as the vector says",
    (_, a) => {
      expect(checkAuthorApprovals(approvalContext(a.transcript), a.records.map(hex))).toEqual(
        a.result,
      );
    },
  );

  test.each(V.boarding.map((b) => [b.id, b] as const))(
    "boarding %s: the operator's rule",
    (_, b) => {
      expect(
        authorApprovalsRefusal(approvalContext(b.transcript), recordOf(b.record), b.boarded),
      ).toBe(b.refusal ?? undefined);
    },
  );

  test.each(V.decode.map((d) => [d.id, d] as const))("%s is rejected when decoded", (_, d) => {
    expect(() => decodeAuthorApprovals(hex(d.record), 1)).toThrow(
      expect.objectContaining({ name: DecodeError.name, code: d.error }),
    );
    // A record that doesn't decode is refused for boarding with its code.
    expect(authorApprovalsRefusal(approvalContext("author-honest-3"), hex(d.record), false)).toBe(
      d.error,
    );
  });

  test.each(V.boardEntries.map((e) => [e.id, e] as const))(
    "board entry %s decodes as the vector says",
    (_, e) => {
      const bytes = hex(e.entry);
      if (e.error === null) {
        expect(toHex(decodeBoardEntry(bytes, e.version).payload)).toBe(toHex(bytes.subarray(51)));
        expect(toHex(boardEntryHash(bytes))).toBe(e.entryHash);
      } else
        expect(() => decodeBoardEntry(bytes, e.version)).toThrow(
          expect.objectContaining({ name: DecodeError.name, code: e.error }),
        );
    },
  );
});

describe("author approvals", () => {
  test("version 7 allows version 5's payloads and the approvals, nothing else", () => {
    expect(boardPayloadTypes(7)).toBe(BOARD_PAYLOAD_TYPES_V7);
    expect([...BOARD_PAYLOAD_TYPES_V7]).toEqual([
      ...BOARD_PAYLOAD_TYPES_V5,
      RECORD_TYPES.authorApprovals,
    ]);
    expect(Object.isFrozen(BOARD_PAYLOAD_TYPES_V7)).toBe(true);
  });

  test("refuses a key set the transcript check didn't return for the author transcript", () => {
    const ctx = approvalContext("author-honest-3");
    const copy: RegisteredKeys[] = ctx.registered.map((k) => ({ ...k }));
    expect(() => checkAuthorApprovals({ ...ctx, registered: copy }, [])).toThrow(RangeError);
    // A checked set, but of another transcript.
    const other = checkedKeySetForTests(copy, new Uint8Array(32).fill(7));
    expect(() => checkAuthorApprovals({ ...ctx, registered: other }, [])).toThrow(RangeError);
    expect(() =>
      authorApprovalsRefusal({ ...ctx, registered: copy }, recordOf("all"), false),
    ).toThrow(RangeError);
  });

  test("refuses an author panel outside its rules, so the quorum is never 0", () => {
    const ctx = approvalContext("author-honest-3");
    expect(() => checkAuthorApprovals({ ...ctx, panel: { ...AUTHOR, threshold: 0 } }, [])).toThrow(
      PanelError,
    );
  });

  test("the author run needs the default panel's keys, each a canonical p256-key", () => {
    const t = transcriptOf("author-honest-3");
    const p = params(t.panel, "author");
    expect(() =>
      checkCeremonyTranscript({ ...p, otherPanelKeys: [] }, hex(t.transcript), 1),
    ).toThrow(RangeError);
    expect(() =>
      checkCeremonyTranscript(
        { ...p, otherPanelKeys: [new Uint8Array(33).fill(9)] },
        hex(t.transcript),
        1,
      ),
    ).toThrow();
  });

  test("records round-trip, and their seats' order never changes what decodes", () => {
    const sig = decodeAuthorApprovals(recordOf("all"), 1).approvals[0]?.signature;
    if (sig === undefined) throw new Error("bad vector");
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 16 }),
        (transcript_hash, indices) => {
          const record = {
            transcript_hash,
            approvals: indices.map((index) => ({ index, signature: sig })),
          };
          const bytes = encodeAuthorApprovals(record);
          expect(bytes.length).toBe(39 + 65 * indices.length);
          expect(decodeAuthorApprovals(bytes, 1)).toEqual(record);
        },
      ),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 100) },
    );
  });

  test("a seat's approval never counts for another seat, transcript or key set", () => {
    const ctx = approvalContext("author-honest-3");
    const good = decodeAuthorApprovals(recordOf("all"), 1);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 1, max: 3 }), (from, to) => {
        const a = good.approvals[from];
        if (a === undefined) throw new Error("bad vector");
        const record = encodeAuthorApprovals({
          transcript_hash: good.transcript_hash,
          approvals: [{ index: to, signature: a.signature }],
        });
        const r = checkAuthorApprovals(ctx, [record]);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.seats).toEqual(a.index === to ? [to] : []);
      }),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 100) },
    );
  });
});

describe("author-registration.json", () => {
  const contracts = {
    electionRegistry: hex(R.election.contracts["election-registry"]),
    trusteeRegistry: hex(R.election.contracts["trustee-registry"]),
    groupRegistry: hex(R.election.contracts["group-registry"]),
    board: hex(R.election.contracts.board),
  };
  const eventOf = (id: string) => {
    const e = R.events.find((x) => x.id === id);
    if (e === undefined) throw new Error(`no event ${id}`);
    return e;
  };
  const registrationOf = (id: string) => {
    const r = R.registrations.find((x) => x.id === id);
    if (r === undefined) throw new Error(`no registration ${id}`);
    return hex(r.registration);
  };

  test("is the format this reader knows, of author-ceremony.json's election", () => {
    expect(R.format).toBe("abolish-author-registration-vectors/1");
    const { definitionHash: _, contracts: __, ...election } = R.election;
    expect(election).toEqual(V.election);
    expect(R.election.contracts["trustee-registry"]).toBe(V.election.trusteeRegistry);
  });

  test.each(R.events.map((e) => [e.id, e] as const))(
    "event %s carries its registration exactly when the vector reads it",
    (_, e) => {
      const record = decodeContractEvent(hex(e.record), 9);
      const checked = checkContractEvent(record, contracts, 9);
      const read =
        checked.ok &&
        checked.event.event === "AuthorPanelRegistered" &&
        toHex(checked.event.definitionHash) === R.election.definitionHash;
      expect(read).toBe(e.read);
      if (checked.ok && checked.event.event === "AuthorPanelRegistered")
        expect(toHex(checked.event.registration)).toBe(e.registration);
      // Version 8 names no AuthorPanelRegistered.
      expect(() => decodeContractEvent(hex(e.record), 8)).toThrow(DecodeError);
    },
  );

  test.each(R.cases.map((c) => [c.id, c] as const))(
    "%s: records and registrations decide the check as the vector says",
    (_, c) => {
      const registrations = c.events
        .map(eventOf)
        .filter((e) => e.read)
        .map((e) => hex(e.registration));
      expect(
        checkAuthorApprovals(
          approvalContext(c.transcript),
          c.records.map(recordOf),
          registrations,
          c.recorded === undefined ? undefined : registrationOf(c.recorded),
        ),
      ).toEqual(c.result);
    },
  );

  test("a registration whose key isn't a point doesn't decode, though its layout holds", () => {
    expect(() => decodeCeremonyRegistration(registrationOf("not-a-point"))).toThrow(DecodeError);
    expect(decodeCeremonyRegistration(registrationOf("all")).approvals.map((a) => a.index)).toEqual(
      [1, 2, 3],
    );
  });

  test("no one-byte change to a registration approves another key set or header, or fails the check", () => {
    const ctx = approvalContext("author-honest-3");
    const all = registrationOf("all");
    const approvalsAt = 97 + 97 * 3 + 1;
    const missing = { ok: false, code: "author-approvals-missing", seats: [] };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: all.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(all);
          changed[at] = (changed[at] as number) ^ flip;
          const r = checkAuthorApprovals(ctx, [], [changed]);
          // As the recorded registration it reads alike: no quorum signed
          // the changed key set, so it is none the registry emits.
          expect(checkAuthorApprovals(ctx, [], [], changed)).toEqual(r);
          if (at < approvalsAt)
            // The header, a seat or a count: the approvals no longer sign
            // what the registration says, so no quorum registered it and it
            // carries nothing, never `key-set-mismatch` (T-37, T-53).
            expect(r).toEqual(missing);
          else {
            // An approval: at most its own seat stops counting, and two of
            // three still make the quorum, unless the record no longer decodes.
            const seat = Math.floor((at - approvalsAt) / 65) + 1;
            if (!r.ok) expect(r).toEqual(missing);
            else
              for (const other of [1, 2, 3].filter((x) => x !== seat))
                expect(r.seats).toContain(other);
          }
        },
      ),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 100) },
    );
  }, 120_000);

  test("another key set fails the check only as the recorded registration, ahead of approvals", () => {
    const ctx = approvalContext("author-honest-3");
    const other = registrationOf("other-key-set");
    expect(checkAuthorApprovals(ctx, [recordOf("all")], [], other)).toEqual({
      ok: false,
      code: "key-set-mismatch",
    });
    // Found anywhere else it carries nothing (T-53).
    expect(checkAuthorApprovals(ctx, [recordOf("all")], [other])).toEqual({
      ok: true,
      seats: [1, 2, 3],
    });
    expect(() => checkAuthorApprovals(ctx, [], "x" as unknown as Uint8Array[])).toThrow(TypeError);
    expect(() => checkAuthorApprovals(ctx, [], [], "x" as unknown as Uint8Array)).toThrow(
      TypeError,
    );
  });
});
