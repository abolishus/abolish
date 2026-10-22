// The release record (docs/spec/release.md, record type 0x001f): what a
// ballot-client release serves, as one record, its strict decoding, its
// well-formedness rules and the release hash the L1 release registry holds.
// The registry makes a release public before any check passes it (T-41,
// T-69); this module fixes what that hash commits to, so every reader reads
// one record the same way (T-31). The rules check only what the record says
// about itself: that its files are its directory, and that its sequence and
// previous agree with the registry, are the verifier's (T-43).

import { bool, bytesFixed, bytesVar, type CodecValue, enum8, list, struct, u64 } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { type DecodedRecord, RECORD_TYPES, RecordSchema, recordType, UNPINNED } from "./record.ts";

/** The record's bounds (docs/spec/release.md, Record and Well-formedness). */
export const RELEASE_LIMITS = Object.freeze({
  sites: 2,
  origins: 8,
  origin: 267,
  headers: 16,
  headerName: 64,
  headerValue: 4096,
  files: 1024,
  path: 1024,
  pathSegments: 16,
  pathSegment: 128,
  mediaType: 127,
  // MAX_RELEASE_FILE: 2²⁸ bytes, 256 MiB.
  file: 2n ** 28n,
} as const);

/** `site`'s `kind`. */
export const SITE_KINDS = Object.freeze({ ballot: 1, challenge: 2 } as const);

const header = struct([
  ["name", bytesVar(RELEASE_LIMITS.headerName)],
  ["value", bytesVar(RELEASE_LIMITS.headerValue)],
] as const);

const file = struct([
  ["path", bytesVar(RELEASE_LIMITS.path)],
  ["length", u64],
  ["sha256", bytesFixed(32)],
  ["media_type", bytesVar(RELEASE_LIMITS.mediaType)],
] as const);

const site = struct([
  ["kind", enum8([SITE_KINDS.ballot, SITE_KINDS.challenge])],
  ["origins", list(bytesVar(RELEASE_LIMITS.origin), RELEASE_LIMITS.origins)],
  ["loopback", bool],
  ["headers", list(header, RELEASE_LIMITS.headers)],
  ["files", list(file, RELEASE_LIMITS.files)],
  ["directory", bytesFixed(36)],
] as const);

const releaseV1 = struct([
  ["l1_chain_id", u64],
  ["registry", bytesFixed(20)],
  ["sequence", u64],
  ["previous", bytesFixed(32)],
  ["source_commit", bytesFixed(20)],
  ["deployment_hash", bytesFixed(32)],
  ["sites", list(site, RELEASE_LIMITS.sites)],
] as const);

export type ReleaseRecord = CodecValue<typeof releaseV1>;
export type ReleaseSite = CodecValue<typeof site>;
export type ReleaseHeader = CodecValue<typeof header>;
export type ReleaseFile = CodecValue<typeof file>;

/** Record type `0x001f`, version 1. Never on the board, and no profile pins it. */
export const RELEASE_RECORD = recordType(RECORD_TYPES.releaseRecord, { 1: releaseV1 });

export type DecodedReleaseRecord = DecodedRecord<(typeof RELEASE_RECORD)["versions"]>;

// 0x001f is the only type this decoder knows, so any other is
// `unknown-record-type`, a deployment record's included (Decoding).
const SCHEMA = new RecordSchema([RELEASE_RECORD]);

export function encodeReleaseRecord(record: DecodedReleaseRecord): Uint8Array {
  return SCHEMA.encode(RELEASE_RECORD, 1, record.value);
}

/**
 * Strictly decodes a release record. A release belongs to no election, so no
 * profile pins its version and `profile-mismatch` never applies (Decoding):
 * any version but 1 is `unknown-version`. Each length and count is checked
 * against its maximum before what it describes is read (T-52).
 */
export function decodeReleaseRecord(bytes: Uint8Array): DecodedReleaseRecord {
  return SCHEMA.decode(RELEASE_RECORD, bytes, UNPINNED);
}

/**
 * `release_hash = H(DS("abolish/v1/release", encode(record)))`, over the
 * whole encoding, header included (Release hash): what the registry holds and
 * `previous` chains. `encoding` is hashed as given: pass only bytes
 * `decodeReleaseRecord` accepted, so the hash is always of some record's one
 * encoding (T-31).
 */
export function releaseHash(encoding: Uint8Array): Uint8Array {
  if (!(encoding instanceof Uint8Array)) throw new TypeError("releaseHash: encoding must be bytes");
  return H(ds("abolish/v1/release", encoding));
}

/** Each site's rules, in checking order. */
export const RELEASE_SITE_RULES = Object.freeze([
  "origin",
  "origin-order",
  "site-unreachable",
  "loopback-site",
  "challenge-origin",
  "header-name",
  "header-reserved",
  "header-value",
  "header-order",
  "site-csp",
  "path",
  "path-reserved",
  "path-order",
  "path-conflict",
  "site-index",
  "empty-file",
  "file-too-large",
  "media-type",
  "directory-cid",
] as const);

/** Every well-formedness code, in checking order. */
export const RELEASE_RULES = Object.freeze([
  "release-chain",
  "site-order",
  "site-ballot",
  ...RELEASE_SITE_RULES,
  "origin-shared",
] as const);

export type ReleaseSiteRule = (typeof RELEASE_SITE_RULES)[number];

/** The first rule a record breaks; a site's rule names the site by its index in `sites`. */
export type ReleaseFailure =
  | { readonly rule: ReleaseSiteRule; readonly site: number }
  | { readonly rule: "release-chain" | "site-order" | "site-ballot" | "origin-shared" };

/**
 * The first well-formedness rule a decoded record breaks (docs/spec/
 * release.md, Well-formedness), or `undefined` if it is well formed: the
 * record's rules, then each site's in list order, all of one site's before
 * the next's, then `origin-shared`.
 */
export function releaseRecordRule(record: DecodedReleaseRecord): ReleaseFailure | undefined {
  const r = record.value;
  if ((r.sequence === 0n) !== isZero(r.previous)) return { rule: "release-chain" };
  if (!r.sites.every((s, i) => i === 0 || s.kind > (r.sites[i - 1] as ReleaseSite).kind))
    return { rule: "site-order" };
  // Ascending, so the ballot client is first if it is there at all.
  if (r.sites[0]?.kind !== SITE_KINDS.ballot) return { rule: "site-ballot" };
  for (const [i, s] of r.sites.entries()) {
    const rule = siteRule(s);
    if (rule !== undefined) return { rule, site: i };
  }
  // The challenge page's origin is never one of the client's (registration.md,
  // Challenge page). Each site's origins are distinct by `origin-order`.
  const [a, b] = r.sites;
  if (a !== undefined && b !== undefined && !distinct([...a.origins, ...b.origins]))
    return { rule: "origin-shared" };
  return undefined;
}

// Headers that describe a transfer, not the bytes, or that each file sets for
// itself; HTTP/2 and HTTP/3 forbid the connection-specific ones.
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "keep-alive",
  "proxy-connection",
  "te",
  "transfer-encoding",
  "upgrade",
]);

// IPFS gateways and some static hosts read a root file of these names as
// rules rather than serving it.
const RESERVED_PATHS: ReadonlySet<string> = new Set(["_redirects", "_headers"]);

// RFC 9110's tchar, in lower case.
const HEADER_NAME = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
// RFC 6838's restricted names, in lower case.
const MEDIA_PART = /^[a-z0-9][a-z0-9!#$&\-^_.+]*$/;
const CHARSET = "; charset=utf-8";
const DIRECTORY_PREFIX = [0x01, 0x70, 0x12, 0x20] as const;

function siteRule(s: ReleaseSite): ReleaseSiteRule | undefined {
  if (!s.origins.every(isOrigin)) return "origin";
  if (!ascending(s.origins)) return "origin-order";
  if (s.origins.length === 0 && !s.loopback) return "site-unreachable";
  // The challenge page's Turnstile site key is issued for its one origin.
  if (s.loopback && s.kind !== SITE_KINDS.ballot) return "loopback-site";
  if (s.kind === SITE_KINDS.challenge && s.origins.length !== 1) return "challenge-origin";
  const names = s.headers.map((h) => ascii(h.name));
  if (!names.every((n) => n !== undefined && HEADER_NAME.test(n))) return "header-name";
  if (names.some((n) => RESERVED_HEADERS.has(n as string))) return "header-reserved";
  if (!s.headers.every((h) => isHeaderValue(h.value))) return "header-value";
  if (!ascending(s.headers.map((h) => h.name))) return "header-order";
  // T-43: a <meta> policy can't set frame-ancestors, and a worker takes its
  // policy only from its own response.
  if (!names.includes("content-security-policy")) return "site-csp";
  const paths = s.files.map((f) => ascii(f.path));
  if (!paths.every((p) => p !== undefined && isPath(p))) return "path";
  // Every path is ASCII from here on.
  const listed = paths as string[];
  if (listed.some((p) => RESERVED_PATHS.has(p))) return "path-reserved";
  if (!ascending(s.files.map((f) => f.path))) return "path-order";
  if (hasConflict(listed)) return "path-conflict";
  if (!listed.includes("index.html")) return "site-index";
  if (s.files.some((f) => f.length === 0n)) return "empty-file";
  if (s.files.some((f) => f.length > RELEASE_LIMITS.file)) return "file-too-large";
  if (!s.files.every((f) => isMediaType(f.media_type))) return "media-type";
  if (!DIRECTORY_PREFIX.every((x, i) => s.directory[i] === x)) return "directory-cid";
  return undefined;
}

function isHeaderValue(v: Uint8Array): boolean {
  return (
    v.length > 0 &&
    v.every((x) => x >= 0x20 && x <= 0x7e) &&
    v[0] !== 0x20 &&
    v[v.length - 1] !== 0x20
  );
}

function isPath(p: string): boolean {
  const segments = p.split("/");
  return (
    segments.length <= RELEASE_LIMITS.pathSegments &&
    segments.every((x) => SEGMENT.test(x) && x !== "." && x !== "..")
  );
}

// Whether some path is a directory of another: some path starts with another
// followed by "/". Each path's own prefixes ending before a "/" are looked up,
// so a site at its maximums costs 16 lookups a path rather than a pair scan.
function hasConflict(paths: readonly string[]): boolean {
  const all = new Set(paths);
  return paths.some((p) => {
    for (let at = p.indexOf("/"); at >= 0; at = p.indexOf("/", at + 1))
      if (all.has(p.slice(0, at))) return true;
    return false;
  });
}

function isMediaType(b: Uint8Array): boolean {
  const m = ascii(b);
  if (m === undefined) return false;
  const base = m.endsWith(CHARSET) ? m.slice(0, -CHARSET.length) : m;
  const slash = base.indexOf("/");
  return (
    slash >= 0 && MEDIA_PART.test(base.slice(0, slash)) && MEDIA_PART.test(base.slice(slash + 1))
  );
}

// The origin grammar (Well-formedness), which [[deployment]] shares:
// "https://" host [":" port], a lower-case A-label host of at least two
// labels whose last label starts with a letter (so no IPv4 address is one),
// and a port from 1 to 65535 other than 443, with no leading zero. Each
// origin has one listing, equal as bytes to what a browser reports (T-31,
// T-43).
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^[1-9][0-9]{0,4}$/;
export const ORIGIN_PREFIX = "https://";

export function ascii(b: Uint8Array): string | undefined {
  return b.every((x) => x < 0x80) ? String.fromCharCode(...b) : undefined;
}

function isHostText(host: string): boolean {
  if (host.length < 1 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  const last = labels[labels.length - 1] as string;
  return last[0] !== undefined && last[0] >= "a" && last[0] <= "z";
}

/** Whether `b` is an origin by the grammar of docs/spec/release.md (Well-formedness). */
export function isOrigin(b: Uint8Array): boolean {
  const s = ascii(b);
  if (s === undefined || !s.startsWith(ORIGIN_PREFIX)) return false;
  const rest = s.slice(ORIGIN_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    const port = rest.slice(colon + 1);
    if (!PORT.test(port) || Number(port) > 65535 || port === "443") return false;
  }
  return isHostText(colon >= 0 ? rest.slice(0, colon) : rest);
}

/** Whether `b` is an origin's host by the same grammar, with nothing after it (an RP ID). */
export function isHost(b: Uint8Array): boolean {
  const s = ascii(b);
  return s !== undefined && !s.includes(":") && isHostText(s);
}

export function isZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && compareBytes(a, b) === 0;

/** Strictly ascending in byte order, so no entry appears twice. */
export function ascending(xs: readonly Uint8Array[]): boolean {
  return xs.every((x, i) => i === 0 || compareBytes(xs[i - 1] as Uint8Array, x) < 0);
}

export function distinct(xs: readonly Uint8Array[]): boolean {
  return xs.every((x, i) => !xs.slice(0, i).some((y) => sameBytes(x, y)));
}
