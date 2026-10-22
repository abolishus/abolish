// The keys run (docs/spec/verifier.md, Token keys across releases): every
// release the pinned registry holds, revoked or not, read from L1 state; its
// release record and deployment record found by hash; every pair of
// version-2 deployments judged by the rules across releases; and each
// period's key first listed before its period began. A Tier 0 key that
// changes, moves or comes back from retirement, or that no release published
// before its period, lets the issuer tell one account's tokens from
// another's (T-74, T-10). The rules are packages/crypto's; this file reads
// and orders them. It contacts no host.

import {
  DecodeError,
  type DecodedDeploymentRecord,
  decodeDeploymentRecord,
  decodeReleaseRecord,
  deploymentAcrossRule,
  type DeploymentFailure,
  deploymentHash,
  type DeploymentRecordV2,
  deploymentRecordRule,
  releaseHash,
  releaseRecordRule,
  TOKEN_KEY_PERIOD,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { array, BundleError, header, hexBytes, object, rejectDuplicateMembers } from "./bundle.ts";
import { type L1Header, NodePool } from "./l1.ts";
import {
  checkFresh,
  type PublishedRelease,
  type RegistryCode,
  registryCodeFails,
  RegistryError,
  registryWords,
  releaseAt,
  releaseCount,
  type ReleaseRegistryPin,
} from "./registry.ts";
import type { Verdict } from "./verify.ts";

export const KEYS_EVIDENCE_FORMAT = "abolish-keys-evidence/1";
export const KEYS_REPORT_FORMAT = "abolish-keys-report/1";

/** The most findings a report lists: a Safe publishing many releases can't grow it with their square (T-52). */
export const MAX_KEYS_FINDINGS = 1000;

/** A keys run's evidence (keys.json). */
export interface KeysEvidence {
  readonly header: L1Header;
  readonly nodes: NodePool;
  /** Release records, each its whole encoding; only their hashes decide which is read. */
  readonly records: readonly Uint8Array[];
  /** Deployment records, likewise. */
  readonly deployments: readonly Uint8Array[];
}

/**
 * Parses keys.json: exactly `format`, `l1` (`header`, `nodes`), `records`
 * and `deployments`, each record lowercase hex. Throws `BundleError`, so
 * evidence that isn't this shape has no report.
 */
export function parseKeysEvidence(json: string): KeysEvidence {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new BundleError("keys.json: not JSON");
  }
  rejectDuplicateMembers(json, "keys.json");
  const e = object(value, ["format", "l1", "records", "deployments"], "keys.json");
  if (e["format"] !== KEYS_EVIDENCE_FORMAT)
    throw new BundleError(`format: expected ${KEYS_EVIDENCE_FORMAT}`);
  const l1 = object(e["l1"], ["header", "nodes"], "l1");
  const list = (name: string) => array(e[name], name).map((x, i) => hexBytes(x, `${name}[${i}]`));
  return {
    header: header(l1["header"], "l1.header"),
    nodes: new NodePool(
      array(l1["nodes"], "l1.nodes").map((n, i) => hexBytes(n, `l1.nodes[${i}]`)),
    ),
    records: list("records"),
    deployments: list("deployments"),
  };
}

export type KeysCode =
  | RegistryCode
  | "release-record-missing"
  | "release-record"
  | "release-chain"
  | "unsupported-version"
  | "deployment-record-missing"
  | "deployment-record"
  | "token-key-changed"
  | "token-key-reused"
  | "token-key-unretired"
  | "token-key-late";

/** Where a code applies; every number a decimal string. */
export type KeysAt = Readonly<Record<string, string>>;

export interface KeysFinding {
  readonly code: KeysCode;
  readonly at: KeysAt;
}

export interface KeysReleaseRow {
  readonly sequence: string;
  readonly hash: string;
  readonly publishedAt: string;
  readonly revokedAt?: string;
  readonly deploymentHash?: string;
  readonly version?: string;
  /** `resolved`, or step 4's code. */
  readonly outcome: "resolved" | KeysCode;
}

export interface KeysPeriodRow {
  readonly period: string;
  /** The key its first listing lists. */
  readonly key: string;
  readonly firstListed: string;
  readonly retiredFrom?: string;
}

export type KeysResult =
  | { readonly status: "pass" }
  | { readonly status: "fail" | "unverifiable"; readonly code: KeysCode; readonly at: KeysAt };

export interface KeysReport {
  readonly format: typeof KEYS_REPORT_FORMAT;
  readonly verdict: Verdict;
  readonly verdictAgainstInputs: Verdict;
  readonly inputs: {
    readonly l1Header: "local-file";
    readonly releases: "l1-state-proof";
    readonly records: "by-hash";
  };
  readonly l1: {
    readonly blockHash: string;
    readonly blockNumber: string;
    readonly timestamp: string;
  };
  readonly runAt: string;
  readonly releases?: readonly KeysReleaseRow[];
  readonly periods?: readonly KeysPeriodRow[];
  readonly findings?: readonly KeysFinding[];
  readonly findingsTruncated?: true;
  readonly result: KeysResult;
}

const INPUTS = Object.freeze({
  l1Header: "local-file",
  releases: "l1-state-proof",
  records: "by-hash",
} as const);

// The place of a deployment rule, as `illFormedAt` gives it in the vectors.
function deploymentAt(f: DeploymentFailure): KeysAt {
  const { rule, ...where } = f as DeploymentFailure & Record<string, string | number>;
  return {
    rule,
    ...Object.fromEntries(Object.entries(where).map(([k, x]) => [k, String(x)])),
  };
}

interface Resolved {
  readonly resolved: true;
  readonly deployment: DecodedDeploymentRecord;
  readonly hash: Uint8Array;
}

interface Unresolved {
  readonly resolved: false;
  readonly code: KeysCode;
  readonly at: KeysAt;
  readonly fails: boolean;
}

type Step4 = Resolved | Unresolved;

/**
 * Step 4 for release `r`: its release record, checked as a client run's
 * steps 4 and 5 check it, then its deployment record, decoded and checked
 * for well-formedness. A version this release doesn't read is never a
 * failure (T-36). `row` gets `deploymentHash` and `version` as they are found.
 */
function findDeployment(
  r: PublishedRelease,
  previous: Uint8Array,
  pin: ReleaseRegistryPin,
  evidence: KeysEvidence,
  row: { deploymentHash?: string; version?: string },
): Step4 {
  const S = { sequence: r.sequence.toString() };
  const stop = (code: KeysCode, at: KeysAt, fails: boolean): Step4 => ({
    resolved: false,
    code,
    at,
    fails,
  });
  const encoding = evidence.records.find((e) => equal(releaseHash(e), r.hash));
  if (encoding === undefined) return stop("release-record-missing", S, false);
  let record;
  try {
    record = decodeReleaseRecord(encoding);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    if (e.code === "unknown-version")
      return stop("unsupported-version", { ...S, record: "release" }, false);
    return stop("release-record", { ...S, decodeError: e.code }, true);
  }
  const bad = releaseRecordRule(record);
  if (bad !== undefined)
    return stop(
      "release-record",
      { ...S, rule: bad.rule, ...("site" in bad && { site: String(bad.site) }) },
      true,
    );
  const v = record.value;
  if (
    v.l1_chain_id !== pin.l1ChainId ||
    !equal(v.registry, pin.address) ||
    v.sequence !== r.sequence ||
    !equal(v.previous, previous)
  )
    return stop("release-chain", S, true);
  row.deploymentHash = bytesToHex(v.deployment_hash);
  const denc = evidence.deployments.find((e) => equal(deploymentHash(e), v.deployment_hash));
  if (denc === undefined) return stop("deployment-record-missing", S, false);
  let deployment: DecodedDeploymentRecord;
  try {
    deployment = decodeDeploymentRecord(denc);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    if (e.code === "unknown-version")
      return stop("unsupported-version", { ...S, record: "deployment" }, false);
    return stop("deployment-record", { ...S, decodeError: e.code }, true);
  }
  row.version = String(deployment.version);
  const rule = deploymentRecordRule(deployment);
  if (rule !== undefined) return stop("deployment-record", { ...S, ...deploymentAt(rule) }, true);
  return { resolved: true, deployment, hash: v.deployment_hash };
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const P = BigInt(TOKEN_KEY_PERIOD);

/**
 * Runs the keys run over `evidence` at the run's clock `runAt` (seconds),
 * against the registry `pin` names. Steps 1 to 3 stop at the first code;
 * after them every release, pair and period is judged, and the result is
 * the first failing code in the order of steps 4 to 6, else step 4's first
 * unsettled one, else a pass.
 */
export function runKeys(
  evidence: KeysEvidence,
  pin: ReleaseRegistryPin | undefined,
  runAt: bigint,
): KeysReport {
  const report = (
    result: KeysResult,
    rest: Pick<KeysReport, "releases" | "periods" | "findings" | "findingsTruncated"> = {},
  ): KeysReport => {
    const against: Verdict =
      result.status === "pass" ? "verified" : result.status === "fail" ? "failed" : "unverifiable";
    return {
      format: KEYS_REPORT_FORMAT,
      // `l1Header` is a local file, so no run is verified on its own word.
      verdict: "unverifiable",
      verdictAgainstInputs: against,
      inputs: INPUTS,
      l1: {
        blockHash: bytesToHex(evidence.header.hash),
        blockNumber: evidence.header.number.toString(),
        timestamp: evidence.header.timestamp.toString(),
      },
      runAt: runAt.toString(),
      ...rest,
      result,
    };
  };

  // Steps 1 to 3.
  const now = evidence.header.timestamp;
  const published: PublishedRelease[] = [];
  try {
    checkFresh(evidence.header, runAt);
    const read = registryWords(evidence.header, evidence.nodes, pin);
    const count = releaseCount(read);
    // Each sequence needs its own proven words, so the loop is bounded by
    // the evidence: a sequence without them stops it (T-52).
    for (let s = 0n; s < count; s++) published.push(releaseAt(read, s, now));
  } catch (e) {
    if (!(e instanceof RegistryError)) throw e;
    const at: Record<string, string> = {};
    if ("slot" in e.at) at["slot"] = e.at.slot;
    if ("sequence" in e.at) at["sequence"] = e.at.sequence.toString();
    return report({
      status: registryCodeFails(e.code) ? "fail" : "unverifiable",
      code: e.code,
      at,
    });
  }
  // registryWords returned, so the pin is defined.
  const registry = pin as ReleaseRegistryPin;

  // Step 4.
  const rows: KeysReleaseRow[] = [];
  const step4: Step4[] = [];
  for (const [i, r] of published.entries()) {
    const found: { deploymentHash?: string; version?: string } = {};
    const previous = i === 0 ? new Uint8Array(32) : (published[i - 1] as PublishedRelease).hash;
    const s4 = findDeployment(r, previous, registry, evidence, found);
    step4.push(s4);
    rows.push({
      sequence: r.sequence.toString(),
      hash: bytesToHex(r.hash),
      publishedAt: r.publishedAt.toString(),
      ...(r.revokedAt !== 0n && { revokedAt: r.revokedAt.toString() }),
      ...found,
      outcome: s4.resolved ? "resolved" : s4.code,
    });
  }
  const listing: [number, DeploymentRecordV2, Uint8Array][] = [];
  for (const [s, x] of step4.entries())
    if (x.resolved && x.deployment.version === 2) listing.push([s, x.deployment.value, x.hash]);

  // Step 5: by the later release, then the earlier; within one registry the
  // lower sequence was published first.
  const findings: KeysFinding[] = [];
  for (const [j, later, laterHash] of listing)
    for (const [i, earlier, earlierHash] of listing) {
      if (i >= j) break;
      // One record judged against itself, which a well-formed one never breaks.
      if (equal(earlierHash, laterHash)) continue;
      const broken = deploymentAcrossRule(earlier, later);
      if (broken !== undefined)
        findings.push({
          code: broken.rule,
          at: { earlier: String(i), later: String(j), period: String(broken.period) },
        });
    }

  // Step 6.
  const first = new Map<number, [number, { key: Uint8Array; retired: boolean }]>();
  const retiredFrom = new Map<number, number>();
  for (const [s, d] of listing)
    for (const k of d.tier0_token_keys) {
      if (!first.has(k.period)) first.set(k.period, [s, k]);
      if (k.retired && !retiredFrom.has(k.period)) retiredFrom.set(k.period, s);
    }
  const firstUnresolved = step4.findIndex((x) => !x.resolved);
  // The first version-2 release lists its own period and the one before,
  // which no earlier release could list.
  const s0 = listing[0];
  const floor0 = s0 === undefined ? 0n : (published[s0[0]] as PublishedRelease).publishedAt / P;
  const periods: KeysPeriodRow[] = [];
  for (const q of [...first.keys()].sort((a, b) => a - b)) {
    const [s, k] = first.get(q) as [number, { key: Uint8Array; retired: boolean }];
    const retired = retiredFrom.get(q);
    periods.push({
      period: String(q),
      key: bytesToHex(k.key),
      firstListed: String(s),
      ...(retired !== undefined && { retiredFrom: String(retired) }),
    });
    const late =
      (published[s] as PublishedRelease).publishedAt >= P * BigInt(q) &&
      BigInt(q) > floor0 &&
      !k.retired;
    // A release below that isn't resolved might list q earlier.
    if (late && (firstUnresolved < 0 || firstUnresolved > s))
      findings.push({ code: "token-key-late", at: { sequence: String(s), period: String(q) } });
  }

  // Step 7.
  const unresolved = step4.filter((x): x is Unresolved => !x.resolved);
  const failing = unresolved.find((x) => x.fails);
  const unsettled = unresolved.find((x) => !x.fails);
  const finding = findings[0];
  let result: KeysResult = { status: "pass" };
  if (failing !== undefined) result = { status: "fail", code: failing.code, at: failing.at };
  else if (finding !== undefined) result = { status: "fail", ...finding };
  else if (unsettled !== undefined)
    result = { status: "unverifiable", code: unsettled.code, at: unsettled.at };
  return report(result, {
    releases: rows,
    periods,
    findings: findings.slice(0, MAX_KEYS_FINDINGS),
    ...(findings.length > MAX_KEYS_FINDINGS && { findingsTruncated: true as const }),
  });
}

/** The summary written to stderr (docs/spec/verifier.md, Command line). */
export function keysSummary(report: KeysReport): string {
  const lines = [
    `verdict: ${report.verdict} (unauthenticated inputs: l1Header; ` +
      `against those inputs: ${report.verdictAgainstInputs})`,
  ];
  if (report.releases !== undefined)
    lines.push(`${report.releases.length} releases, ${report.periods?.length ?? 0} periods listed`);
  for (const f of report.findings ?? []) lines.push(`  ${f.code} ${JSON.stringify(f.at)}`);
  if (report.result.status !== "pass")
    lines.push(
      `  keys ${report.result.status} ${report.result.code} ${JSON.stringify(report.result.at)}`,
    );
  return lines.join("\n") + "\n";
}
