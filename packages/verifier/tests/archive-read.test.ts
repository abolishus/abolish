import { readFileSync } from "node:fs";
import {
  type ArchiveManifest,
  boardEntryHash,
  type BoardEntryVersion,
  copyCheckpoints,
  decodeBoardEntry,
  encodeArchiveLocator,
  encodeArchiveManifest,
  encodeCheckpoint,
  objectCar,
  objectCid,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_DEFINITION,
  type Bundle,
  type CheckResult,
  parseBundle,
  readArchive,
  readBoardByCid,
  type Report,
  splitEntries,
  verifyBundle,
} from "../src/index.ts";
import { decodeDefinition } from "../src/definition.ts";
import { toHex } from "./headers.ts";
import { ANCHOR_NAMESPACE, anchoredL1, locatorStorage, stored, word } from "./state.ts";

// The archive read of a run (docs/spec/verifier.md, Archive; 4.3): a
// format-3 bundle of verifier-tallies.json's `honest` election, anchored in
// an L1 state built here (state.ts) whose anchor also holds an archive
// locator, and an archive whose manifests list every object the counted
// checkpoints name, each made here from the copy's own entries (the segment
// object their concatenation, the entry-hash list their hashes), never by
// the reader under test.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const file = JSON.parse(readFileSync(new URL("verifier-tallies.json", VECTORS), "utf8")) as {
  readonly cases: readonly {
    readonly id: string;
    readonly definition: string;
    readonly board: string;
    readonly clock: Readonly<Record<string, string>>;
  }[];
};
const honest = file.cases.find((c) => c.id === "honest");
if (honest === undefined) throw new Error("no honest case");
const definition = decodeDefinition(hex(honest.definition)).value;
const VERSION: BoardEntryVersion = 5;
const clock = {
  epoch: BigInt(honest.clock["epoch"] as string),
  period: BigInt(honest.clock["period"] as string),
  deadline: BigInt(honest.clock["deadline"] as string),
  lastSegment: Number(honest.clock["lastSegment"]),
};
const NOW = clock.epoch + BigInt(clock.lastSegment + 1) * clock.period + clock.deadline + 1n;
const copy = splitEntries(hex(honest.board)).entries;
const segments = [
  ...new Set([...copy.map((e) => decodeBoardEntry(e, VERSION).segment), clock.lastSegment]),
];
const checkpoints = copyCheckpoints(definition.election_id, copy, segments);

const concat = (parts: readonly Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

// Each run's segment object and entry-hash list, by ascending size.
const runs: { readonly object: Uint8Array; readonly hashes: Uint8Array }[] = [];
{
  let previous = 0;
  const sizes = [...new Set([...checkpoints.values()].map((c) => Number(c.size)))].sort(
    (a, b) => a - b,
  );
  for (const size of sizes) {
    const run = copy.slice(previous, size);
    runs.push({ object: concat(run), hashes: concat(run.map(boardEntryHash)) });
    previous = size;
  }
}

const tx = (n: number) => {
  const t = new Uint8Array(32);
  t[0] = 0x7b;
  t[31] = n;
  return t;
};

interface Archived {
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
  readonly bytes: Uint8Array;
}

const archived = (bytes: Uint8Array, transaction: Uint8Array): Archived => ({
  cid: objectCid(bytes),
  transaction,
  bytes,
});

// Every object under its own transaction, from 100 on: segment objects, then lists.
const objects = [...runs.map((r) => r.object), ...runs.map((r) => r.hashes)].map((o, i) =>
  archived(o, tx(100 + i)),
);

function manifest(
  sequence: bigint,
  links: readonly (Archived & { readonly sequence: bigint })[],
  listed: readonly Archived[],
  extra: Partial<ArchiveManifest> = {},
) {
  const m: ArchiveManifest = {
    l1_chain_id: definition.l1_chain_id,
    anchor: definition.l1_anchor,
    sequence,
    objects: listed
      .map((o) => ({ cid: o.cid, transaction: o.transaction }))
      .sort((a, b) => (bytesToHex(a.cid) < bytesToHex(b.cid) ? -1 : 1)),
    links: links.map((l) => ({ sequence: l.sequence, cid: l.cid, transaction: l.transaction })),
    ...extra,
  };
  return { ...archived(encodeArchiveManifest(m), tx(Number(sequence))), sequence };
}

// Manifest 0 lists the segment objects, manifest 1 the lists and links 0.
const m0 = manifest(0n, [], objects.slice(0, runs.length));
const m1 = manifest(1n, [m0], objects.slice(runs.length));
const WHOLE = [m0, m1, ...objects];

function arweave(held: readonly Archived[]) {
  const byTx = new Map(held.map((h) => [bytesToHex(h.transaction), objectCar(h.bytes)]));
  const asked: string[] = [];
  const source = async (t: Uint8Array) => {
    asked.push(bytesToHex(t));
    const car = byTx.get(bytesToHex(t));
    return car === undefined ? [] : [car];
  };
  return { source, asked };
}

const locatorOf = (m: Archived) => encodeArchiveLocator(m.cid, m.transaction);

function bundle(
  options: {
    readonly locator?: Uint8Array;
    readonly count?: bigint;
    readonly board?: readonly Uint8Array[];
    readonly withCheckpoints?: boolean;
    readonly nodes?: readonly string[];
    readonly definition?: string;
  } = {},
): Bundle {
  const l1 = anchoredL1(
    definition.election_id,
    definition.l1_anchor,
    copy,
    VERSION,
    clock,
    { number: 20_000_000n, timestamp: NOW },
    options.locator === undefined ? [] : locatorStorage(options.locator, options.count ?? 2n),
  );
  if (options.withCheckpoints === true)
    l1.checkpoints = [...checkpoints.values()].map((c) => toHex(encodeCheckpoint(c)));
  if (options.nodes !== undefined) l1.nodes = [...options.nodes];
  const board = options.board ?? copy;
  return parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_DEFINITION,
      definition: options.definition ?? honest?.definition,
      clock: honest?.clock,
      l1,
    }),
    concat(board),
  );
}

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;
const without43 = (r: Report) => r.checks.filter((c) => c.id !== "4.3");

describe("readArchive", () => {
  test("a whole archive passes 4.3, reads every listed object and changes no other row", async () => {
    const plain = bundle({ locator: locatorOf(m1) });
    const { source, asked } = arweave(WHOLE);
    const read = await readArchive(plain, source);
    const r = verifyBundle(read.bundle);
    expect(row(r, "4.3")).toEqual({ id: "4.3", kind: "election", status: "pass" });
    expect(row(verifyBundle(plain), "4.3").code).toBe("not-implemented");
    expect(without43(r)).toEqual(without43(verifyBundle(plain)));
    expect(row(r, "4.1").status).toBe("pass");
    expect(r.archive).toEqual({
      count: "2",
      walk: { latest: "1", manifests: 2, reads: 2, findings: [] },
      objects: {
        targets: objects.length,
        read: objects.length,
        reads: objects.length,
        spent: objects.reduce((n, o) => n + objectCar(o.bytes).length, 0),
        findings: [],
      },
    });
    // The manifests from the latest down, then each object once, segment objects first.
    expect(asked).toEqual([m1, m0, ...objects].map((o) => bytesToHex(o.transaction)));
  });

  test("the objects read serve a board copy by CID with no other source", async () => {
    const empty = bundle({ locator: locatorOf(m1), board: [], withCheckpoints: true });
    const read = await readArchive(empty, arweave(WHOLE).source);
    const withCopy = await readBoardByCid(read.bundle, undefined, 2 ** 20, undefined, read.blocks);
    expect(withCopy.entries).toEqual(copy);
    const r = verifyBundle(withCopy);
    expect(row(r, "4.1").status).toBe("pass");
    expect(row(r, "4.2").status).toBe("pass");
    expect(row(r, "4.3").status).toBe("pass");
    expect(r.board.byCid).toEqual({});
  });

  test("a copy short of what the archive holds stays short, and 4.3 still reports the archive", async () => {
    const empty = bundle({ locator: locatorOf(m1), board: [], withCheckpoints: true });
    // Only the lists are archived: no segment object serves the copy.
    const read = await readArchive(empty, arweave([m0, m1, ...objects.slice(runs.length)]).source);
    const withCopy = await readBoardByCid(read.bundle, undefined, 2 ** 20, undefined, read.blocks);
    expect(withCopy.entries).toEqual([]);
    const r = verifyBundle(withCopy);
    expect(row(r, "4.1")).toMatchObject({ status: "unverifiable", code: "checkpoint-missing" });
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "object-unavailable" });
  });

  test("no locator in the anchor's state yet leaves 4.3 unverifiable, locator-none", async () => {
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle((await readArchive(bundle(), source)).bundle);
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "locator-none", at: {} });
    expect(r.archive).toEqual({ stopped: "locator-none", count: "0" });
    expect(asked).toEqual([]);
  });

  test("a lost manifest is unavailable, and the objects only it listed are not archived", async () => {
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1) }), arweave([m1, ...objects]).source))
        .bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "unavailable", at: {} });
    expect(r.archive).toMatchObject({
      walk: {
        latest: "1",
        manifests: 1,
        findings: [
          {
            code: "unavailable",
            from: { link: "0" },
            cid: bytesToHex(m0.cid),
            transaction: bytesToHex(m0.transaction),
          },
          { code: "archive-gap", first: "0", last: "0" },
        ],
      },
      objects: {
        read: runs.length,
        findings: objects
          .slice(0, runs.length)
          .map((o) => expect.objectContaining({ code: "not-archived", cid: bytesToHex(o.cid) })),
      },
    });
  });

  test("an object no source serves is object-unavailable, naming its transaction", async () => {
    const lost = objects[objects.length - 1] as Archived;
    const r = verifyBundle(
      (
        await readArchive(
          bundle({ locator: locatorOf(m1) }),
          arweave(WHOLE.filter((o) => o !== lost)).source,
        )
      ).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "object-unavailable" });
    expect(r.archive).toMatchObject({
      walk: { findings: [] },
      objects: {
        findings: [
          expect.objectContaining({
            code: "object-unavailable",
            cid: bytesToHex(lost.cid),
            transactions: [bytesToHex(lost.transaction)],
          }),
        ],
      },
    });
  });

  test("another deployment's manifest is manifest-foreign and not followed", async () => {
    const foreign = manifest(1n, [m0], objects.slice(runs.length), {
      l1_chain_id: definition.l1_chain_id + 1n,
    });
    const { source, asked } = arweave([...WHOLE, foreign]);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(foreign) }), source)).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "manifest-foreign" });
    expect(asked[0]).toBe(bytesToHex(foreign.transaction));
    expect(asked).not.toContain(bytesToHex(m0.transaction));
  });

  test("a locator of an unknown version is reported, and nothing is fetched but nothing listed", async () => {
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: Uint8Array.of(0, 9, 1, 2) }), source)).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "locator-version" });
    expect(asked).toEqual([]);
    expect(r.archive).toMatchObject({
      walk: { manifests: 0, reads: 0 },
      objects: { read: 0, reads: 0 },
    });
    expect(r.archive && "walk" in r.archive && "latest" in r.archive.walk).toBe(false);
  });

  test("a locator length word no locator has is locator-framing, nothing read", async () => {
    // A long form claiming 129 bytes: the anchor accepts at most 128.
    const l1 = anchoredL1(
      definition.election_id,
      definition.l1_anchor,
      copy,
      VERSION,
      clock,
      { number: 20_000_000n, timestamp: NOW },
      [[word(ANCHOR_NAMESPACE + 2n), stored(word(2n * 129n + 1n))]],
    );
    const framed = parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT_DEFINITION,
        definition: honest?.definition,
        clock: honest?.clock,
        l1,
      }),
      concat(copy),
    );
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle((await readArchive(framed, source)).bundle);
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "locator-framing" });
    expect(r.archive).toMatchObject({ count: "0", walk: { reads: 0 } });
    expect(asked).toEqual([]);
  });

  test("the objects' byte budget stops the reads, objects-over-budget", async () => {
    const { source } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1) }), source, { maxBytes: 1 })).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "objects-over-budget" });
  });

  test("the manifest budget stops the walk, over-budget, with no gap reported", async () => {
    const { source } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1) }), source, { maxManifests: 1 })).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "over-budget" });
    expect(r.archive).toMatchObject({ walk: { findings: [{ code: "over-budget", budget: 1 }] } });
  });

  test("a proof without the locator's nodes leaves 4.3 unverifiable with the L1 code", async () => {
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1), nodes: [] }), source)).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({
      status: "unverifiable",
      code: "l1-proof-missing",
      at: {},
    });
    expect(r.archive).toEqual({ stopped: "l1-proof-missing" });
    expect(asked).toEqual([]);
  });

  test("where the anchors can't be read the chain is walked, but no object is looked for", async () => {
    // An empty copy and no logged checkpoints: the anchored words match nothing.
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1), board: [] }), source)).bundle,
    );
    expect(row(r, "4.2").code).toBe("l1-checkpoint-unknown");
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.archive).toEqual({
      count: "2",
      walk: { latest: "1", manifests: 2, reads: 2, findings: [] },
    });
    expect(asked).toEqual([m1, m0].map((o) => bytesToHex(o.transaction)));
  });

  test("a definition that doesn't decode leaves 4.3 not reached, nothing read", async () => {
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1), definition: "0001" }), source)).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.archive).toEqual({ stopped: "not-reached" });
    expect(asked).toEqual([]);
  });

  test("checks its bundle and budgets", async () => {
    const { source } = arweave(WHOLE);
    const format1 = parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT,
        electionId: bytesToHex(definition.election_id),
        boardEntryVersion: 1,
        clock: honest?.clock,
        now: "0",
        anchors: [],
      }),
      new Uint8Array(),
    );
    await expect(readArchive(format1, source)).rejects.toThrow(TypeError);
    const once = await readArchive(bundle({ locator: locatorOf(m1) }), source);
    await expect(readArchive(once.bundle, source)).rejects.toThrow(TypeError);
    for (const maxBytes of [0, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])
      await expect(readArchive(bundle(), source, { maxBytes })).rejects.toThrow(RangeError);
    await expect(
      readBoardByCid(bundle({ board: [] }), undefined, 1, undefined, undefined),
    ).rejects.toThrow(TypeError);
  });
});
