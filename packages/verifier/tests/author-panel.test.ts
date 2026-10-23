import { readFileSync } from "node:fs";
import {
  ceremonyTranscriptHash,
  decodeElectionDefinition,
  decodeElectionDefinitionV6,
  encodeBoardEntry,
  encodeElectionDefinitionV6,
  panelId,
  POLL_CLASSES,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { type AuthorRun, ceremonyChecks } from "../src/ceremony.ts";
import { authorRunOf, decodeDefinition } from "../src/definition.ts";
import { PINNED_PANELS, type PinnedPanel } from "../src/panels.ts";
import {
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  electionAdmission,
  parseBundle,
  verifyBundle,
} from "../src/index.ts";

// The ceremony of an election with an author panel (docs/spec/verifier.md,
// 2.5, 3.1, 3.2 and Key ceremony; docs/spec/ceremony.md, Author panel):
// 2.5's `default-seat`, the default run's `duplicate-key` over the author
// keys, and 3.1 and 3.2 per panel: the author panel's transcript, found by
// `author_transcript_hash` and checked under its own context, quorum and
// participation, and its approvals records on the board (T-14, T-37, T-54,
// T-17). Fixtures: docs/spec/vectors/author-ceremony.json (packages/crypto/
// scripts/author-ceremony-vectors.py, an independent implementation), whose
// default run's seat 3 registers author seat 1's identity key as its
// signing key, and whose author runs and approvals records are of the same
// election.
const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface PanelJson {
  readonly threshold: number;
  readonly keys: readonly string[];
}
const file = read("author-ceremony.json") as {
  readonly election: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, PanelJson>>;
  readonly transcripts: readonly {
    readonly id: string;
    readonly panel: string;
    readonly transcript: string;
    readonly result: { readonly hash: string };
  }[];
  readonly records: readonly { readonly id: string; readonly record: string }[];
  readonly approvals: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly records: readonly string[];
    readonly result:
      | { readonly ok: true; readonly seats: readonly number[] }
      | { readonly ok: false; readonly code: string; readonly seats?: readonly number[] };
  }[];
};
// The same election's author panel registered on L2: the election registry's
// `AuthorPanelRegistered` under contract-event version 9, with the
// definition's L2 contracts and hash (docs/spec/vectors/author-registration.json,
// packages/crypto/scripts/author-registration-vectors.py, an independent
// implementation; ceremony.md, Author panel, The registration's approvals).
const registrations = read("author-registration.json") as {
  readonly election: {
    readonly definitionHash: string;
    readonly contracts: Readonly<
      Record<"election-registry" | "trustee-registry" | "group-registry" | "board", string>
    >;
  };
  readonly events: readonly {
    readonly id: string;
    readonly record: string;
    readonly read: boolean;
  }[];
  readonly cases: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly records: readonly string[];
    readonly events: readonly string[];
    readonly recorded?: string;
    readonly result:
      | { readonly ok: true; readonly seats: readonly number[] }
      | { readonly ok: false; readonly code: string; readonly seats?: readonly number[] };
  }[];
};
const definitions = read("election-definition.json") as {
  readonly vectors: readonly { readonly id: string; readonly encoding: string }[];
};

const panelOf = (name: string) => {
  const p = file.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
};
const transcriptOf = (id: string) => {
  const t = file.transcripts.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no transcript ${id}`);
  return t;
};
const recordOf = (id: string) => {
  const r = file.records.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no record ${id}`);
  return hex(r.record);
};
const run = transcriptOf("default-duplicate-author");
const defaultPanel = panelOf(run.panel);
const authorKeys = panelOf("author-3").keys;
const election = file.election as Record<
  "l2ChainId" | "trusteeRegistry" | "electionId" | "stubHash" | "authorStubHash",
  string
>;
/** The definition's author panel as its run binds it, for one of the vectors' author runs. */
const authorRun = (id: string): AuthorRun => {
  const t = transcriptOf(id);
  return {
    panel: panelOf(t.panel),
    stubHash: hex(election.authorStubHash),
    transcriptHash: hex(t.result.hash),
    definitionHash: hex(registrations.election.definitionHash),
  };
};

// The fields the ceremony checks read, the same in every definition version:
// the typical version-1 profile (transcript version 1) and the vector's
// election, its L2 contracts, its default panel and its transcript's hash.
const typical = definitions.vectors.find((v) => v.id === "definition-typical");
if (typical === undefined) throw new Error("no typical definition");
const d = {
  profile: decodeElectionDefinition(hex(typical.encoding)).profile,
  election_id: hex(election.electionId),
  l2_chain_id: BigInt(election.l2ChainId),
  election_registry: hex(registrations.election.contracts["election-registry"]),
  trustee_registry: hex(election.trusteeRegistry),
  group_registry: hex(registrations.election.contracts["group-registry"]),
  board: hex(registrations.election.contracts.board),
  panel_id: panelId(defaultPanel),
  threshold: defaultPanel.threshold,
  panel_size: defaultPanel.keys.length,
  ceremony_transcript_hash: hex(run.result.hash),
};
/** A version-7 board copy of this election carrying `payloads` in order. */
const board = (...payloads: readonly Uint8Array[]) =>
  payloads.map((payload, i) =>
    encodeBoardEntry({ election_id: d.election_id, index: BigInt(i), segment: 0, payload }, 7),
  );
const defaultTranscript = hex(run.transcript);
const entries = board(defaultTranscript);
const check = (author: AuthorRun | undefined, copy = entries) =>
  ceremonyChecks(d, hex(election.stubHash), defaultPanel, author, copy, 7);
/** An author run whose keys are `keys`, for the checks that precede its transcript. */
const keysOnly = (keys: readonly Uint8Array[]): AuthorRun => ({
  ...authorRun("author-honest-3"),
  panel: { threshold: 1, keys },
});
const honest = authorRun("author-honest-3");
const honestTranscript = hex(transcriptOf("author-honest-3").transcript);

describe("the default panel beside an author panel", () => {
  test("the default run's duplicate-key reads the author keys", () => {
    // Seat 3's signing key is author seat 1's identity key: it qualifies
    // only when the run doesn't know the author panel.
    expect(check(undefined).report?.seats).toEqual(
      [1, 2, 3, 4].map((index) => ({ index, reasons: [] })),
    );
    expect(check(honest).report?.seats).toEqual([
      { index: 1, reasons: [] },
      { index: 2, reasons: [] },
      { index: 3, reasons: ["duplicate-key"] },
      { index: 4, reasons: [] },
    ]);
  });

  test("3.2 passes without an author panel, and beside one only once its run is checked", () => {
    const alone = check(undefined);
    expect(alone.rows.get("3.2")).toEqual({ status: "pass" });
    expect(alone.registered).toHaveLength(4);
    // Three of four seats meet k = 3 and rule 7's n − 1 = 3, but that is the
    // default panel's half of 3.2: with no author transcript on the copy,
    // no key set is returned for one half.
    const beside = check(honest);
    expect(beside.rows.get("3.2")).toEqual({ status: "unverifiable", code: "not-reached" });
    expect(beside.registered).toBeUndefined();
    expect(beside.report?.registered).toHaveLength(3);
    expect(beside.report?.author).toBeUndefined();
  });

  test("2.5 fails `default-seat` at the first author seat holding a default seat's key", () => {
    expect(check(honest).rows.get("2.5")).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
    const [q1, q2] = defaultPanel.keys;
    const [a1] = authorKeys;
    if (q1 === undefined || q2 === undefined || a1 === undefined) throw new Error("short panels");
    for (const [author, seat] of [
      [[q1], 1],
      [[a1, q2], 2],
      [[a1, q2, q1], 2],
      [[a1, Uint8Array.from(q1)], 2],
    ] as const) {
      const r = check(keysOnly(author));
      expect(r.rows.get("2.5")).toEqual({ status: "fail", code: "default-seat", at: { seat } });
      // The transcript is still checked: 3.1 and 3.2 report what it holds.
      expect(r.report).toBeDefined();
    }
  });

  test("another panel is `panel-unpinned` before `default-seat`", () => {
    const r = ceremonyChecks(
      { ...d, threshold: d.threshold - 1 },
      hex(election.stubHash),
      defaultPanel,
      keysOnly(defaultPanel.keys),
      entries,
      7,
    );
    expect(r.rows.get("2.5")).toEqual({ status: "fail", code: "panel-unpinned", at: {} });
  });
});

// 2.5's `panel-kind` (docs/spec/verifier.md, Key ceremony, step 1): a poll
// on the civic record fails under a default panel the release pins as
// transitional, and is never failed under one it doesn't pin (T-14, T-36).
type PollClass = (typeof POLL_CLASSES)[keyof typeof POLL_CLASSES];
describe("panel-kind", () => {
  const id = Buffer.from(d.panel_id).toString("hex");
  const pinnedAs = (kind: PinnedPanel["kind"]): PinnedPanel[] => [{ panelId: id, kind, seats: [] }];
  const civic = [POLL_CLASSES.organisational, POLL_CLASSES.civicReferendum];
  const classed = (
    poll_class: PollClass,
    author: AuthorRun | undefined,
    pins: PinnedPanel[],
    copy = entries,
  ) =>
    ceremonyChecks(
      { ...d, poll_class },
      hex(election.stubHash),
      defaultPanel,
      author,
      copy,
      7,
      pins,
    );
  const KIND = { status: "fail", code: "panel-kind", at: {} };

  test("fails a poll on the civic record under a panel the release pins as transitional", () => {
    for (const poll_class of civic) {
      const r = classed(poll_class, undefined, pinnedAs("transitional"));
      expect(r.rows.get("2.5"), String(poll_class)).toEqual(KIND);
      // The transcript is still checked, but no ballot is judged against
      // the key set of an election 2.5 fails.
      expect(r.rows.get("3.2"), String(poll_class)).toEqual({ status: "pass" });
      expect(r.report?.registered, String(poll_class)).toHaveLength(4);
      expect(r.registered, String(poll_class)).toBeUndefined();
    }
  });

  test("passes an everyday poll under a transitional panel, and the civic record under an independent one", () => {
    for (const [poll_class, kind] of [
      [POLL_CLASSES.everyday, "transitional"],
      [POLL_CLASSES.everyday, "independent"],
      ...civic.map((c) => [c, "independent"] as const),
    ] as const) {
      const r = classed(poll_class, undefined, pinnedAs(kind));
      expect(r.rows.get("2.5"), `${poll_class} ${kind}`).toEqual({
        status: "unverifiable",
        code: "not-implemented",
      });
      expect(r.registered, `${poll_class} ${kind}`).toHaveLength(4);
    }
  });

  test("leaves a panel the release doesn't pin undecided, never failed", () => {
    const other: PinnedPanel[] = [{ panelId: "00".repeat(32), kind: "transitional", seats: [] }];
    for (const pins of [[], other, PINNED_PANELS])
      for (const poll_class of civic) {
        const r = classed(poll_class, undefined, [...pins]);
        expect(r.rows.get("2.5")).toEqual({ status: "unverifiable", code: "not-implemented" });
        expect(r.registered).toHaveLength(4);
      }
  });

  test("a definition without a poll class (versions 1 to 5) is never failed on it", () => {
    const r = ceremonyChecks(
      d,
      hex(election.stubHash),
      defaultPanel,
      undefined,
      entries,
      7,
      pinnedAs("transitional"),
    );
    expect(r.rows.get("2.5")).toEqual({ status: "unverifiable", code: "not-implemented" });
  });

  test("is reported before default-seat, and panel-unpinned before it", () => {
    const [q1] = defaultPanel.keys;
    if (q1 === undefined) throw new Error("short panel");
    const transitional = pinnedAs("transitional");
    expect(
      classed(POLL_CLASSES.civicReferendum, keysOnly([q1]), transitional).rows.get("2.5"),
    ).toEqual(KIND);
    // Beside an author panel whose run and approvals hold, no key set either.
    const beside = classed(
      POLL_CLASSES.civicReferendum,
      honest,
      transitional,
      board(defaultTranscript, honestTranscript, recordOf("all")),
    );
    expect(beside.rows.get("2.5")).toEqual(KIND);
    expect(beside.rows.get("3.2")).toEqual({ status: "pass" });
    expect(beside.registered).toBeUndefined();
    // Without the pin, the same definition fails on its shared seat.
    expect(classed(POLL_CLASSES.civicReferendum, keysOnly([q1]), []).rows.get("2.5")).toEqual({
      status: "fail",
      code: "default-seat",
      at: { seat: 1 },
    });
    const r = ceremonyChecks(
      { ...d, poll_class: POLL_CLASSES.civicReferendum, threshold: d.threshold - 1 },
      hex(election.stubHash),
      defaultPanel,
      undefined,
      entries,
      7,
      transitional,
    );
    expect(r.rows.get("2.5")).toEqual({ status: "fail", code: "panel-unpinned", at: {} });
  });

  test("this release's pins name each panel once, by its identifier, with a kind", () => {
    const ids = PINNED_PANELS.map((p) => p.panelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PINNED_PANELS) {
      expect(p.panelId).toMatch(/^[0-9a-f]{64}$/);
      expect(["independent", "transitional"]).toContain(p.kind);
    }
  });
});

describe("the author panel's run", () => {
  test("3.1 and 3.2 hold for both panels with the author transcript and its approvals on the board", () => {
    const r = check(honest, board(defaultTranscript, honestTranscript, recordOf("all")));
    expect(r.rows.get("3.2")).toEqual({ status: "pass" });
    // The default panel's registration on L2 isn't read: 3.1 never passes.
    expect(r.rows.get("3.1")).toEqual({ status: "unverifiable", code: "not-implemented" });
    expect(r.registered).toHaveLength(3);
    expect(r.report?.author).toMatchObject({
      entry: 1,
      seats: [1, 2, 3].map((index) => ({ index, reasons: [] })),
      approvals: [1, 2, 3],
    });
    expect(r.report?.author?.registered).toHaveLength(3);
  });

  test("every approvals vector decides 3.1's author part as the spec's check does", () => {
    for (const a of file.approvals) {
      const t = transcriptOf(a.transcript);
      const r = check(
        authorRun(a.transcript),
        board(defaultTranscript, hex(t.transcript), ...a.records.map(hex)),
      );
      const r31 = r.rows.get("3.1");
      const r32 = r.rows.get("3.2");
      if (a.result.ok) {
        expect(r31, a.id).toEqual({ status: "unverifiable", code: "not-implemented" });
        expect(r32, a.id).toEqual({ status: "pass" });
      } else if (a.result.code === "ceremony-participation") {
        expect(r32, a.id).toEqual({
          status: "fail",
          code: "ceremony-participation",
          at: { entry: 1, panel: "author" },
        });
        expect(r31, a.id).toEqual({ status: "unverifiable", code: "not-reached" });
        expect(r.registered, a.id).toBeUndefined();
        continue;
      } else if (a.result.code === "author-approvals") {
        expect(r31, a.id).toEqual({
          status: "fail",
          code: "author-approvals",
          at: { panel: "author" },
        });
      } else {
        expect(r31, a.id).toEqual({
          status: "unverifiable",
          code: "author-approvals-missing",
          at: { panel: "author" },
        });
      }
      expect(r.report?.author?.approvals, a.id).toEqual(a.result.seats ?? []);
    }
  }, 120_000);

  test("approvals count wherever they sit, and another election's don't count", () => {
    const quorum = recordOf("quorum");
    // Before the transcript, and split across records.
    expect(
      check(
        honest,
        board(recordOf("seat-1"), defaultTranscript, recordOf("seat-3"), honestTranscript),
      ).report?.author?.approvals,
    ).toEqual([1, 3]);
    const elsewhere = [
      ...board(defaultTranscript, honestTranscript),
      encodeBoardEntry(
        { election_id: new Uint8Array(32).fill(9), index: 2n, segment: 0, payload: quorum },
        7,
      ),
    ];
    expect(check(honest, elsewhere).rows.get("3.1")).toEqual({
      status: "unverifiable",
      code: "author-approvals-missing",
      at: { panel: "author" },
    });
  });

  test("a copy without the author transcript leaves 3.1 unverifiable and 3.2 not reached", () => {
    const r = check(honest, board(defaultTranscript, recordOf("all")));
    expect(r.rows.get("3.1")).toEqual({
      status: "unverifiable",
      code: "ceremony-transcript-missing",
      at: { panel: "author" },
    });
    expect(r.rows.get("3.2")).toEqual({ status: "unverifiable", code: "not-reached" });
  });

  test("bytes the author transcript hash binds that aren't its transcript fail 3.1, naming the panel", () => {
    // The default transcript's bytes are a transcript, but not the author
    // panel's: its four seats aren't the author panel's three.
    const bad = { ...honest, transcriptHash: hex(run.result.hash) };
    expect(check(bad).rows.get("3.1")).toEqual({
      status: "fail",
      code: "ceremony-order",
      at: { entry: 0, panel: "author" },
    });
    const junk = new Uint8Array([0x00, 0x05, 0x01, 0xff]);
    const r = check(
      { ...honest, transcriptHash: ceremonyTranscriptHash(junk) },
      board(defaultTranscript, junk),
    );
    expect(r.rows.get("3.1")).toMatchObject({
      status: "fail",
      code: "decode",
      at: { entry: 1, panel: "author" },
    });
    expect(r.rows.get("3.2")).toEqual({ status: "unverifiable", code: "not-reached" });
  });

  test("the author run's duplicate-key reads the default panel's keys", () => {
    const r = check(
      authorRun("author-duplicate-default"),
      board(defaultTranscript, hex(transcriptOf("author-duplicate-default").transcript)),
    );
    expect(r.report?.author?.seats.filter((s) => s.reasons.length > 0)).toEqual([
      expect.objectContaining({ reasons: ["duplicate-key"] }),
    ]);
  });

  test("the author run is checked under author_stub_hash, never the default stub", () => {
    const r = check(
      { ...honest, stubHash: hex(election.stubHash) },
      board(defaultTranscript, honestTranscript, recordOf("all")),
    );
    expect(r.rows.get("3.1")).toMatchObject({ status: "fail", at: { entry: 1, panel: "author" } });
    expect(r.registered).toBeUndefined();
  });

  test("no key set is returned while the approvals don't approve or an author seat is a default seat", () => {
    expect(
      check(honest, board(defaultTranscript, honestTranscript, recordOf("seat-1"))).registered,
    ).toBeUndefined();
    expect(check(honest, board(defaultTranscript, honestTranscript)).registered).toBeUndefined();
  });

  test("an author panel's failure beats the default panel's missing transcript on 3.1", () => {
    const r = check(honest, board(honestTranscript, recordOf("seat-1")));
    expect(r.rows.get("3.1")).toEqual({
      status: "fail",
      code: "author-approvals",
      at: { panel: "author" },
    });
  });

  test("the default panel's missing transcript is reported before the author panel's unreached rows", () => {
    const r = check(honest, board(honestTranscript));
    expect(r.rows.get("3.1")).toEqual({
      status: "unverifiable",
      code: "ceremony-transcript-missing",
      at: {},
    });
    expect(r.rows.get("3.2")).toEqual({ status: "unverifiable", code: "not-reached" });
    // The author run is still checked, but nothing is reported without the default run's.
    expect(r.report).toBeUndefined();
    const short = check(
      authorRun("author-short"),
      board(hex(transcriptOf("author-short").transcript)),
    );
    expect(short.rows.get("3.2")).toEqual({
      status: "fail",
      code: "ceremony-participation",
      at: { entry: 0, panel: "author" },
    });
  });
});

// The same through a format-4 bundle and the API's admission, under a
// version-6 definition naming the vector's default panel: its transcript was
// made for another stub, so only what precedes the transcript is decided.
describe("the author panel's registration on L2", () => {
  // The definition under a profile pinning contract-event version 9, the
  // first whose tables name `AuthorPanelRegistered`.
  const pinning = (version: number) => ({
    ...d,
    profile: {
      ...d.profile,
      pins: d.profile.pins.map((p) =>
        p.record_type === RECORD_TYPES.contractEvent ? { ...p, version } : p,
      ),
    },
  });
  const d9 = pinning(9);
  const eventOf = (id: string) => {
    const e = registrations.events.find((x) => x.id === id);
    if (e === undefined) throw new Error(`no event ${id}`);
    return hex(e.record);
  };
  const copyOf = (c: (typeof registrations.cases)[number]) =>
    board(
      defaultTranscript,
      hex(transcriptOf(c.transcript).transcript),
      ...c.records.map(recordOf),
      ...c.events.map(eventOf),
    );

  test("every registration vector decides 3.1's author part as the spec's check does", () => {
    // The verifier authenticates no registration yet (4.4's replay, the L2
    // reads), so the cases that need the recorded one aren't its.
    for (const c of registrations.cases.filter((x) => x.recorded === undefined)) {
      const r = ceremonyChecks(
        d9,
        hex(election.stubHash),
        defaultPanel,
        authorRun(c.transcript),
        copyOf(c),
        7,
      );
      const r31 = r.rows.get("3.1");
      if (c.result.ok) {
        expect(r31, c.id).toEqual({ status: "unverifiable", code: "not-implemented" });
        // The author key set is registered only when they approve (T-37).
        expect(r.authorRegistered, c.id).toBeDefined();
      } else if (c.result.code === "ceremony-participation") {
        expect(r.rows.get("3.2"), c.id).toMatchObject({
          status: "fail",
          code: "ceremony-participation",
          at: { panel: "author" },
        });
        expect(r31, c.id).toEqual({ status: "unverifiable", code: "not-reached" });
        expect(r.registered, c.id).toBeUndefined();
        continue;
      } else {
        expect(r31, c.id).toEqual(
          c.result.code === "author-approvals-missing"
            ? { status: "unverifiable", code: c.result.code, at: { panel: "author" } }
            : { status: "fail", code: c.result.code, at: { panel: "author" } },
        );
        // No key set is registered for the checks below (T-37).
        expect(r.registered, c.id).toBeUndefined();
        expect(r.authorRegistered, c.id).toBeUndefined();
      }
      expect(r.report?.author?.approvals, c.id).toEqual(c.result.seats ?? []);
    }
  }, 120_000);

  test("under contract-event version 8, which names no such event, no registration is read", () => {
    for (const c of registrations.cases.filter(
      (x) => x.records.length === 0 && x.transcript === "author-honest-3",
    )) {
      const r = ceremonyChecks(
        pinning(8),
        hex(election.stubHash),
        defaultPanel,
        authorRun(c.transcript),
        copyOf(c),
        7,
      );
      expect(r.rows.get("3.1"), c.id).toEqual({
        status: "unverifiable",
        code: "author-approvals-missing",
        at: { panel: "author" },
      });
    }
  });

  test("a registration counts wherever it sits, and another election's entry doesn't", () => {
    const all = eventOf("all");
    const first = ceremonyChecks(
      d9,
      hex(election.stubHash),
      defaultPanel,
      honest,
      board(all, defaultTranscript, honestTranscript),
      7,
    );
    expect(first.report?.author?.approvals).toEqual([1, 2, 3]);
    expect(first.authorRegistered).toHaveLength(3);
    const elsewhere = [
      ...board(defaultTranscript, honestTranscript),
      encodeBoardEntry(
        { election_id: new Uint8Array(32).fill(9), index: 2n, segment: 0, payload: all },
        7,
      ),
    ];
    expect(
      ceremonyChecks(d9, hex(election.stubHash), defaultPanel, honest, elsewhere, 7).rows.get(
        "3.1",
      ),
    ).toEqual({
      status: "unverifiable",
      code: "author-approvals-missing",
      at: { panel: "author" },
    });
  });

  test("a registration names its own definition: another definition's hash isn't read", () => {
    const r = ceremonyChecks(
      d9,
      hex(election.stubHash),
      defaultPanel,
      { ...honest, definitionHash: new Uint8Array(32).fill(1) },
      board(defaultTranscript, honestTranscript, eventOf("all")),
      7,
    );
    expect(r.rows.get("3.1")).toEqual({
      status: "unverifiable",
      code: "author-approvals-missing",
      at: { panel: "author" },
    });
  });

  test("a registration of another key set on the copy never fails 3.1", () => {
    // A quorum-signed registration over another key set, as the copy's last
    // entry, where no anchor need cover it: the registry recorded one
    // registration, which isn't read yet, so this one only fails to add
    // approvals (T-53).
    const r = ceremonyChecks(
      d9,
      hex(election.stubHash),
      defaultPanel,
      honest,
      board(defaultTranscript, honestTranscript, recordOf("all"), eventOf("other-key-set")),
      7,
    );
    expect(r.rows.get("3.1")).toEqual({ status: "unverifiable", code: "not-implemented" });
    expect(r.report?.author?.approvals).toEqual([1, 2, 3]);
    expect(r.authorRegistered).toHaveLength(3);
  });
});

describe("a version-6 definition beside the default panel", () => {
  const l1File = read("l1-anchor.json") as {
    readonly clock: Readonly<Record<string, string>>;
    readonly electionId: string;
    readonly vectors: readonly {
      readonly id: string;
      readonly anchor: string;
      readonly firstSegment: string;
      readonly block: { readonly header: string };
      readonly nodes: readonly string[];
      readonly checkpoints: readonly string[];
    }[];
  };
  const closed = l1File.vectors.find((v) => v.id === "closed");
  if (closed === undefined) throw new Error("no closed L1 vector");
  const v6File = read("election-definition-v6.json") as {
    readonly vectors: readonly { readonly id: string; readonly encoding: string }[];
  };
  const minimal = v6File.vectors.find((v) => v.id === "definition-v6-minimal");
  if (minimal === undefined) throw new Error("no minimal version-6 definition");
  const base = decodeElectionDefinitionV6(hex(minimal.encoding));
  const FITTING: Readonly<Record<number, number>> = {
    [RECORD_TYPES.ballot]: 4,
    [RECORD_TYPES.spoiledBallotOpening]: 3,
    [RECORD_TYPES.tallyOpening]: 1,
    [RECORD_TYPES.boardEntry]: 5,
    [RECORD_TYPES.contractEvent]: 8,
    [RECORD_TYPES.displayText]: 2,
  };
  const definition = (author: readonly Uint8Array[], poll_class = base.poll_class) =>
    encodeElectionDefinitionV6({
      ...base,
      poll_class,
      election_id: hex(l1File.electionId),
      l1_anchor: hex(closed.anchor),
      panel_id: panelId(defaultPanel),
      threshold: defaultPanel.threshold,
      panel_size: defaultPanel.keys.length,
      author_threshold: author.length === 0 ? 0 : 1,
      author_keys: [...author],
      author_transcript_hash: new Uint8Array(32).fill(author.length === 0 ? 0 : 7),
      profile: {
        ...base.profile,
        pins: base.profile.pins.map((p) => ({
          ...p,
          version: FITTING[p.record_type] ?? p.version,
        })),
      },
    });
  const panelJson = {
    threshold: String(defaultPanel.threshold),
    keys: defaultPanel.keys.map((k) => Buffer.from(k).toString("hex")),
  };
  const format4 = (bytes: Uint8Array) =>
    verifyBundle(
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT_CEREMONY,
          definition: Buffer.from(bytes).toString("hex"),
          clock: l1File.clock,
          l1: {
            firstSegment: closed.firstSegment,
            header: closed.block.header,
            nodes: closed.nodes,
            checkpoints: closed.checkpoints,
          },
          panel: panelJson,
        }),
        new Uint8Array(),
      ),
    );
  const row = (r: ReturnType<typeof verifyBundle>, id: string) =>
    r.checks.find((c) => c.id === id) as CheckResult;
  const [q1, q2] = defaultPanel.keys;
  const [a1] = authorKeys;
  if (q1 === undefined || q2 === undefined || a1 === undefined) throw new Error("short panels");

  test("the report fails 2.5 with default-seat at its seat, beside 2.3's author-panel refusal", () => {
    const r = format4(definition([a1, q2]));
    expect(row(r, "2.1").status).not.toBe("fail");
    expect(row(r, "2.5")).toMatchObject({ status: "fail", code: "default-seat", at: { seat: 2 } });
    expect(row(r, "2.3")).toMatchObject({ status: "fail", code: "profile-combination" });
    expect(row(r, "3.2").status).not.toBe("pass");
    expect(r.verdictAgainstInputs).toBe("failed");
  });

  test("without an author panel 2.5 isn't failed, and no ballot is reached without the transcript", () => {
    const r = format4(definition([]));
    expect(row(r, "2.5")).toMatchObject({ status: "unverifiable" });
    expect(row(r, "2.3").status).not.toBe("fail");
    expect(row(r, "3.1")).toMatchObject({ code: "ceremony-transcript-missing" });
    for (const id of ["5.1", "5.4", "6.2", "7.4"]) expect(row(r, id).status).toBe("unverifiable");
  });

  test("a poll on the civic record under a panel this release doesn't pin isn't failed on its kind", () => {
    const r = format4(definition([], POLL_CLASSES.civicReferendum));
    expect(row(r, "2.1").status).not.toBe("fail");
    expect(row(r, "2.5")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
  });

  test("the API's admission refuses an author panel at 2.3, and a sealed poll before its transcript", () => {
    expect(electionAdmission(definition([a1]), defaultPanel, [])).toEqual({
      ok: false,
      code: "profile-combination",
    });
    expect(electionAdmission(definition([]), defaultPanel, [])).toEqual({
      ok: false,
      code: "ceremony-transcript-missing",
    });
  });
});

describe("authorRunOf", () => {
  const v6 = read("election-definition-v6.json") as {
    readonly vectors: readonly {
      readonly id: string;
      readonly encoding: string;
      readonly hash?: string;
      readonly authorStubHash?: string;
    }[];
  };

  test("binds the definition's author panel, transcript hash, hash and the spec's author stub hash", () => {
    let seen = 0;
    for (const v of v6.vectors) {
      if (v.authorStubHash === undefined) continue;
      let record;
      try {
        record = decodeDefinition(hex(v.encoding));
      } catch {
        continue;
      }
      if (record.version !== 6) continue;
      const run = authorRunOf(record);
      if (record.value.author_keys.length === 0) {
        expect(run, v.id).toBeUndefined();
        continue;
      }
      seen++;
      if (run === undefined) throw new Error(`${v.id}: no author run`);
      expect(Buffer.from(run.stubHash).toString("hex"), v.id).toBe(v.authorStubHash);
      // The hash its `AuthorPanelRegistered` names (3.1).
      expect(Buffer.from(run.definitionHash).toString("hex"), v.id).toBe(v.hash);
      expect(run.transcriptHash, v.id).toEqual(record.value.author_transcript_hash);
      expect(run.panel, v.id).toEqual({
        threshold: record.value.author_threshold,
        keys: record.value.author_keys,
      });
    }
    expect(seen).toBeGreaterThan(0);
  });
});
