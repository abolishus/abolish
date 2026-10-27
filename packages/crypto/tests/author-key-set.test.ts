import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkAuthorApprovals,
  checkBallotV4,
  checkCeremonyTranscript,
  checkChallengeOpeningV3,
  checkDeliveryV2,
  decodeBallot,
  decodeBoardEntry,
  decodeElectionDefinitionV6,
  type DeliveryElectionV2,
  type DeliveryEntry,
  deliveryDeadlines,
  deliverySegments,
  type ElectionDefinitionV6,
  type ElectionDefinitionV7,
  electionAuthorStubV6Hash,
  electionDefinitionV6Hash,
  electionDefinitionV7Hash,
  electionStubV6Hash,
  ELECTORATE_MODES,
  encryptSharesV4,
  type KemPublicKey,
  membershipScope,
  openChallengeV3,
  panelBallotCore,
  panelBallotElection,
  panelTrackingCode,
  panelTallyRules,
  RECORD_TYPES,
  type RegisteredKeys,
  shareVoteV4,
  tallyRules,
  UnsupportedVersionError,
} from "../src/index.ts";
import { panelBallotElectionWith } from "../src/ballot.ts";
import { checkChallengeOpeningV3With, coreHashV4 } from "../src/challenge.ts";
import { checkDeliveryV2With } from "../src/delivery.ts";

// `panelBallotElection` beside an author panel (docs/spec/ballot-validity.md,
// Admission (version 4): the author panel's registered key set is its own
// run's, approved by its approvals): it takes only the key set
// `checkAuthorApprovals` approved under the definition's chain, trustee
// registry, author panel, author stub and author transcript, so no caller can
// pass seats it controls, or another run's, off as the author panel's (T-37,
// T-17). Fixtures: docs/spec/vectors/verifier-ballots-v4-author.json
// (packages/crypto/scripts/verifier-ballots-v4-author-vectors.py, an
// independent implementation), whose boards carry the author transcript, the
// default transcript and the approvals record, in that order, then ballots;
// docs/spec/vectors/verifier-delivery-v2-author.json (packages/crypto/
// scripts/verifier-delivery-v2-author-vectors.py, likewise independent)
// adds share receipts from both panels' registered seats.

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
function boardEntries(
  board: Uint8Array,
): { readonly segment: number; readonly payload: Uint8Array }[] {
  const out: { readonly segment: number; readonly payload: Uint8Array }[] = [];
  for (let at = 0; at < board.length;) {
    const n = new DataView(board.buffer, board.byteOffset + at + 47, 4).getUint32(0);
    const { segment, payload } = decodeBoardEntry(board.subarray(at, at + 51 + n), 7);
    out.push({ segment, payload });
    at += 51 + n;
  }
  return out;
}

const payloads = (board: Uint8Array) => boardEntries(board).map((e) => e.payload);

function election(
  id: string,
  cases: readonly {
    readonly id: string;
    readonly definition: string;
    readonly board: string;
  }[] = file.cases,
) {
  const c = cases.find((x) => x.id === id);
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

const deliveryFile = JSON.parse(
  readFileSync(new URL("verifier-delivery-v2-author.json", VECTORS), "utf8"),
) as {
  readonly cases: readonly {
    readonly id: string;
    readonly definition: string;
    readonly board: string;
    readonly clock: Readonly<Record<string, string>>;
    readonly delivery?: {
      readonly excluded: readonly {
        readonly entry: number;
        readonly missing: readonly { readonly panel: number; readonly seat: number }[];
      }[];
      readonly records: readonly {
        readonly entry: number;
        readonly code: string;
        readonly panel: number;
        readonly seat: number;
        readonly signer?: number | null;
      }[];
    };
    readonly counted?: readonly number[];
  }[];
};

const typeOf = (p: Uint8Array) => ((p[0] as number) << 8) + (p[1] as number);

describe("checkDeliveryV2 beside an author panel takes its approved key set", () => {
  /** A case's election, its ballots and receipts as the delivery check takes them, with their board entries. */
  function poll(id: string) {
    const c = deliveryFile.cases.find((x) => x.id === id);
    if (c === undefined) throw new Error(`no case ${id}`);
    const e = election(id, deliveryFile.cases);
    const clock = {
      epoch: BigInt(c.clock["epoch"] ?? ""),
      period: BigInt(c.clock["period"] ?? ""),
    };
    const bound = BigInt(e.d.l1_inclusion_bound);
    const against: DeliveryElectionV2 = {
      definitionHash: electionDefinitionV6Hash(e.d),
      panelSize: e.d.panel_size,
      authorPanelSize: e.d.author_keys.length,
      registered: { default: e.registered, author: e.authorRegistered },
      segments: deliverySegments(clock, e.d.closes_at, bound),
      deadlines: deliveryDeadlines(e.d.closes_at, bound),
    };
    const all = boardEntries(hex(c.board));
    const ballotAt = all.flatMap((x, at) =>
      typeOf(x.payload) === RECORD_TYPES.ballot ? [at] : [],
    );
    const ballots = ballotAt.map((at) => {
      const b = decodeBallot((all[at] as (typeof all)[number]).payload, 4);
      return { cell: b.cell, nullifier: b.nullifier, vote: b.committed_vote };
    });
    const recordAt = all.flatMap((x, at) =>
      typeOf(x.payload) === RECORD_TYPES.shareReceipt ? [at] : [],
    );
    const entries: DeliveryEntry[] = recordAt.map((at) => {
      const { segment, payload } = all[at] as (typeof all)[number];
      return { path: "board", segment, payload };
    });
    return { c, e, against, ballots, ballotAt, entries, recordAt };
  }

  for (const id of ["delivered", "author-seats-missing", "default-seat-missing", "default-only"])
    test(`${id}: each ballot is delivered only by every registered seat of both panels, as the independent check gives`, () => {
      const { c, e, against, ballots, ballotAt, entries, recordAt } = poll(id);
      expect(e.approve()).toEqual({ ok: true, seats: [1, 2] });
      const r = checkDeliveryV2(against, ballots, entries, e.d);
      expect(r.ballots.flatMap((b, i) => (b.counted ? [ballotAt[i]] : []))).toEqual(c.counted);
      expect(
        r.ballots.flatMap((b, i) =>
          b.counted
            ? []
            : [
                {
                  entry: ballotAt[i],
                  missing: b.missing.map(({ panel, seat }) => ({ panel, seat })),
                },
              ],
        ),
      ).toEqual(c.delivery?.excluded.map(({ entry, missing }) => ({ entry, missing })));
      expect(
        r.records.map((x) => ({
          entry: recordAt[x.at],
          code: x.code,
          panel: x.panel,
          seat: x.seat,
          ...(x.signer !== undefined && { signer: x.signer }),
        })),
      ).toEqual(c.delivery?.records);
      expect(r.rejected).toEqual([]);
      // The same verdicts as the internal path given the same seats.
      expect(checkDeliveryV2With(against, ballots, entries)).toEqual(r);
    });

  test("never before its approvals approve, or without the definition they approved it under", () => {
    const { e, against, ballots, entries } = poll("delivered");
    expect(() => checkDeliveryV2(against, ballots, entries, e.d)).toThrow(/approved key set/);
    e.approve();
    expect(() => checkDeliveryV2(against, ballots, entries)).toThrow(/needs its definition/);
  });

  test("reads roots only under the definition's own thresholds", () => {
    const { e, against, ballots, entries } = poll("delivered");
    e.approve();
    const roots = (d: number, a: number) => ({
      bound: 8n,
      thresholds: { default: d, author: a },
      attestations: [],
      leafBlocks: () => [],
    });
    const { threshold, author_threshold } = e.d;
    expect(
      checkDeliveryV2(against, ballots, entries, e.d, roots(threshold, author_threshold)),
    ).toEqual(checkDeliveryV2(against, ballots, entries, e.d));
    // T-25, T-54: a threshold other than the definition's would let fewer
    // seats withhold a root, or make one available.
    for (const [d, a] of [
      [threshold - 1, author_threshold],
      [threshold, author_threshold - 1],
      [threshold, author_threshold + 1],
    ] as const)
      expect(() => checkDeliveryV2(against, ballots, entries, e.d, roots(d, a))).toThrow(
        /not the thresholds of this definition/,
      );
  });

  test("never with no author key set, a copy of it, the default panel's or another run's", () => {
    const { e, against, ballots, entries } = poll("delivered");
    e.approve();
    const other = election("author-every-seat");
    expect(other.approve().ok).toBe(true);
    for (const author of [[], [...e.authorRegistered], e.registered, other.authorRegistered])
      expect(() =>
        checkDeliveryV2(
          { ...against, registered: { default: e.registered, author } },
          ballots,
          entries,
          e.d,
        ),
      ).toThrow(/approved key set/);
  });

  test("never under a definition other than the one it checks delivery for", () => {
    const { e, against, ballots, entries } = poll("delivered");
    e.approve();
    // The approved author set is still this definition's, but the election
    // the check runs over is another's, by hash or by either panel's size.
    for (const change of [
      { definitionHash: new Uint8Array(32).fill(7) },
      { panelSize: against.panelSize - 1 },
      { authorPanelSize: against.authorPanelSize - 1 },
    ])
      expect(() => checkDeliveryV2({ ...against, ...change }, ballots, entries, e.d)).toThrow(
        /not the definition of this election/,
      );
    expect(() =>
      checkDeliveryV2(against, ballots, entries, { ...e.d, opens_at: e.d.opens_at - 1n }),
    ).toThrow(/not the definition of this election/);
  });

  test("never with a default key set other than its own run's", () => {
    const { e, against, ballots, entries } = poll("delivered");
    e.approve();
    // A seat dropped would need no delivery; the author set swapped in, or
    // a copy, isn't the default run's output (T-25, T-37).
    for (const keys of [e.registered.slice(0, 2), [...e.registered], e.authorRegistered])
      expect(() =>
        checkDeliveryV2(
          { ...against, registered: { default: keys, author: e.authorRegistered } },
          ballots,
          entries,
          e.d,
        ),
      ).toThrow(/key set of this definition's ceremony/);
  });

  test("reads the definition once, so one that answers differently on a later read can't pair this election with another's approved set", () => {
    const { e, against, ballots, entries } = poll("delivered");
    e.approve();
    const other = election("author-every-seat");
    expect(other.approve().ok).toBe(true);
    // This election's fields for the first read of each, then the other
    // run's definition's: checks reading the caller's object again would
    // hash this one and approve the other's set.
    const seen = new Set<PropertyKey>();
    const swapping = new Proxy(e.d, {
      get(target, key, receiver) {
        if (seen.has(key)) return Reflect.get(other.d, key, receiver);
        seen.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() =>
      checkDeliveryV2(
        { ...against, registered: { default: e.registered, author: other.authorRegistered } },
        ballots,
        entries,
        swapping,
      ),
    ).toThrow(/approved key set/);
  });

  test("and refuses any author key set beside a definition without an author panel", () => {
    const { e, against, ballots } = poll("delivered");
    e.approve();
    const plain: ElectionDefinitionV6 = {
      ...e.d,
      author_threshold: 0,
      author_keys: [],
      author_transcript_hash: new Uint8Array(32),
    };
    const plainAgainst = {
      ...against,
      definitionHash: electionDefinitionV6Hash(plain),
      authorPanelSize: 0,
    };
    expect(() => checkDeliveryV2(plainAgainst, [], [], plain)).toThrow(/no author panel/);
    expect(
      checkDeliveryV2(
        { ...plainAgainst, registered: { default: e.registered, author: [] } },
        [],
        [],
        plain,
      ).ballots,
    ).toEqual([]);
    expect(ballots).toHaveLength(3);
  });

  test("checks delivery against the election it checked, whatever a record changes while it is read", () => {
    const { e, against, ballots, entries } = poll("delivered");
    e.approve();
    const expected = checkDeliveryV2(against, ballots, entries, e.d);
    // The caller's definition hash is overwritten once the check reads the
    // first record: the check runs over its own copy, so no record turns
    // stray and no ballot's hash changes (T-37).
    const definitionHash = Uint8Array.from(against.definitionHash);
    const [first, ...rest] = entries as [DeliveryEntry, ...DeliveryEntry[]];
    const overwriting = {
      ...first,
      get segment() {
        definitionHash.fill(0);
        return (first as Extract<DeliveryEntry, { path: "board" }>).segment;
      },
    } as DeliveryEntry;
    expect(
      checkDeliveryV2({ ...against, definitionHash }, ballots, [overwriting, ...rest], e.d),
    ).toEqual(expected);
  });
});

// A version-7 definition under a fixed electorate is version 6's fields with
// the mode and an empty rolling list appended, pinning itself as version 7
// (docs/spec/election-definition.md, Layout (version 7)).
const fixedV7 = (d: ElectionDefinitionV6): ElectionDefinitionV7 => ({
  ...d,
  profile: {
    ...d.profile,
    pins: d.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.electionDefinition ? { ...p, version: 7 } : p,
    ),
  },
  electorate_mode: ELECTORATE_MODES.fixed,
  rolling_electorate: [],
});

const withoutAuthor = (d: ElectionDefinitionV6): ElectionDefinitionV6 => ({
  ...d,
  author_threshold: 0,
  author_keys: [],
  author_transcript_hash: new Uint8Array(32),
});

// Delivery's election for a definition without an author panel, under `d`'s
// own hash when it has one.
function plainAgainst(
  e: ReturnType<typeof election>,
  d: ElectionDefinitionV6 | ElectionDefinitionV7,
): DeliveryElectionV2 {
  const bound = BigInt(d.l1_inclusion_bound);
  const clock = { epoch: 1767225600n, period: 3600n };
  return {
    definitionHash:
      "electorate_mode" in d && d.electorate_mode === ELECTORATE_MODES.fixed
        ? electionDefinitionV7Hash(d)
        : new Uint8Array(32),
    panelSize: d.panel_size,
    authorPanelSize: 0,
    registered: { default: e.registered, author: [] },
    segments: deliverySegments(clock, d.closes_at, bound),
    deadlines: deliveryDeadlines(d.closes_at, bound),
  };
}

describe("version 6's per-election checks read a fixed version 7 under its own hashes", () => {
  // Verifier 2.3: what holds of version 6 holds of version 7, and a fixed
  // version 7 pins ballot version 4; its hash and author stub hash are its
  // own encoding's, so no ballot, record or approval made for a version-6
  // reading of it is read as its own (T-34, T-36, T-37).
  test("a ballot election is version 6's but for the hash and the scopes it gives", () => {
    const e = election("author-mixed");
    const d6 = withoutAuthor(e.d);
    const d7 = fixedV7(d6);
    const six = panelBallotElection(d6, e.registered);
    const seven = panelBallotElection(d7, e.registered);
    const hash = electionDefinitionV7Hash(d7);
    expect(seven.definitionHash).toEqual(hash);
    expect(seven.definitionHash).not.toEqual(electionDefinitionV6Hash(d6));
    expect(seven.cells).toEqual(
      six.cells.map((c) => ({ ...c, scope: membershipScope(hash, c.tier, c.root) })),
    );
    expect({ ...seven, definitionHash: [], cells: [] }).toEqual({
      ...six,
      definitionHash: [],
      cells: [],
    });
    // With an author panel's seats given, as the opening tests take them.
    const authored = panelBallotElectionWith(fixedV7(e.d), e.registered, [1, 2]);
    expect(authored.definitionHash).toEqual(electionDefinitionV7Hash(fixedV7(e.d)));
    expect(authored.authorPanelSize).toBe(e.d.author_keys.length);
  });

  test("an author panel's approvals of the version-6 reading approve nothing under version 7", () => {
    const e = election("author-mixed");
    expect(e.approve()).toEqual({ ok: true, seats: [1, 2] });
    // The approvals sign the version-6 author stub, which a version-7
    // definition with the same fields doesn't have (T-17, T-37).
    expect(() => panelBallotElection(fixedV7(e.d), e.registered, e.authorRegistered)).toThrow(
      /approved key set/,
    );
  });

  test("the version is the value's own pin, never its shape", () => {
    const e = election("author-mixed");
    const d6 = withoutAuthor(e.d);
    // Version 7's fields under a version-6 pin decode as no definition (the
    // version byte is the fields' layout's, the pin another), so neither
    // version's hash is taken over them.
    const shaped = { ...fixedV7(d6), profile: d6.profile };
    expect(() => panelBallotElection(shaped, e.registered)).toThrow(/profile-mismatch/);
    // Version 6's fields under a version-7 pin decode as no definition.
    const pinned = { ...d6, profile: fixedV7(d6).profile };
    expect(() => panelBallotElection(pinned, e.registered)).toThrow(/profile-mismatch/);
    for (const d of [shaped, pinned]) {
      expect(() => tallyRules({ version: 6, value: d })).toThrow();
      expect(() => checkDeliveryV2(plainAgainst(e, d), [], [], d)).toThrow();
    }
    // A fixed version 7 pinning another ballot version than 4 has no version-4 election.
    const ballotPin = (d: ElectionDefinitionV7, version: number): ElectionDefinitionV7 => ({
      ...d,
      profile: {
        ...d.profile,
        pins: d.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.ballot ? { ...p, version } : p,
        ),
      },
    });
    expect(() => panelBallotElection(ballotPin(fixedV7(d6), 5), e.registered)).toThrow(
      UnsupportedVersionError,
    );
  });

  test("a rolling version 7, and an ill-formed fixed one, are refused", () => {
    const e = election("author-mixed");
    const d7 = fixedV7(withoutAuthor(e.d));
    const rolling: ElectionDefinitionV7 = { ...d7, electorate_mode: ELECTORATE_MODES.rolling };
    expect(() => panelBallotElection(rolling, e.registered)).toThrow(UnsupportedVersionError);
    expect(() => tallyRules({ version: 7, value: rolling })).toThrow(UnsupportedVersionError);
    expect(() =>
      panelTallyRules(
        { version: 7, value: { ...fixedV7(e.d), electorate_mode: ELECTORATE_MODES.rolling } },
        1,
      ),
    ).toThrow(UnsupportedVersionError);
    // Under a fixed electorate the rolling list must be empty (`electorate`).
    const listed: ElectionDefinitionV7 = {
      ...d7,
      rolling_electorate: [{ tier: 0, root_l2_block: 1n, groups: [1n], root: 1n, group_size: 1n }],
    };
    expect(() => panelBallotElection(listed, e.registered)).toThrow(/isn't well-formed/);
    expect(() => tallyRules({ version: 7, value: listed })).toThrow(/isn't well-formed/);
  });

  test("tally rules are version 6's, and a record's version must be its value's pin", () => {
    const e = election("author-mixed");
    const d6 = withoutAuthor(e.d);
    expect(tallyRules({ version: 7, value: fixedV7(d6) })).toEqual(
      tallyRules({ version: 6, value: d6 }),
    );
    expect(() => tallyRules({ version: 7, value: fixedV7(e.d) })).toThrow(/per panel/);
    for (const panel of [1, 2] as const)
      expect(panelTallyRules({ version: 7, value: fixedV7(e.d) }, panel)).toEqual(
        panelTallyRules({ version: 6, value: e.d }, panel),
      );
    // A version-6 value labelled 7, and a version-7 one labelled 6.
    const shaped = { ...fixedV7(d6), profile: d6.profile };
    expect(() => tallyRules({ version: 7, value: shaped })).toThrow(/profile-mismatch/);
    expect(() => tallyRules({ version: 6, value: fixedV7(d6) })).toThrow(UnsupportedVersionError);
    expect(() => panelTallyRules({ version: 6, value: fixedV7(e.d) }, 1)).toThrow(
      UnsupportedVersionError,
    );
  });

  test("delivery is checked against the version-7 hash and the version-7 author stub", () => {
    const e = election("author-mixed");
    expect(e.approve()).toEqual({ ok: true, seats: [1, 2] });
    const d7 = fixedV7(withoutAuthor(e.d));
    const against = plainAgainst(e, d7);
    expect(checkDeliveryV2(against, [], [], d7).ballots).toEqual([]);
    // Its version-6 reading's hash names another election.
    expect(() =>
      checkDeliveryV2(
        { ...against, definitionHash: electionDefinitionV6Hash(withoutAuthor(e.d)) },
        [],
        [],
        d7,
      ),
    ).toThrow(/not the definition of this election/);
    expect(() =>
      checkDeliveryV2(against, [], [], { ...d7, electorate_mode: ELECTORATE_MODES.rolling }),
    ).toThrow(UnsupportedVersionError);
    const authored = fixedV7(e.d);
    expect(() =>
      checkDeliveryV2(
        {
          ...against,
          definitionHash: electionDefinitionV7Hash(authored),
          authorPanelSize: authored.author_keys.length,
          registered: { default: e.registered, author: e.authorRegistered },
        },
        [],
        [],
        authored,
      ),
    ).toThrow(/approved key set/);
  });
});
