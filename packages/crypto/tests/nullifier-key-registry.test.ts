import fc from "fast-check";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeNullifierKeyRecord,
  decodeNullifierReshareRecord,
  encodeNullifierKeyRecord,
  encodeNullifierReshareRecord,
  identityKey,
  type NullifierKeyLogRecord,
  nullifierKeyApprovalMessage,
  nullifierKeyApprovalStatement,
  type NullifierKeyRegistryScope,
  nullifierReshareApprovalMessage,
  nullifierReshareApprovalStatement,
  nullifierReshareConsentMessage,
  nullifierReshareConsentStatement,
  type NullifierReshareScope,
  type Panel,
  panelId,
  replayNullifierKeyRecords,
  signStatement,
  verifyStatement,
} from "../src/index.ts";
import { MAX_KEY_WINDOW, MAX_RESHARE_WINDOW } from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/nullifier-key-registry.json comes from an independent
// Python implementation (scripts/nullifier-key-registry-vectors.py, standard
// library only, on trustee-vectors.py's P-256 ECDSA, which reproduces RFC 6979
// first), so these expected values never come from the code under test.

interface PanelVector {
  readonly threshold: number;
  readonly identitySecrets: readonly string[];
  readonly keys: readonly string[];
  readonly panelId: string;
  readonly quorum: number;
}

interface StatementVector {
  readonly panel: string;
  readonly index: number;
  readonly keyId: string;
  readonly deadline: string;
  readonly predecessor?: string;
  readonly newPanel?: string;
  readonly message: string;
  readonly digest: string;
  readonly signature: string;
}

interface EventVector {
  readonly kind: "initial" | "reshare";
  readonly l2Block: string;
  readonly keyId: string;
  readonly predecessor?: string;
  readonly newPanelId?: string;
  readonly record: string;
}

interface KeyVector {
  readonly keyId: string;
  readonly panelId: string;
  readonly deadline: string;
  readonly l2Block: string;
  readonly predecessor: string | null;
}

interface Vectors {
  readonly format: string;
  readonly tags: Record<string, string>;
  readonly parameters: { readonly MAX_KEY_WINDOW: number; readonly MAX_RESHARE_WINDOW: number };
  readonly scope: { readonly l2ChainId: string; readonly groupRegistry: string };
  readonly panels: Record<string, PanelVector>;
  readonly pinnedPanels: readonly string[];
  readonly initialPanel: string;
  readonly statements: {
    readonly keyApproval: readonly StatementVector[];
    readonly reshareApproval: readonly StatementVector[];
    readonly reshareConsent: readonly StatementVector[];
  };
  readonly records: {
    readonly initial: {
      readonly deadline: string;
      readonly keyId: string;
      readonly approvals: readonly number[];
      readonly record: string;
    };
    readonly reshare: ReshareRecordVector;
    readonly refresh: ReshareRecordVector;
  };
  readonly replays: readonly {
    readonly id: string;
    readonly description: string;
    readonly events: readonly EventVector[];
    readonly result:
      | { readonly ok: true; readonly keys: readonly KeyVector[] }
      | {
          readonly ok: false;
          readonly at: number;
          readonly code: string;
          readonly keys: readonly KeyVector[];
        };
  }[];
}

interface ReshareRecordVector {
  readonly predecessor: string;
  readonly newPanel: string;
  readonly deadline: string;
  readonly keyId: string;
  readonly consents: readonly number[];
  readonly approvals: readonly number[];
  readonly record: string;
}

const V = JSON.parse(
  readFileSync(new URL("nullifier-key-registry.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const KEY_APPROVAL_TAG = "abolish/v1/sig/nullifier-key-approval-3";
const RESHARE_APPROVAL_TAG = "abolish/v1/sig/nullifier-reshare-approval-2";
const CONSENT_TAG = "abolish/v1/sig/nullifier-reshare-consent";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const scope: NullifierKeyRegistryScope = {
  l2ChainId: BigInt(V.scope.l2ChainId),
  groupRegistry: hex(V.scope.groupRegistry),
};

function panelVector(name: string): PanelVector {
  const p = V.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return p;
}

function panelOf(name: string): Panel {
  const p = panelVector(name);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
}

const secretOf = (name: string, index: number) =>
  hex(panelVector(name).identitySecrets[index - 1] ?? "");

// A reshare scope over the vector's panels: the registry's statements need
// only the predecessor's identifier, so its key carries no shares.
function reshareScope(
  oldName: string,
  predecessor: string,
  newName: string,
): NullifierReshareScope {
  const old = panelOf(oldName);
  return {
    ...scope,
    oldPanel: old,
    newPanel: panelOf(newName),
    predecessor: {
      keyId: hex(predecessor),
      threshold: old.threshold,
      signingKeys: old.keys.map(() => null),
      commitments: old.keys.map(() => null),
    },
  };
}

const PINS = {
  ...scope,
  initialPanel: panelOf(V.initialPanel),
  panels: V.pinnedPanels.map(panelOf),
};

function eventOf(e: EventVector): NullifierKeyLogRecord {
  return e.kind === "initial"
    ? { kind: "initial", l2Block: BigInt(e.l2Block), keyId: hex(e.keyId), record: hex(e.record) }
    : {
        kind: "reshare",
        l2Block: BigInt(e.l2Block),
        predecessor: hex(e.predecessor ?? ""),
        keyId: hex(e.keyId),
        newPanelId: hex(e.newPanelId ?? ""),
        record: hex(e.record),
      };
}

const keysOf = (
  keys: readonly {
    keyId: Uint8Array;
    panelId: Uint8Array;
    deadline: bigint;
    l2Block: bigint;
    predecessor: Uint8Array | null;
  }[],
): KeyVector[] =>
  keys.map((k) => ({
    keyId: toHex(k.keyId),
    panelId: toHex(k.panelId),
    deadline: String(k.deadline),
    l2Block: String(k.l2Block),
    predecessor: k.predecessor === null ? null : toHex(k.predecessor),
  }));

// `H(DS(tag, m))` as the registry builds it: `u8(len(tag)) ‖ tag ‖ m`, SHA-256.
const digestOf = (tag: string, m: Uint8Array) =>
  toHex(sha256(Uint8Array.from([tag.length, ...new TextEncoder().encode(tag), ...m])));

describe("nullifier-key-registry.json", () => {
  test("is the format, tags and windows this module implements", () => {
    expect(V.format).toBe("abolish-nullifier-key-registry-vectors/1");
    for (const tag of [KEY_APPROVAL_TAG, RESHARE_APPROVAL_TAG, CONSENT_TAG])
      expect(V.tags[tag]).toBe(tag);
    expect(BigInt(V.parameters.MAX_KEY_WINDOW)).toBe(MAX_KEY_WINDOW);
    expect(BigInt(V.parameters.MAX_RESHARE_WINDOW)).toBe(MAX_RESHARE_WINDOW);
    for (const [name, p] of Object.entries(V.panels)) {
      expect(toHex(panelId(panelOf(name)))).toBe(p.panelId);
      expect(p.keys).toEqual(p.identitySecrets.map((s) => toHex(identityKey(hex(s)))));
    }
  });

  test("initial-key approval statements, digests and signatures are re-made byte for byte", () => {
    const panel = panelOf("initial-5");
    for (const x of V.statements.keyApproval) {
      const keyId = hex(x.keyId);
      const deadline = BigInt(x.deadline);
      const m = nullifierKeyApprovalStatement(
        scope,
        hex(panelVector(x.panel).panelId),
        x.index,
        keyId,
        deadline,
      );
      expect(toHex(m)).toBe(x.message);
      expect(m).toHaveLength(101);
      // The seat-checked form a seat signs through builds the same bytes.
      expect(
        toHex(nullifierKeyApprovalMessage({ ...scope, panel }, x.index, keyId, deadline)),
      ).toBe(x.message);
      expect(digestOf(KEY_APPROVAL_TAG, m)).toBe(x.digest);
      expect(toHex(signStatement(secretOf(x.panel, x.index), KEY_APPROVAL_TAG, m))).toBe(
        x.signature,
      );
      expect(
        verifyStatement(
          panel.keys[x.index - 1] as Uint8Array,
          KEY_APPROVAL_TAG,
          m,
          hex(x.signature),
        ),
      ).toBe(true);
    }
  });

  test("a successor's approvals and the old panel's consents are re-made byte for byte", () => {
    for (const x of V.statements.reshareApproval) {
      const [pred, keyId, deadline] = [hex(x.predecessor ?? ""), hex(x.keyId), BigInt(x.deadline)];
      const m = nullifierReshareApprovalStatement(
        scope,
        hex(panelVector(x.panel).panelId),
        x.index,
        pred,
        keyId,
        deadline,
      );
      expect(toHex(m)).toBe(x.message);
      expect(m).toHaveLength(133);
      const s = reshareScope("initial-5", x.predecessor ?? "", x.panel);
      expect(toHex(nullifierReshareApprovalMessage(s, x.index, keyId, deadline))).toBe(x.message);
      expect(digestOf(RESHARE_APPROVAL_TAG, m)).toBe(x.digest);
      expect(toHex(signStatement(secretOf(x.panel, x.index), RESHARE_APPROVAL_TAG, m))).toBe(
        x.signature,
      );
    }
    for (const x of V.statements.reshareConsent) {
      const [pred, keyId, deadline] = [hex(x.predecessor ?? ""), hex(x.keyId), BigInt(x.deadline)];
      const newPanel = x.newPanel ?? "";
      const m = nullifierReshareConsentStatement(
        scope,
        hex(panelVector(x.panel).panelId),
        x.index,
        pred,
        hex(panelVector(newPanel).panelId),
        keyId,
        deadline,
      );
      expect(toHex(m)).toBe(x.message);
      expect(m).toHaveLength(165);
      const s = reshareScope(x.panel, x.predecessor ?? "", newPanel);
      expect(toHex(nullifierReshareConsentMessage(s, x.index, keyId, deadline))).toBe(x.message);
      expect(digestOf(CONSENT_TAG, m)).toBe(x.digest);
      expect(toHex(signStatement(secretOf(x.panel, x.index), CONSENT_TAG, m))).toBe(x.signature);
    }
  });

  test("the records decode to their fields and re-encode to themselves", () => {
    const i = V.records.initial;
    const k = decodeNullifierKeyRecord(hex(i.record));
    if (k === null) throw new Error("expected the initial record to decode");
    expect(k.deadline).toBe(BigInt(i.deadline));
    expect(toHex(k.keyId)).toBe(i.keyId);
    expect(k.approvals.map((a) => a.index)).toEqual(i.approvals);
    expect(toHex(encodeNullifierKeyRecord(k))).toBe(i.record);
    for (const r of [V.records.reshare, V.records.refresh]) {
      const d = decodeNullifierReshareRecord(hex(r.record));
      if (d === null) throw new Error("expected the reshare record to decode");
      expect(toHex(d.predecessor)).toBe(r.predecessor);
      expect(toHex(d.newPanelId)).toBe(panelVector(r.newPanel).panelId);
      expect(d.deadline).toBe(BigInt(r.deadline));
      expect(toHex(d.keyId)).toBe(r.keyId);
      expect(d.consents.map((a) => a.index)).toEqual(r.consents);
      expect(d.approvals.map((a) => a.index)).toEqual(r.approvals);
      expect(toHex(encodeNullifierReshareRecord(d))).toBe(r.record);
    }
  });

  test.each(V.replays.map((c) => [c.id, c] as const))("replays %s as the registry does", (_, c) => {
    const r = replayNullifierKeyRecords(c.events.map(eventOf), PINS);
    const want = c.result;
    if (want.ok) {
      expect(r.ok).toBe(true);
    } else {
      expect(r).toMatchObject({ ok: false, at: want.at, reason: want.code });
    }
    expect(keysOf(r.keys)).toEqual(want.keys);
  });
});

const signature = fc.uint8Array({ minLength: 64, maxLength: 64 });
const seatSignature = fc.record({ index: fc.integer({ min: 0, max: 255 }), signature });
const signatures = fc.array(seatSignature, { maxLength: 6 });
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });

describe("nullifier-key records", () => {
  test("decode(encode(r)) = r for both records", () => {
    fc.assert(
      fc.property(u64, bytes32, signatures, (deadline, keyId, approvals) => {
        const r = { deadline, keyId, approvals };
        expect(decodeNullifierKeyRecord(encodeNullifierKeyRecord(r))).toEqual(r);
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(
        bytes32,
        bytes32,
        u64,
        bytes32,
        signatures,
        signatures,
        (predecessor, newPanelId, deadline, keyId, consents, approvals) => {
          const r = { predecessor, newPanelId, deadline, keyId, consents, approvals };
          expect(decodeNullifierReshareRecord(encodeNullifierReshareRecord(r))).toEqual(r);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("bytes decode only if they re-encode to themselves", () => {
    const records = fc.oneof(
      fc.uint8Array({ maxLength: 300 }),
      fc
        .tuple(
          fc.uint8Array({ minLength: 40, maxLength: 40 }),
          fc.nat(4),
          fc.uint8Array({ maxLength: 300 }),
        )
        .map(([head, count, rest]) => Uint8Array.from([...head, count, ...rest])),
    );
    fc.assert(
      fc.property(records, (b) => {
        const k = decodeNullifierKeyRecord(b);
        if (k !== null) expect(encodeNullifierKeyRecord(k)).toEqual(b);
        const r = decodeNullifierReshareRecord(b);
        if (r !== null) expect(encodeNullifierReshareRecord(r)).toEqual(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("any flipped byte of the honest chain's records breaks the replay at that record", () => {
    const honest = V.replays.find((c) => c.id === "honest");
    if (honest === undefined) throw new Error("no honest replay");
    const events = honest.events.map(eventOf);
    fc.assert(
      fc.property(
        fc.nat(events.length - 1),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (at, offset, mask) => {
          const e = events[at] as NullifierKeyLogRecord;
          const record = Uint8Array.from(e.record);
          const i = offset % record.length;
          record[i] = (record[i] as number) ^ mask;
          const changed = events.map((x, j) => (j === at ? { ...x, record } : x));
          const r = replayNullifierKeyRecords(changed, PINS);
          expect(r.ok).toBe(false);
          if (!r.ok) {
            expect(r.at).toBe(at);
            expect(r.keys).toHaveLength(at);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("the replay takes its panels from the pins, never from the log", () => {
    const honest = V.replays.find((c) => c.id === "honest");
    if (honest === undefined) throw new Error("no honest replay");
    const events = honest.events.map(eventOf);
    // A release pinning only the initial panel: the reshare to next-4 is refused.
    const r = replayNullifierKeyRecords(events, { ...PINS, panels: [panelOf("initial-5")] });
    expect(r).toMatchObject({ ok: false, at: 1, reason: "panel" });
    // Another chain or registry: no signature verifies.
    for (const pins of [
      { ...PINS, l2ChainId: PINS.l2ChainId + 1n },
      { ...PINS, groupRegistry: new Uint8Array(20) },
    ])
      expect(replayNullifierKeyRecords(events, pins)).toMatchObject({
        ok: false,
        at: 0,
        reason: "signature",
      });
    // Another initial panel: its quorum and keys judge the first record.
    expect(
      replayNullifierKeyRecords(events, { ...PINS, initialPanel: panelOf("next-4") }),
    ).toMatchObject({ ok: false, at: 0 });
    expect(() =>
      replayNullifierKeyRecords(events, { ...PINS, initialPanel: panelOf("outside-3") }),
    ).toThrow(/initial panel/);
  });
});
