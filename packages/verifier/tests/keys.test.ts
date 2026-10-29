import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeDeploymentRecord,
  decodeReleaseRecord,
  deploymentHash,
  type DeploymentSeatRelay,
  encodeDeploymentRecord,
  encodeReleaseRecord,
  releaseHash,
  tier0TokenPublicKey,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vite-plus/test";
import {
  BundleError,
  type CliContext,
  EXIT_CODES,
  KEYS_EVIDENCE_FORMAT,
  type KeysReport,
  keysSummary,
  MAX_KEYS_FINDINGS,
  parseKeysEvidence,
  type ReleaseRegistryPin,
  releaseHashSlot,
  releaseTimesSlot,
  RELEASE_REGISTRY_NAMESPACE,
  runCli,
  runKeys,
} from "../src/index.ts";
import { rlp } from "./headers.ts";
import { anchorState, buildTrie, l2State, stored, word } from "./state.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// docs/spec/vectors/keys-run.json, from the independent Python generator
// (packages/crypto/scripts/keys-run-vectors.py), never from the code under
// test. Its judgments start from the registry's proven words; the trie
// they are proven from is written here by tests/state.ts, from the Yellow
// Paper, not by the reader under test.
interface Vector {
  readonly id: string;
  readonly description: string;
  readonly storage: Readonly<Record<string, string>>;
  readonly records: readonly string[];
  readonly deployments: readonly string[];
  readonly now: string;
  readonly runAt: string;
  readonly expect: Pick<
    KeysReport,
    "result" | "releases" | "periods" | "findings" | "findingsTruncated"
  >;
}
interface KeysFile {
  readonly format: string;
  readonly pins: { readonly l1ChainId: string; readonly registry: string };
  readonly tokenKeyPeriod: string;
  readonly maxL1Staleness: string;
  readonly maxFindings: string;
  readonly records: Readonly<Record<string, string>>;
  readonly deployments: Readonly<Record<string, string>>;
  readonly vectors: readonly Vector[];
}
const read = (name: string) =>
  readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8");
const vectors = JSON.parse(read("keys-run.json")) as KeysFile;

// tests/state.ts gives its contracts this code.
const CODE = keccak_256(Uint8Array.of(0xfe));
const PIN: ReleaseRegistryPin = {
  l1ChainId: BigInt(vectors.pins.l1ChainId),
  address: hexToBytes(vectors.pins.registry),
  codeHash: CODE,
};

type Storage = readonly (readonly [Uint8Array, Uint8Array])[];

// Slots and their words; a zero word is left out of the trie, as L1 stores none.
const storageOf = (v: Pick<Vector, "storage">): Storage =>
  Object.entries(v.storage).map(([slot, w]) => [hexToBytes(slot), hexToBytes(w)] as const);

/** keys.json for `storage` at a block at `now`, with the given records. */
function evidence(
  storage: Storage,
  now: bigint,
  records: readonly string[],
  deployments: readonly string[],
  address = PIN.address,
) {
  const { evidence: state } = l2State([{ address, storage }], 21_000_000n, now);
  return JSON.stringify({
    format: KEYS_EVIDENCE_FORMAT,
    l1: { header: bytesToHex(state.header), nodes: state.nodes.map(bytesToHex) },
    records,
    deployments,
  });
}

const vectorEvidence = (v: Vector) =>
  evidence(
    storageOf(v),
    BigInt(v.now),
    v.records.map((r) => vectors.records[r] as string),
    v.deployments.map((d) => vectors.deployments[d] as string),
  );

function judged(r: KeysReport) {
  const { result, releases, periods, findings, findingsTruncated } = r;
  return Object.fromEntries(
    Object.entries({ result, releases, periods, findings, findingsTruncated }).filter(
      ([, x]) => x !== undefined,
    ),
  );
}

const vector = (id: string) => vectors.vectors.find((v) => v.id === id) as Vector;

test("the file is the keys-run vector format, with the constants this release uses", () => {
  expect(vectors.format).toBe("abolish-keys-run-vectors/1");
  expect(vectors.tokenKeyPeriod).toBe("2592000");
  expect(vectors.maxL1Staleness).toBe("3600");
  expect(vectors.maxFindings).toBe(String(MAX_KEYS_FINDINGS));
  // The namespace and slots, as release-registry.json gives them.
  const registry = JSON.parse(read("release-registry.json")) as {
    namespace: { count: string };
    slots: readonly { sequence: string; hash: string; times: string }[];
  };
  expect(bytesToHex(word(RELEASE_REGISTRY_NAMESPACE))).toBe(registry.namespace.count);
  for (const s of registry.slots) {
    expect(bytesToHex(releaseHashSlot(BigInt(s.sequence)))).toBe(s.hash);
    expect(bytesToHex(releaseTimesSlot(BigInt(s.sequence)))).toBe(s.times);
  }
});

describe("keys run over keys-run.json", () => {
  for (const v of vectors.vectors)
    test(`${v.id}: ${v.description}`, () => {
      const report = runKeys(parseKeysEvidence(vectorEvidence(v)), PIN, BigInt(v.runAt));
      expect(judged(report)).toEqual(v.expect);
      expect(report.verdict).toBe("unverifiable");
      expect(report.verdictAgainstInputs).toBe(
        { pass: "verified", fail: "failed", unverifiable: "unverifiable" }[v.expect.result.status],
      );
      expect(report.l1.timestamp).toBe(v.now);
      expect(report.runAt).toBe(v.runAt);
    });

  test("every code of the run's table is some vector's result", () => {
    expect(new Set(vectors.vectors.map((v) => v.expect.result.status))).toEqual(
      new Set(["pass", "fail", "unverifiable"]),
    );
    const codes = new Set(
      vectors.vectors.flatMap((v) =>
        v.expect.result.status === "pass" ? [] : [v.expect.result.code],
      ),
    );
    for (const c of [
      "deployment-record-missing",
      "unsupported-version",
      "deployment-record",
      "token-key-changed",
      "token-key-reused",
      "token-key-unretired",
      "token-key-late",
      "release-record-missing",
      "release-record",
      "release-chain",
      "release-registry-state",
      "release-none",
      "l1-stale",
    ])
      expect(codes).toContain(c);
  });
});

describe("the registry's account", () => {
  const honest = vector("honest");
  const run = (json: string, pin: ReleaseRegistryPin | undefined = PIN) =>
    runKeys(parseKeysEvidence(json), pin, BigInt(honest.runAt));

  test("passes the honest history at the pinned address with the pinned code", () => {
    expect(run(vectorEvidence(honest)).result).toEqual({ status: "pass" });
  });

  test("a release that pins no registry is unverifiable, whatever the evidence", () => {
    const r = runKeys(parseKeysEvidence(vectorEvidence(honest)), undefined, BigInt(honest.runAt));
    expect(r.result).toEqual({ status: "unverifiable", code: "release-registry-unpinned", at: {} });
    expect(r.releases).toBeUndefined();
  });

  test("no account at the pinned address is unverifiable, never no release", () => {
    const json = evidence(
      storageOf(honest),
      BigInt(honest.now),
      [],
      [],
      new Uint8Array(20).fill(7),
    );
    expect(run(json).result).toEqual({
      status: "unverifiable",
      code: "release-registry-absent",
      at: {},
    });
  });

  test("an account without code at the pinned address is absent, never empty storage", () => {
    const { evidence: state } = l2State(
      [
        {
          address: PIN.address,
          storage: storageOf(honest),
          codeHash: keccak_256(new Uint8Array()),
        },
      ],
      21_000_000n,
      BigInt(honest.now),
    );
    const json = JSON.stringify({
      format: KEYS_EVIDENCE_FORMAT,
      l1: { header: bytesToHex(state.header), nodes: state.nodes.map(bytesToHex) },
      records: [],
      deployments: [],
    });
    expect(run(json).result).toEqual({
      status: "unverifiable",
      code: "release-registry-absent",
      at: {},
    });
  });

  test("a stored value that isn't a word's canonical encoding is malformed, never a count", () => {
    // `count` stored as 0x0003: a leading zero no trie holds.
    const state = anchorState(
      PIN.address,
      [[word(RELEASE_REGISTRY_NAMESPACE), rlp(Uint8Array.of(0, 3))]],
      { number: 21_000_000n, timestamp: BigInt(honest.now) },
    );
    const json = JSON.stringify({
      format: KEYS_EVIDENCE_FORMAT,
      l1: { header: bytesToHex(state.header), nodes: state.nodes.map(bytesToHex) },
      records: [],
      deployments: [],
    });
    expect(run(json).result).toEqual({
      status: "unverifiable",
      code: "l1-proof-malformed",
      at: {},
    });
  });

  test("an account with other code fails, whatever its words say", () => {
    const r = run(vectorEvidence(honest), { ...PIN, codeHash: keccak_256(Uint8Array.of(0xff)) });
    expect(r.result).toEqual({ status: "fail", code: "release-registry-code", at: {} });
  });

  test("a node the walk needs and the evidence lacks is unverifiable", () => {
    const e = JSON.parse(vectorEvidence(honest)) as { l1: { nodes: string[] } };
    // Without the storage trie's root, no word is read.
    const trie = buildTrie(storageOf(honest).map(([slot, w]) => [slot, stored(w)] as const));
    const storageRoot = trie.nodes.at(-1) as Uint8Array;
    e.l1.nodes = e.l1.nodes.filter((n) => n !== bytesToHex(storageRoot));
    expect(run(JSON.stringify(e)).result).toEqual({
      status: "unverifiable",
      code: "l1-proof-missing",
      at: {},
    });
  });

  test("a release whose words aren't proven stops the run at that release", () => {
    // Sequence 1's times word left out of the trie reads as zero: no
    // publication, which the release code never writes.
    const slot = bytesToHex(releaseTimesSlot(1n));
    const storage = storageOf({
      storage: Object.fromEntries(Object.entries(honest.storage).filter(([k]) => k !== slot)),
    });
    const r = run(evidence(storage, BigInt(honest.now), [], []));
    expect(r.result).toEqual({
      status: "fail",
      code: "release-registry-state",
      at: { sequence: "1" },
    });
  });
});

describe("findings", () => {
  // 47 version-2 releases, each listing one period under its own key: every
  // pair breaks token-key-changed, 1,081 findings in all.
  // With `relays`, each deployment is version 3, the seat relays of
  // deployment-record-v3.json's typical record beside the same fields.
  function many(n: number, relays?: readonly DeploymentSeatRelay[]) {
    const honest = vector("honest");
    const base = decodeDeploymentRecord(
      hexToBytes(vectors.deployments[honest.deployments[1] as string] as string),
    );
    const release = decodeReleaseRecord(
      hexToBytes(vectors.records[honest.records[0] as string] as string),
    );
    if (base.version !== 2 || release.version !== 1) throw new Error("fixture");
    const period = base.value.tier0_token_keys[1]?.period as number;
    const publishedAt = BigInt(period) * 2_592_000n + 1n;
    const records: string[] = [];
    const deployments: string[] = [];
    const storage: [string, string][] = [
      [bytesToHex(word(RELEASE_REGISTRY_NAMESPACE)), bytesToHex(word(BigInt(n)))],
    ];
    let previous: Uint8Array = new Uint8Array(32);
    for (let s = 0; s < n; s++) {
      const secret = new Uint8Array(32);
      secret[0] = s + 1;
      const value = {
        ...base.value,
        tier0_token_keys: [{ period, key: tier0TokenPublicKey(secret), retired: false }],
      };
      const d =
        relays === undefined
          ? encodeDeploymentRecord({ version: 2, value })
          : encodeDeploymentRecord({ version: 3, value: { ...value, seat_relays: relays } });
      const r = encodeReleaseRecord({
        version: 1,
        value: {
          ...release.value,
          sequence: BigInt(s),
          previous,
          deployment_hash: deploymentHash(d),
        },
      });
      previous = releaseHash(r);
      records.push(bytesToHex(r));
      deployments.push(bytesToHex(d));
      storage.push([bytesToHex(releaseHashSlot(BigInt(s))), bytesToHex(previous)]);
      storage.push([bytesToHex(releaseTimesSlot(BigInt(s))), bytesToHex(word(publishedAt))]);
    }
    const now = publishedAt + 10n;
    return {
      json: evidence(
        storageOf({ storage: Object.fromEntries(storage) }),
        now,
        records,
        deployments,
      ),
      now,
    };
  }

  test("the report lists at most 1,000, and says when there were more", () => {
    const { json, now } = many(47);
    const r = runKeys(parseKeysEvidence(json), PIN, now);
    expect(r.findings).toHaveLength(MAX_KEYS_FINDINGS);
    expect(r.findingsTruncated).toBe(true);
    // By the later release, then the earlier.
    expect(r.findings?.slice(0, 4).map((f) => [f.at["later"], f.at["earlier"]])).toEqual([
      ["1", "0"],
      ["2", "0"],
      ["2", "1"],
      ["3", "0"],
    ]);
    expect(r.result).toEqual({ status: "fail", ...r.findings?.[0] });
  });

  test("well-formed version-3 deployments are resolved and their pairs judged", () => {
    const v3 = decodeDeploymentRecord(
      hexToBytes(
        (
          JSON.parse(read("deployment-record-v3.json")) as {
            vectors: { id: string; encoding: string }[];
          }
        ).vectors.find((v) => v.id === "typical")?.encoding ?? "",
      ),
    );
    if (v3.version !== 3) throw new Error("fixture");
    // Two releases whose keys differ for one period: a run that left them out
    // of the pairs would pass.
    const { json, now } = many(2, v3.value.seat_relays);
    const r = runKeys(parseKeysEvidence(json), PIN, now);
    expect(r.releases?.map((x) => [x.version, x.outcome])).toEqual([
      ["3", "resolved"],
      ["3", "resolved"],
    ]);
    expect(r.result).toEqual({
      status: "fail",
      code: "token-key-changed",
      at: { earlier: "0", later: "1", period: r.periods?.[0]?.period },
    });
  });

  test("below the cap every finding is listed and the flag is absent", () => {
    // 45 releases: 990 pairs.
    const { json, now } = many(45);
    const r = runKeys(parseKeysEvidence(json), PIN, now);
    expect(r.findings).toHaveLength(990);
    expect(r.findingsTruncated).toBeUndefined();
  });
});

test("a large pool of records the registry doesn't hold costs one hash each", () => {
  const v = vector("honest");
  const junk = Array.from({ length: 20_000 }, (_, i) => i.toString(16).padStart(8, "0"));
  const json = evidence(
    storageOf(v),
    BigInt(v.now),
    [...junk, ...v.records.map((r) => vectors.records[r] as string)],
    [...junk, ...v.deployments.map((d) => vectors.deployments[d] as string)],
  );
  const started = performance.now();
  expect(runKeys(parseKeysEvidence(json), PIN, BigInt(v.runAt)).result).toEqual({ status: "pass" });
  // Linear: well under a second here, where a search per release would hash
  // the pool once for each of them.
  expect(performance.now() - started).toBeLessThan(10_000);
});

describe("properties", () => {
  test("the order of the given records and deployments, and records added beside them, change nothing", () => {
    const pool = Object.values(vectors.records);
    const deploymentPool = Object.values(vectors.deployments);
    fc.assert(
      fc.property(
        fc.constantFrom(...vectors.vectors),
        fc.infiniteStream(fc.nat()),
        fc.subarray(pool),
        fc.subarray(deploymentPool),
        (v, seeds, extraRecords, extraDeployments) => {
          const records = v.records.map((r) => vectors.records[r] as string);
          const deployments = v.deployments.map((d) => vectors.deployments[d] as string);
          const shuffle = <T>(xs: readonly T[]) => {
            const it = seeds[Symbol.iterator]();
            return xs
              .map((x) => [it.next().value as number, x] as const)
              .sort((a, b) => a[0] - b[0])
              .map(([, x]) => x);
          };
          // A record or deployment the vector didn't give may resolve a
          // release it left missing, so only ones it already holds by hash
          // are added again; any other changes the run, as it should.
          const given = new Set(records);
          const givenDeployments = new Set(deployments);
          const json = evidence(
            storageOf(v),
            BigInt(v.now),
            shuffle([...records, ...extraRecords.filter((r) => given.has(r) || !holds(v, r))]),
            shuffle([
              ...deployments,
              ...extraDeployments.filter((d) => givenDeployments.has(d) || !named(v, d)),
            ]),
          );
          const r = runKeys(parseKeysEvidence(json), PIN, BigInt(v.runAt));
          expect(judged(r)).toEqual(v.expect);
        },
      ),
      { numRuns },
    );
  });

  test("evidence that isn't keys.json's shape is rejected, never judged or thrown otherwise", () => {
    const honest = JSON.parse(vectorEvidence(vector("honest"))) as Record<string, unknown>;
    fc.assert(
      fc.property(
        fc.oneof(
          fc.json(),
          fc
            .record({
              key: fc.constantFrom("format", "l1", "records", "deployments", "extra"),
              value: fc.jsonValue(),
            })
            .map(({ key, value }) => JSON.stringify({ ...honest, [key]: value })),
        ),
        (json) => {
          try {
            parseKeysEvidence(json);
          } catch (e) {
            expect(e).toBeInstanceOf(BundleError);
          }
        },
      ),
      { numRuns },
    );
  });
});

// Whether `record` is the release record of some release the vector's
// registry holds; `named`, whether `deployment` is named by a record the
// vector gives. Adding either can only resolve a release.
function holds(v: Vector, record: string): boolean {
  const hash = bytesToHex(releaseHash(hexToBytes(record)));
  return Object.values(v.storage).includes(hash);
}

function named(v: Vector, deployment: string): boolean {
  const hash = bytesToHex(deploymentHash(hexToBytes(deployment)));
  return v.records.some((r) => (vectors.records[r] as string).includes(hash));
}

describe("abolish-verify keys", () => {
  const root = mkdtempSync(join(tmpdir(), "abolish-verify-keys-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dirOf = (name: string, json: string) => {
    const dir = join(root, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    writeFileSync(join(dir, "keys.json"), json);
    return dir;
  };
  const cli = async (
    args: readonly string[],
    context: CliContext = { clock: () => BigInt(vector("honest").runAt), registry: PIN },
  ) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      args,
      { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
      context,
    );
    return { code, stdout, stderr };
  };

  test("writes the report and exits on its verdict alone", async () => {
    const dir = dirOf("honest", vectorEvidence(vector("honest")));
    const { code, stdout, stderr } = await cli(["keys", dir]);
    // l1Header is a local file, so even a pass is unverifiable.
    expect(code).toBe(EXIT_CODES.unverifiable);
    const report = JSON.parse(stdout) as KeysReport;
    expect(report.format).toBe("abolish-keys-report/1");
    expect(report.inputs).toEqual({
      l1Header: "local-file",
      releases: "l1-state-proof",
      records: "by-hash",
    });
    expect(report.verdictAgainstInputs).toBe("verified");
    expect(stderr).toBe(keysSummary(report));
    expect(stderr.split("\n").slice(0, 2)).toEqual([
      "verdict: unverifiable (unauthenticated inputs: l1Header; against those inputs: verified)",
      "3 releases, 9 periods listed",
    ]);
  });

  test("the summary lists each finding, then the failing result", async () => {
    const dir = dirOf("late-and-changed", vectorEvidence(vector("late-and-changed")));
    const { stderr } = await cli(["keys", "--", dir], {
      clock: () => BigInt(vector("late-and-changed").runAt),
      registry: PIN,
    });
    const lines = stderr.trimEnd().split("\n");
    expect(lines.slice(2)).toEqual([
      ...vector("late-and-changed").expect.findings!.map(
        (f) => `  ${f.code} ${JSON.stringify(f.at)}`,
      ),
      `  keys fail token-key-changed ${JSON.stringify(vector("late-and-changed").expect.findings![0]!.at)}`,
    ]);
  });

  test("this release pins no registry, so the run is unverifiable", async () => {
    const dir = dirOf("unpinned", vectorEvidence(vector("honest")));
    const { code, stdout } = await cli(["keys", dir], {
      clock: () => BigInt(vector("honest").runAt),
      registry: undefined,
    });
    expect(code).toBe(EXIT_CODES.unverifiable);
    expect((JSON.parse(stdout) as KeysReport).result).toMatchObject({
      code: "release-registry-unpinned",
    });
  });

  test("evidence that doesn't parse is rejected with no report", async () => {
    const dir = dirOf("rejected", JSON.stringify({ format: KEYS_EVIDENCE_FORMAT }));
    const { code, stdout, stderr } = await cli(["keys", dir]);
    expect(code).toBe(EXIT_CODES.bundleRejected);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^evidence rejected: keys.json: missing l1/);
  });

  test("a duplicate member rejects the evidence", async () => {
    const json = vectorEvidence(vector("honest"));
    const dir = dirOf("duplicate", json.replace('{"format"', `{"records":[],"format"`));
    expect((await cli(["keys", dir])).code).toBe(EXIT_CODES.bundleRejected);
  });

  test("the bundle options, no directory or two are usage errors", async () => {
    const dir = dirOf("usage", vectorEvidence(vector("honest")));
    for (const args of [
      ["keys", "--gateway", "https://gateway.example", dir],
      ["keys", "--max-board-bytes", "10", dir],
      ["keys"],
      ["keys", ""],
      ["keys", dir, dir],
      ["keys", "--help"],
    ])
      expect((await cli(args)).code).toBe(EXIT_CODES.usage);
  });

  test("after --, keys is a bundle directory's name", async () => {
    const { code, stderr } = await cli(["--", join(root, "keys")]);
    expect(code).toBe(EXIT_CODES.bundleRejected);
    expect(stderr).toMatch(/^bundle rejected: bundle.json/);
  });
});
