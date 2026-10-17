import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkAuthorApprovals,
  checkBallotV4,
  checkCeremonyTranscript,
  decodeBallot,
  decodeBoardEntry,
  decodeElectionDefinitionV6,
  type ElectionDefinitionV6,
  electionAuthorStubV6Hash,
  electionStubV6Hash,
  panelBallotElection,
  RECORD_TYPES,
  type RegisteredKeys,
} from "../src/index.ts";

// `panelBallotElection` beside an author panel (docs/spec/ballot-validity.md,
// Admission (version 4): the author panel's registered key set is its own
// run's, approved by its approvals): it takes only the key set
// `checkAuthorApprovals` approved under the definition's chain, trustee
// registry, author panel, author stub and author transcript, so no caller can
// pass seats it controls, or another run's, off as the author panel's (T-37,
// T-17). Fixtures: docs/spec/vectors/verifier-ballots-v4-author.json
// (packages/crypto/scripts/verifier-ballots-v4-author-vectors.py, an
// independent implementation), whose boards carry the author transcript, the
// default transcript and the approvals record, in that order, then ballots.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const file = JSON.parse(
  readFileSync(new URL("verifier-ballots-v4-author.json", VECTORS), "utf8"),
) as {
  readonly panel: { readonly threshold: string; readonly keys: readonly string[] };
  readonly cases: readonly {
    readonly id: string;
    readonly definition: string;
    readonly board: string;
  }[];
};
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const defaultPanel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };

// Board-entry version 7: a 51-byte envelope and its payload.
function payloads(board: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < board.length;) {
    const n = new DataView(board.buffer, board.byteOffset + at + 47, 4).getUint32(0);
    out.push(decodeBoardEntry(board.subarray(at, at + 51 + n), 7).payload);
    at += 51 + n;
  }
  return out;
}

function election(id: string) {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  const d = decodeElectionDefinitionV6(hex(c.definition));
  const [authorTranscript, defaultTranscript, ...rest] = payloads(hex(c.board)) as [
    Uint8Array,
    Uint8Array,
    ...Uint8Array[],
  ];
  const at = {
    l2ChainId: d.l2_chain_id,
    trusteeRegistry: d.trustee_registry,
    electionId: d.election_id,
  };
  const author = { threshold: d.author_threshold, keys: d.author_keys };
  const own = checkCeremonyTranscript(
    { ...at, stubHash: electionStubV6Hash(d), panel: defaultPanel, otherPanelKeys: d.author_keys },
    defaultTranscript,
    1,
  );
  const theirs = checkCeremonyTranscript(
    {
      ...at,
      stubHash: electionAuthorStubV6Hash(d),
      panel: author,
      panelKind: "author",
      otherPanelKeys: defaultPanel.keys,
    },
    authorTranscript,
    1,
  );
  if (!own.ok || !theirs.ok) throw new Error(`${id}: a run doesn't check`);
  const records = rest.filter(
    (p) => ((p[0] as number) << 8) + (p[1] as number) === RECORD_TYPES.authorApprovals,
  );
  const approve = () =>
    checkAuthorApprovals(
      {
        l2ChainId: d.l2_chain_id,
        trusteeRegistry: d.trustee_registry,
        authorStubHash: electionAuthorStubV6Hash(d),
        panel: author,
        authorTranscriptHash: d.author_transcript_hash,
        registered: theirs.registered,
      },
      records,
    );
  const ballots = rest.filter((p) => !records.includes(p));
  return { d, registered: own.registered, authorRegistered: theirs.registered, approve, ballots };
}

describe("panelBallotElection takes the author panel's approved key set", () => {
  test("once its approvals approve, and judges author halves against its seats", () => {
    const e = election("author-mixed");
    expect(e.approve()).toEqual({ ok: true, seats: [1, 2] });
    const context = panelBallotElection(e.d, e.registered, e.authorRegistered);
    expect(context.authorQualified).toEqual([1, 2]);
    expect(context.qualified).toEqual([1, 2, 3]);
    // The cell 0 ballot is admitted; the next unqualified one names author seat 3.
    const [first, , , unqualified] = e.ballots as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    expect(checkBallotV4(context, decodeBallot(first, 4)).ok).toBe(true);
    expect(checkBallotV4(context, decodeBallot(unqualified, 4))).toMatchObject({
      ok: false,
      code: "share-hash-unqualified",
      panel: 2,
      seat: 3,
    });
  });

  test("never one its transcript check returned alone, or whose approvals fall short", () => {
    const e = election("author-mixed");
    // No approvals check has run on this election's set yet.
    expect(() => panelBallotElection(e.d, e.registered, e.authorRegistered)).toThrow(
      /approved key set/,
    );
    const short = election("approvals-short");
    expect(short.approve()).toMatchObject({ ok: false, code: "author-approvals" });
    expect(() => panelBallotElection(short.d, short.registered, short.authorRegistered)).toThrow(
      /approved key set/,
    );
  });

  test("never with no author key set, a copy of it, or the default panel's", () => {
    const e = election("author-mixed");
    e.approve();
    for (const keys of [[], [...e.authorRegistered], e.registered] as RegisteredKeys[][])
      expect(() => panelBallotElection(e.d, e.registered, keys)).toThrow(/approved key set/);
    expect(() => panelBallotElection(e.d, e.registered)).toThrow(/approved key set/);
  });

  test("never another run's, even of the same election", () => {
    const e = election("author-mixed");
    const other = election("author-every-seat");
    expect(other.approve().ok).toBe(true);
    expect(() => panelBallotElection(e.d, e.registered, other.authorRegistered)).toThrow(
      /approved key set/,
    );
  });

  test("only for exactly the chain, registry, author panel, stub and transcript it was approved under", () => {
    const e = election("author-mixed");
    e.approve();
    // Each change leaves the default panel's transcript hash, so only the
    // author approval's context can refuse it.
    const changes: Partial<ElectionDefinitionV6>[] = [
      { l2_chain_id: e.d.l2_chain_id + 1n },
      { trustee_registry: new Uint8Array(20).fill(7) },
      { author_threshold: 1 },
      { election_id: new Uint8Array(32).fill(7) },
      { author_transcript_hash: new Uint8Array(32).fill(7) },
    ];
    for (const change of changes)
      expect(() =>
        panelBallotElection({ ...e.d, ...change }, e.registered, e.authorRegistered),
      ).toThrow(/approved key set/);
  });

  test("and refuses any author key set beside a definition without an author panel", () => {
    const e = election("author-mixed");
    e.approve();
    const plain: ElectionDefinitionV6 = {
      ...e.d,
      author_threshold: 0,
      author_keys: [],
      author_transcript_hash: new Uint8Array(32),
    };
    expect(panelBallotElection(plain, e.registered).authorPanelSize).toBe(0);
    expect(() => panelBallotElection(plain, e.registered, e.authorRegistered)).toThrow(
      /no author panel/,
    );
  });
});
