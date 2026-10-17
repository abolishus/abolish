import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkAuthorApprovals,
  checkBallotV4,
  checkCeremonyTranscript,
  checkChallengeOpeningV3,
  decodeBallot,
  decodeBoardEntry,
  decodeElectionDefinitionV6,
  type ElectionDefinitionV6,
  electionAuthorStubV6Hash,
  electionStubV6Hash,
  encryptSharesV4,
  type KemPublicKey,
  openChallengeV3,
  panelBallotCore,
  panelBallotElection,
  panelTrackingCode,
  RECORD_TYPES,
  type RegisteredKeys,
  shareVoteV4,
} from "../src/index.ts";
import { panelBallotElectionWith } from "../src/ballot.ts";
import { checkChallengeOpeningV3With, coreHashV4 } from "../src/challenge.ts";

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
  return {
    d,
    author,
    records,
    registered: own.registered,
    authorRegistered: theirs.registered,
    approve,
    ballots,
  };
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
      // Another author key at the same threshold.
      { author_keys: [...e.d.author_keys.slice(0, 2), defaultPanel.keys[0] as Uint8Array] },
      { election_id: new Uint8Array(32).fill(7) },
      // A field only the stubs bind.
      { opens_at: e.d.opens_at - 1n },
      { author_transcript_hash: new Uint8Array(32).fill(7) },
    ];
    for (const change of changes)
      expect(() =>
        panelBallotElection({ ...e.d, ...change }, e.registered, e.authorRegistered),
      ).toThrow(/approved key set/);
  });

  test("never under a context changed while its records are read", () => {
    // The registry and stub bytes the approvals verify under are the ones
    // marked: overwriting the caller's buffers after the last record can't
    // move the approval to another definition (T-37).
    const e = election("author-mixed");
    const alt = { ...e.d, trustee_registry: new Uint8Array(20).fill(7) };
    const trusteeRegistry = Uint8Array.from(e.d.trustee_registry);
    const authorStubHash = electionAuthorStubV6Hash(e.d);
    const records = e.records;
    function* thenOverwrite() {
      yield* records;
      trusteeRegistry.set(alt.trustee_registry);
      authorStubHash.set(electionAuthorStubV6Hash(alt));
    }
    const approved = checkAuthorApprovals(
      {
        l2ChainId: e.d.l2_chain_id,
        trusteeRegistry,
        authorStubHash,
        panel: e.author,
        authorTranscriptHash: e.d.author_transcript_hash,
        registered: e.authorRegistered,
      },
      thenOverwrite() as unknown as readonly Uint8Array[],
    );
    expect(approved.ok).toBe(true);
    expect(() => panelBallotElection(alt, e.registered, e.authorRegistered)).toThrow(
      /approved key set/,
    );
    expect(panelBallotElection(e.d, e.registered, e.authorRegistered).authorQualified).toEqual([
      1, 2,
    ]);
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

// The cell 0 ballot's votes: one of three, two of four, one of two.
const VOTES = [0, 1, 0, 1, 0, 0, 1, 0, 1] as const;

// A key for every seat in seat order, as the client encrypts to; a seat
// outside the registered set gets another seat's, whose share hash the core
// zeroes anyway.
const seatKeys = (registered: readonly RegisteredKeys[], n: number): KemPublicKey[] =>
  Array.from(
    { length: n },
    (_, i) => (registered.find((k) => k.index === i + 1) ?? registered[0])?.kemKey as KemPublicKey,
  );

describe("openings beside an author panel take its approved key set", () => {
  function approvedPoll() {
    const e = election("author-mixed");
    e.approve();
    const context = panelBallotElection(e.d, e.registered, e.authorRegistered);
    const encrypt = () =>
      encryptSharesV4(
        { definitionHash: context.definitionHash },
        shareVoteV4(context, VOTES),
        seatKeys(e.registered, context.panelSize),
        seatKeys(e.authorRegistered, context.authorPanelSize),
      );
    return { e, context, encrypt };
  }

  test("an honest client's opening passes under the context, both halves, with the code shown before the choice", () => {
    const { e, context, encrypt } = approvedPoll();
    const encrypted = encrypt();
    const shown = panelTrackingCode(context, 0, encrypted);
    const core = panelBallotCore(context, 0, encrypted);
    // Author seat 3 isn't registered: its share hash is zero and it reveals nothing.
    expect(core.authorShareHashes[2]).toEqual(new Uint8Array(32));
    expect(core.authorShareHashes.slice(0, 2).every((h) => h.some((b) => b !== 0))).toBe(true);
    const { opening, coreHash } = openChallengeV3(context, 0, encrypted);
    expect(coreHash).toEqual(shown);
    expect(coreHashV4(core)).toEqual(shown);
    expect(opening.author_seats.map((s) => s.seat)).toEqual([1, 2]);
    expect(opening.author_polynomials).toHaveLength(VOTES.length);
    const result = checkChallengeOpeningV3(context, opening);
    if (!result.ok) throw new Error(`expected a passing opening, got ${result.code}`);
    expect(result.coreHash).toEqual(shown);
    expect(result.votes).toEqual(VOTES.map(BigInt));
    expect(result.withinRules).toBe(true);
    // The same verdict as the internal path given the same seats.
    expect(checkChallengeOpeningV3With(context, e.authorRegistered, opening)).toEqual(result);
  });

  test("an author seat's ciphertext is rebuilt under the approved key, so one made to another key fails that seat", () => {
    const { e, context } = approvedPoll();
    const [first, second] = e.authorRegistered as [RegisteredKeys, RegisteredKeys];
    // Author seat 2's shares encrypted to seat 1's key: the opening's share
    // hash is that ciphertext's, which no approved seat 2 decrypts.
    const encrypted = encryptSharesV4(
      { definitionHash: context.definitionHash },
      shareVoteV4(context, VOTES),
      seatKeys(e.registered, context.panelSize),
      [first.kemKey, first.kemKey, second.kemKey],
    );
    expect(() => openChallengeV3(context, 0, encrypted)).toThrow(/registered key/);
  });

  test("a context whose author seats no approvals check vouched for is refused", () => {
    const { e, encrypt } = approvedPoll();
    const unchecked = panelBallotElectionWith(e.d, e.registered, [1, 2]);
    const encrypted = encrypt();
    expect(() => panelBallotCore(unchecked, 0, encrypted)).toThrow(/approved one/);
    expect(() => panelTrackingCode(unchecked, 0, encrypted)).toThrow(/approved one/);
    expect(() => openChallengeV3(unchecked, 0, encrypted)).toThrow(/approved one/);
    const { context } = approvedPoll();
    const { opening } = openChallengeV3(context, 0, encrypt());
    expect(() => checkChallengeOpeningV3(unchecked, opening)).toThrow(/approved one/);
  });
});
