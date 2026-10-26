import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArchiveManifest,
  type ArchiveManifestV3,
  boardEntryHash,
  type BoardEntryVersion,
  type ContractLog,
  copyCheckpoints,
  decodeBoardEntry,
  encodeArchiveLocator,
  decodeArchiveManifest,
  encodeArchiveManifest,
  encodeCheckpoint,
  arweaveId,
  objectCar,
  objectCid,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_DEFINITION,
  BUNDLE_FORMAT_L1,
  type Bundle,
  BundleError,
  type CheckResult,
  EXIT_CODES,
  MAX_GATEWAYS,
  parseBundle,
  readArchive,
  readBlockStore,
  readBoardByCid,
  type Report,
  runCli,
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
// 4.4's replay of an archive listing no evidence and no run: each of the
// definition's L2 contracts, in role order, with nothing read.
const NOTHING_REPLAYED = {
  contracts: (
    [
      ["election-registry", definition.election_registry],
      ["trustee-registry", definition.trustee_registry],
      ["group-registry", definition.group_registry],
      ["board", definition.board],
    ] as const
  ).map(([role, contract]) => ({
    role,
    contract: toHex(contract),
    evidence: { records: [], reads: 0, findings: [] },
    runs: { taken: [], complete: true, spent: 0, reads: 0, findings: [] },
    held: "0",
  })),
  findings: [],
};
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

// The anchor's logs (docs/spec/contracts.md, Board anchor): `ArchiveLocated`
// by its signature hash (`cast keccak "ArchiveLocated(uint16,bytes)"`,
// Foundry 1.8.3) with the locator as the anchor's `abi.encode(locator)`,
// written out here, and the accumulator's slot `S` as the spec gives it.
const ARCHIVE_LOCATED = hex("1b37e1203b2f89451d0e152945afd74082680705f81b99a67769ec77cf307c2f");
const ACCUMULATOR = 0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600n;
const B = 20_000_000n;

const abiBytes = (b: Uint8Array) =>
  concat([word(32n), word(BigInt(b.length)), b, new Uint8Array((32 - (b.length % 32)) % 32)]);

const located = (locator: Uint8Array, block = B - 10n): ContractLog => ({
  block,
  timestamp: block * 12n,
  topics: [ARCHIVE_LOCATED, word(BigInt(((locator[0] as number) << 8) | (locator[1] as number)))],
  data: abiBytes(locator),
});

// Another of the anchor's logs, a receipt key's registration, say.
const other = (block = B - 20n): ContractLog => ({
  block,
  timestamp: block * 12n,
  topics: [new Uint8Array(32).fill(0xaa), new Uint8Array(32).fill(0xbb)],
  data: word(2n),
});

/** The anchor's accumulator and count in its storage, after `logs`. */
function accumulatorStorage(logs: readonly ContractLog[]) {
  const { accumulator, count } = replayEventAccumulator(
    definition.l1_chain_id,
    definition.l1_anchor,
    logs,
  );
  // A trie holds no zero word.
  const entries: (readonly [Uint8Array, Uint8Array])[] = [[word(ACCUMULATOR), stored(accumulator)]];
  if (count > 0n) entries.push([word(ACCUMULATOR + 1n), stored(word(count))]);
  return entries;
}

const logsJson = (logs: readonly ContractLog[]) =>
  logs.map((l) => ({
    block: l.block.toString(),
    timestamp: l.timestamp.toString(),
    topics: l.topics.map(toHex),
    data: toHex(l.data),
  }));

interface BundleOptions {
  readonly locator?: Uint8Array;
  readonly count?: bigint;
  readonly board?: readonly Uint8Array[];
  readonly withCheckpoints?: boolean;
  readonly nodes?: readonly string[];
  readonly definition?: string;
  /** The logs the bundle carries, and the ones the anchor's state counts, if others. */
  readonly logs?: readonly ContractLog[];
  readonly stateLogs?: readonly ContractLog[] | null;
  readonly extra?: readonly (readonly [Uint8Array, Uint8Array])[];
}

// bundle.json's text for `options`.
function bundleJson(options: BundleOptions = {}): string {
  // `null`: no accumulator in the anchor's storage but what `extra` holds.
  const stateLogs = options.stateLogs === null ? undefined : (options.stateLogs ?? options.logs);
  const l1 = anchoredL1(
    definition.election_id,
    definition.l1_anchor,
    copy,
    VERSION,
    clock,
    { number: B, timestamp: NOW },
    [
      ...(options.locator === undefined
        ? []
        : locatorStorage(options.locator, options.count ?? 2n)),
      ...(stateLogs === undefined ? [] : accumulatorStorage(stateLogs)),
      ...(options.extra ?? []),
    ],
  );
  if (options.withCheckpoints === true)
    l1.checkpoints = [...checkpoints.values()].map((c) => toHex(encodeCheckpoint(c)));
  if (options.nodes !== undefined) l1.nodes = [...options.nodes];
  return JSON.stringify({
    format: BUNDLE_FORMAT_DEFINITION,
    definition: options.definition ?? honest?.definition,
    clock: honest?.clock,
    l1,
    ...(options.logs !== undefined && { anchorLogs: logsJson(options.logs) }),
  });
}

function bundle(options: BundleOptions = {}): Bundle {
  return parseBundle(bundleJson(options), concat(options.board ?? copy));
}

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;
const without43 = (r: Report) => r.checks.filter((c) => c.id !== "4.3");

describe("readArchive", () => {
  test("a whole archive reads every listed object and changes no other row, but without the anchor's logs 4.3 doesn't pass", async () => {
    const plain = bundle({ locator: locatorOf(m1) });
    const { source, asked } = arweave(WHOLE);
    const read = await readArchive(plain, source);
    const r = verifyBundle(read.bundle);
    // Only the anchor's ArchiveLocated logs show an overwritten locator
    // (T-69): never a pass without them.
    expect(row(r, "4.3")).toEqual({
      id: "4.3",
      kind: "election",
      status: "unverifiable",
      code: "anchor-logs-missing",
      at: {},
    });
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
      replay: NOTHING_REPLAYED,
    });
    // The manifests from the latest down, then each object once, segment objects first.
    expect(asked).toEqual([m1, m0, ...objects].map((o) => bytesToHex(o.transaction)));
  });

  test("a version-3 locator's chain is walked as an earlier version's, its runs listing nothing 4.3 reads", async () => {
    const m: ArchiveManifestV3 = {
      ...decodeArchiveManifest(m1.bytes, 1),
      evidence: [],
      runs: [
        {
          contract: definition.board,
          first: 0n,
          count: 1,
          cid: objectCid(Uint8Array.of(0x00, 0x26, 0x01)),
          transaction: tx(900),
        },
      ],
    };
    const v3 = { ...archived(encodeArchiveManifest(m, 3), tx(1)), sequence: 1n };
    const plain = bundle({ locator: encodeArchiveLocator(v3.cid, v3.transaction, 3) });
    const { source, asked } = arweave([m0, v3, ...objects]);
    const r = verifyBundle((await readArchive(plain, source)).bundle);
    expect(row(r, "4.3").code).toBe("anchor-logs-missing");
    expect(r.archive).toMatchObject({
      count: "2",
      walk: { latest: "1", manifests: 2, reads: 2, findings: [] },
      objects: { read: objects.length, findings: [] },
    });
    // The run listed is never fetched: nothing reads runs yet.
    expect(asked).toEqual([v3, m0, ...objects].map((o) => bytesToHex(o.transaction)));
  });

  test("the objects read serve a board copy by CID with no other source", async () => {
    const empty = bundle({ locator: locatorOf(m1), board: [], withCheckpoints: true });
    const read = await readArchive(empty, arweave(WHOLE).source);
    const withCopy = await readBoardByCid(read.bundle, undefined, 2 ** 20, undefined, read.blocks);
    expect(withCopy.entries).toEqual(copy);
    const r = verifyBundle(withCopy);
    expect(row(r, "4.1").status).toBe("pass");
    expect(row(r, "4.2").status).toBe("pass");
    expect(row(r, "4.3").code).toBe("anchor-logs-missing");
    expect(r.board.byCid).toEqual({});
  });

  test("a copy asks blocks.car first, then the objects read, and a gateway only for neither's blocks (T-11)", async () => {
    const empty = bundle({ locator: locatorOf(m1), board: [], withCheckpoints: true });
    const segment = objects[0] as Archived;
    const run = async (inStore: boolean, inArchive: boolean) => {
      const read = await readArchive(
        empty,
        arweave(WHOLE.filter((o) => inArchive || o !== segment)).source,
      );
      const asked = { archive: 0, gateway: 0 };
      const archived: typeof read.blocks = async (cid, limit) => {
        asked.archive++;
        return read.blocks(cid, limit);
      };
      const gateways = {
        source: async (cid: Uint8Array) => {
          asked.gateway++;
          return bytesToHex(cid) === bytesToHex(segment.cid) ? [segment.bytes] : [];
        },
        stats: () => ({ requests: asked.gateway, blocks: asked.gateway }),
      };
      const store = inStore ? readBlockStore(objectCar(segment.bytes)) : undefined;
      const withCopy = await readBoardByCid(read.bundle, store, 2 ** 20, gateways, archived);
      expect(withCopy.entries).toEqual(copy);
      return asked;
    };
    expect(runs).toHaveLength(1);
    // The store's block asks neither; the archive's asks no gateway.
    expect(await run(true, true)).toEqual({ archive: 0, gateway: 0 });
    expect(await run(false, true)).toEqual({ archive: 1, gateway: 0 });
    expect(await run(false, false)).toEqual({ archive: 1, gateway: 1 });
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

  test("with the anchors unread, the walk's report still comes first", async () => {
    const r = verifyBundle(
      (
        await readArchive(
          bundle({ locator: locatorOf(m1), board: [] }),
          arweave([m1, ...objects]).source,
        )
      ).bundle,
    );
    expect(row(r, "4.3")).toEqual({
      id: "4.3",
      kind: "election",
      status: "unverifiable",
      code: "unavailable",
      at: {},
    });
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
    // No chain was read, so no object is called missing.
    expect(r.archive).toEqual({
      count: "2",
      walk: {
        manifests: 0,
        reads: 0,
        findings: [{ code: "locator-version", locator: "latest", version: 9 }],
      },
      replay: NOTHING_REPLAYED,
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
    // Manifests left unread may list any object: none is called not archived.
    expect(r.archive !== undefined && "objects" in r.archive).toBe(false);
  });

  test("the objects' read budget stops the reads, objects-over-budget", async () => {
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1) }), source, { maxReads: 1 })).bundle,
    );
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "objects-over-budget" });
    expect(asked).toHaveLength(3);
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
    expect(row(r, "4.3")).toEqual({
      id: "4.3",
      kind: "election",
      status: "unverifiable",
      code: "not-reached",
      at: {},
    });
    expect(r.archive).toEqual({
      count: "2",
      walk: { latest: "1", manifests: 2, reads: 2, findings: [] },
      replay: NOTHING_REPLAYED,
    });
    expect(asked).toEqual([m1, m0].map((o) => bytesToHex(o.transaction)));
  });

  test("a definition that doesn't decode leaves 4.3 not reached, nothing read", async () => {
    const { source, asked } = arweave(WHOLE);
    const r = verifyBundle(
      (await readArchive(bundle({ locator: locatorOf(m1), definition: "0001" }), source)).bundle,
    );
    expect(row(r, "4.3")).toEqual({
      id: "4.3",
      kind: "election",
      status: "unverifiable",
      code: "not-reached",
      at: {},
    });
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
    // Every budget is checked before anything is read, whatever the bundle holds.
    for (const bad of [0, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])
      for (const name of ["maxManifests", "maxBytes", "maxReads"])
        await expect(readArchive(bundle(), source, { [name]: bad })).rejects.toThrow(
          new RangeError(`${name} must be a positive integer`),
        );
    await expect(
      readBoardByCid(bundle({ board: [] }), undefined, 1, undefined, undefined),
    ).rejects.toThrow(TypeError);
  });
});

describe("the earlier locators, from the anchor's logs", () => {
  // Another manifest at a sequence, under its own transaction.
  const under = (m: ReturnType<typeof manifest>, n: number) => ({ ...m, transaction: tx(n) });
  // Manifest 0 lists the segment objects; this one, the lists.
  const m0x = under(manifest(0n, [], objects.slice(runs.length)), 50);
  const m2 = manifest(2n, [m1], []);
  // A latest that links nothing earlier: the authority cut manifest 0 off.
  const m1cut = under(manifest(1n, [], objects.slice(runs.length)), 51);
  const honestLogs = [other(), located(locatorOf(m0)), located(locatorOf(m1))];

  const run = async (b: Bundle, held: readonly Archived[] = WHOLE) => {
    const { source, asked } = arweave(held);
    return { r: verifyBundle((await readArchive(b, source)).bundle), asked };
  };

  test("a whole archive whose every earlier locator is its chain's passes 4.3, and changes no other row", async () => {
    const logged = bundle({ locator: locatorOf(m1), logs: honestLogs });
    const { r, asked } = await run(logged);
    expect(row(r, "4.3")).toEqual({ id: "4.3", kind: "election", status: "pass" });
    expect(r.archive).toMatchObject({
      count: "2",
      earlier: 2,
      walk: { latest: "1", manifests: 2, reads: 2, findings: [] },
      objects: { findings: [] },
    });
    // The earlier locators name the chain's own manifests: nothing more is read.
    expect(asked).toEqual([m1, m0, ...objects].map((o) => bytesToHex(o.transaction)));
    const { r: plain } = await run(bundle({ locator: locatorOf(m1) }));
    expect(without43(r)).toEqual(without43(plain));
    expect(r.inputs.anchorLogs).toBe("l1-state-proof");
    expect(plain.inputs.anchorLogs).toBeUndefined();
  });

  test("logs after B are ignored", async () => {
    const later = [...honestLogs, located(locatorOf(m2), B + 1n)];
    const { r } = await run(bundle({ locator: locatorOf(m1), logs: later, stateLogs: honestLogs }));
    expect(row(r, "4.3").status).toBe("pass");
  });

  test("an earlier locator naming another manifest where the chain names one is locator-mismatch (T-69)", async () => {
    const logs = [located(locatorOf(m0x)), located(locatorOf(m1))];
    const { r } = await run(bundle({ locator: locatorOf(m1), logs }), [...WHOLE, m0x]);
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "locator-mismatch" });
    expect(r.archive).toMatchObject({
      walk: {
        findings: [
          {
            code: "locator-mismatch",
            locator: 0,
            sequence: "0",
            named: bytesToHex(m0x.cid),
            chain: bytesToHex(m0.cid),
          },
        ],
      },
    });
  });

  test("a locator rolled back below one logged before it is locator-mismatch (T-69)", async () => {
    const logs = [...honestLogs, located(locatorOf(m2)), located(locatorOf(m1))];
    const { r } = await run(bundle({ locator: locatorOf(m1), count: 4n, logs }), [...WHOLE, m2]);
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "locator-mismatch" });
    expect(r.archive).toMatchObject({
      earlier: 4,
      walk: {
        findings: [
          { code: "locator-mismatch", locator: 2, sequence: "2", named: bytesToHex(m2.cid) },
        ],
      },
    });
  });

  test("a manifest reached only through an earlier locator is earlier-only, and its objects are read", async () => {
    const held = [m0, m1cut, ...objects];
    const cut = await run(bundle({ locator: locatorOf(m1cut) }), held);
    expect(cut.r.archive).toMatchObject({
      walk: { findings: [{ code: "archive-gap", first: "0", last: "0" }] },
    });
    const logs = [located(locatorOf(m0)), located(locatorOf(m1cut))];
    const { r } = await run(bundle({ locator: locatorOf(m1cut), logs }), held);
    expect(row(r, "4.3")).toMatchObject({ status: "unverifiable", code: "earlier-only" });
    expect(r.archive).toMatchObject({
      walk: { manifests: 2, findings: [{ code: "earlier-only", first: "0", last: "0" }] },
      objects: { read: objects.length, findings: [] },
    });
  });

  // Logs that aren't the anchor's whole sequence up to B, or that its state
  // contradicts, give no earlier locator: the read stops before any fetch.
  const stops = async (b: Bundle, rule: string) => {
    const { r, asked } = await run(b);
    expect(row(r, "4.3")).toEqual({
      id: "4.3",
      kind: "election",
      status: "unverifiable",
      code: "anchor-logs",
      at: {},
    });
    expect(r.archive).toEqual({ stopped: "anchor-logs", rule });
    expect(asked).toEqual([]);
  };

  test("logs with one left out, altered or added are no earlier locators", async () => {
    const locator = locatorOf(m1);
    await stops(
      bundle({ locator, logs: honestLogs.slice(1), stateLogs: honestLogs }),
      "accumulator",
    );
    const altered = honestLogs.map((l, i) => (i === 0 ? { ...l, data: word(3n) } : l));
    await stops(bundle({ locator, logs: altered, stateLogs: honestLogs }), "accumulator");
    const moved = honestLogs.map((l, i) => (i === 0 ? { ...l, block: l.block + 1n } : l));
    await stops(bundle({ locator, logs: moved, stateLogs: honestLogs }), "accumulator");
    // One more at or before B than the anchor counts.
    await stops(
      bundle({ locator, logs: [...honestLogs, other(B)], stateLogs: honestLogs }),
      "block-range",
    );
    // An accumulator that counts no log.
    await stops(bundle({ locator, logs: honestLogs, stateLogs: [] }), "block-range");
  });

  test("logs the anchor counts after B, or out of order, are no earlier locators", async () => {
    const locator = locatorOf(m1);
    const after = [other(B + 1n), located(locatorOf(m0), B + 1n), located(locator, B + 1n)];
    await stops(bundle({ locator, logs: after }), "block-range");
    const backwards = [other(B - 5n), located(locatorOf(m0), B - 6n), located(locator, B - 6n)];
    await stops(bundle({ locator, logs: backwards }), "order");
  });

  test("the anchor's logs on another chain or at another address are no earlier locators", async () => {
    // The anchor's genesis binds L1's chain and its own address (T-71).
    for (const [chainId, anchor] of [
      [definition.l1_chain_id + 1n, definition.l1_anchor],
      [definition.l1_chain_id, new Uint8Array(20).fill(0x11)],
    ] as const) {
      const { accumulator } = replayEventAccumulator(chainId, anchor, honestLogs);
      await stops(
        bundle({
          locator: locatorOf(m1),
          logs: honestLogs,
          stateLogs: null,
          extra: [
            [word(ACCUMULATOR), stored(accumulator)],
            [word(ACCUMULATOR + 1n), stored(word(BigInt(honestLogs.length)))],
          ],
        }),
        "accumulator",
      );
    }
  });

  test("a count word no accumulator writes is no earlier locators", async () => {
    await stops(
      bundle({
        locator: locatorOf(m1),
        logs: honestLogs,
        stateLogs: [],
        extra: [[word(ACCUMULATOR + 1n), stored(word(2n ** 64n))]],
      }),
      "count",
    );
  });

  test("an ArchiveLocated log that isn't the anchor's framing of a locator is locator-log", async () => {
    const locator = locatorOf(m1);
    const good = located(locator);
    const data = good.data;
    const bad: ContractLog[] = [
      // The version topic isn't the locator's.
      { ...good, topics: [ARCHIVE_LOCATED, word(2n)] },
      { ...good, topics: [ARCHIVE_LOCATED] },
      { ...good, topics: [...good.topics, word(0n)] },
      { ...good, topics: [...good.topics, word(0n), word(0n)] },
      // Data too short for a head, or not whole words.
      { ...good, data: data.subarray(0, 64) },
      { ...good, data: data.subarray(0, data.length - 1) },
      // Another offset, a length past the bytes, padding not zero, a word after.
      { ...good, data: concat([word(64n), data.subarray(32)]) },
      { ...good, data: concat([word(32n), word(BigInt(locator.length + 32)), data.subarray(64)]) },
      { ...good, data: data.map((x, i) => (i === data.length - 1 ? 1 : x)) },
      { ...good, data: concat([data, word(0n)]) },
      // Lengths the anchor refuses.
      { ...good, data: abiBytes(Uint8Array.of(0, 1)) },
      { ...good, data: abiBytes(new Uint8Array(129).fill(1)) },
    ];
    for (const log of bad) {
      const logs = [other(), log];
      await stops(bundle({ locator, count: 1n, logs }), "locator-log");
    }
    // The good one, alone, passes.
    const { r } = await run(bundle({ locator, count: 1n, logs: [other(), good] }));
    expect(r.archive).toMatchObject({ earlier: 1, walk: { findings: [] } });
  });

  test("logs whose locators the anchor's state contradicts are no earlier locators", async () => {
    const locator = locatorOf(m1);
    // More locators posted than logged.
    await stops(bundle({ locator, count: 3n, logs: honestLogs }), "locators");
    // The last logged isn't the latest.
    const swapped = [other(), located(locator), located(locatorOf(m0))];
    await stops(bundle({ locator, logs: swapped }), "locators");
    await stops(bundle({ locator, count: 0n, logs: [other()] }), "locators");
  });

  test("with no locator in state the logs aren't judged", async () => {
    const { r } = await run(bundle({ logs: honestLogs.slice(1), stateLogs: honestLogs }));
    expect(r.archive).toEqual({ stopped: "locator-none", count: "0" });
  });

  test("a bundle's anchorLogs are parsed strictly", () => {
    const base = (anchorLogs: unknown, format = BUNDLE_FORMAT_DEFINITION) =>
      JSON.stringify({
        format,
        definition: honest?.definition,
        clock: honest?.clock,
        l1: {
          ...anchoredL1(definition.election_id, definition.l1_anchor, copy, VERSION, clock, {
            number: B,
            timestamp: NOW,
          }),
        },
        anchorLogs,
      });
    const good = logsJson(honestLogs);
    expect(parseBundle(base(good), concat(copy))).toMatchObject({ anchorLogs: honestLogs });
    expect(parseBundle(base([]), concat(copy))).toMatchObject({ anchorLogs: [] });
    const one = good[0] as Record<string, unknown>;
    for (const bad of [
      {},
      [{ ...one, topics: [] }],
      [{ ...one, topics: Array(5).fill(one["topics"] && (one["topics"] as string[])[0]) }],
      [{ ...one, topics: ["aa"] }],
      [{ ...one, data: "" }],
      [{ ...one, data: "0x01" }],
      [{ ...one, block: "01" }],
      [{ ...one, timestamp: "18446744073709551616" }],
      [{ ...one, n: "0" }],
      [{ block: one["block"], timestamp: one["timestamp"], topics: one["topics"] }],
    ])
      expect(() => parseBundle(base(bad), concat(copy))).toThrow(BundleError);
  });
});

describe("the command line with --arweave", () => {
  // Arweave gateways as one local HTTP server: `/ar/raw/{id}` serves the
  // transactions `held` names, and `/none/raw/{id}` none.
  let server: Server;
  let origin: string;
  let held = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "abolish-verify-arweave-"));
  let dirs = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";
      requests.push(url);
      const m = /^\/ar\/raw\/([A-Za-z0-9_-]{43})$/u.exec(url);
      const body = m === null ? undefined : held.get(m[1] as string);
      if (body === undefined) res.writeHead(404).end();
      else res.writeHead(200).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const hold = (archive: readonly Archived[]) => {
    held = new Map(archive.map((a) => [arweaveId(a.transaction), objectCar(a.bytes)]));
    requests.length = 0;
  };

  function dir(json: string, board?: readonly Uint8Array[]): string {
    const d = join(root, String(dirs++));
    mkdirSync(d);
    writeFileSync(join(d, "bundle.json"), json);
    if (board !== undefined) writeFileSync(join(d, "board.bin"), concat(board));
    return d;
  }

  async function run(...args: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
    });
    return { code, stdout, stderr };
  }

  const logs = [other(), located(locatorOf(m0)), located(locatorOf(m1))];
  const logged = { locator: locatorOf(m1), logs };

  test("reads the archive over the gateways named, in order, and 4.3 passes", async () => {
    hold(WHOLE);
    const d = dir(bundleJson(logged), copy);
    const r = await run("--arweave", `${origin}/none`, "--arweave", `${origin}/ar/`, d);
    const report = JSON.parse(r.stdout) as Report;
    expect(row(report, "4.3")).toEqual({ id: "4.3", kind: "election", status: "pass" });
    // As the library reads it, and every other row as a run without the archive.
    const read = await readArchive(bundle(logged), arweave(WHOLE).source);
    expect(report).toEqual(JSON.parse(JSON.stringify(verifyBundle(read.bundle))));
    expect(without43(report)).toEqual(without43(JSON.parse((await run(d)).stdout) as Report));
    // Each transaction asked of the first gateway, then the second: only the
    // raw-data route under each base path.
    expect(requests).toEqual(
      [m1, m0, ...objects].flatMap((o) => {
        const id = arweaveId(o.transaction);
        return [`/none/raw/${id}`, `/ar/raw/${id}`];
      }),
    );
  });

  test("the objects read serve the board copy of a bundle that holds none", async () => {
    hold(WHOLE);
    const r = await run(
      "--arweave",
      `${origin}/ar`,
      dir(bundleJson({ ...logged, board: [], withCheckpoints: true })),
    );
    const report = JSON.parse(r.stdout) as Report;
    for (const id of ["4.1", "4.2", "4.3"]) expect(row(report, id).status, id).toBe("pass");
    expect(report.board.byCid).toEqual({});
  });

  test("blocks.car is asked first, then the objects read, and a --gateway for neither's blocks only (T-11)", async () => {
    hold(WHOLE);
    const json = bundleJson({ ...logged, board: [], withCheckpoints: true });
    const segment = objects[0] as Archived;
    const viaGateway = (...files: string[]) =>
      run("--arweave", `${origin}/ar`, "--gateway", `${origin}/ipfs-none`, ...files);
    for (const car of [objectCar(segment.bytes), undefined]) {
      requests.length = 0;
      const d = dir(json);
      if (car !== undefined) writeFileSync(join(d, "blocks.car"), car);
      const report = JSON.parse((await viaGateway(d)).stdout) as Report;
      for (const id of ["4.1", "4.2", "4.3"]) expect(row(report, id).status, id).toBe("pass");
      expect(report.board.byCid).toEqual({
        ...(car !== undefined && { storeBlocks: 1, storeUnreadableBytes: 0 }),
        gateways: { requests: 0, blocks: 0 },
      });
      expect(requests.filter((r) => !r.startsWith("/ar/"))).toEqual([]);
    }
  });

  test("without --arweave nothing is read and 4.3 stays not-implemented", async () => {
    hold(WHOLE);
    const r = await run(dir(bundleJson(logged), copy));
    expect(row(JSON.parse(r.stdout) as Report, "4.3").code).toBe("not-implemented");
    expect(requests).toEqual([]);
  });

  test("each budget reaches the read, and one run out leaves 4.3 unverifiable", async () => {
    hold(WHOLE);
    const d = dir(bundleJson(logged), copy);
    const archive = async (...args: string[]) => {
      const r = await run("--arweave", `${origin}/ar`, ...args, d);
      expect(r.code).toBe(EXIT_CODES.unverifiable);
      const report = JSON.parse(r.stdout) as Report;
      return { row: row(report, "4.3"), archive: report.archive };
    };
    const walk = await archive("--max-archive-manifests", "1");
    expect(walk.row).toMatchObject({ status: "unverifiable", code: "over-budget" });
    for (const budget of ["--max-archive-bytes", "--max-archive-reads"]) {
      const objects = await archive(budget, "1");
      expect(objects.row, budget).toMatchObject({
        status: "unverifiable",
        code: "objects-over-budget",
      });
    }
    // Budgets large enough change nothing.
    const roomy = await archive(
      "--max-archive-manifests",
      "2",
      "--max-archive-bytes",
      String(2 ** 20),
      "--max-archive-reads",
      String(objects.length),
      // A format-3 bundle reads no evidence for 4.6, and this archive lists
      // none and no run for 4.4's replay, so their budgets change nothing.
      "--max-archive-evidence-reads",
      "1",
      "--max-archive-replay-evidence-reads",
      "1",
      "--max-archive-run-bytes",
      "1",
      "--max-archive-run-reads",
      "1",
    );
    expect(roomy.row.status).toBe("pass");
  });

  test("refuses a bad budget, a budget without --arweave, a bad gateway or too many as usage, asking nothing", async () => {
    hold(WHOLE);
    const d = dir(bundleJson(logged), copy);
    for (const budget of [
      "--max-archive-manifests",
      "--max-archive-bytes",
      "--max-archive-reads",
      "--max-archive-evidence-reads",
      "--max-archive-replay-evidence-reads",
      "--max-archive-run-bytes",
      "--max-archive-run-reads",
    ]) {
      for (const bad of ["0", "01", "-1", "1e3", "", " 1", String(2 ** 53)]) {
        const u = await run("--arweave", `${origin}/ar`, budget, bad, d);
        expect(u.code, `${budget} ${bad}`).toBe(EXIT_CODES.usage);
        expect(u.stdout).toBe("");
      }
      const alone = await run(budget, "1", d);
      expect(alone.code, budget).toBe(EXIT_CODES.usage);
      expect(alone.stderr).toMatch(new RegExp(`^${budget}: only with --arweave`, "u"));
    }
    for (const bad of ["", "ftp://x", "https://x/?a", "https://u:p@x"]) {
      const u = await run("--arweave", bad, d);
      expect(u.code, bad).toBe(EXIT_CODES.usage);
      expect(u.stdout).toBe("");
    }
    const many = Array.from({ length: MAX_GATEWAYS + 1 }, () => ["--arweave", origin]).flat();
    expect((await run(...many, d)).code).toBe(EXIT_CODES.usage);
    expect(requests).toEqual([]);
  });

  test("a bundle of format 1 or 2 has no archive to read: rejected, nothing asked", async () => {
    hold(WHOLE);
    const common = {
      electionId: bytesToHex(definition.election_id),
      boardEntryVersion: 1,
      clock: honest?.clock,
    };
    const format1 = { format: BUNDLE_FORMAT, ...common, now: "0", anchors: [] };
    // Format 2: the same L1 evidence under the anchor it names.
    const { l1 } = JSON.parse(bundleJson(logged)) as { l1: object };
    const format2 = {
      format: BUNDLE_FORMAT_L1,
      ...common,
      l1: { ...l1, anchor: bytesToHex(definition.l1_anchor), firstSegment: "0" },
    };
    for (const [format, json] of [
      [BUNDLE_FORMAT, format1],
      [BUNDLE_FORMAT_L1, format2],
    ] as const) {
      const d = dir(JSON.stringify(json), []);
      // The bundle itself is one a run without the archive takes.
      expect((await run(d)).code, format).not.toBe(EXIT_CODES.bundleRejected);
      const r = await run("--arweave", `${origin}/ar`, d);
      expect(r.code, format).toBe(EXIT_CODES.bundleRejected);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(
        `bundle rejected: format: ${format} names no deployment, so it has no archive to read\n`,
      );
    }
    expect(requests).toEqual([]);
  });
});
