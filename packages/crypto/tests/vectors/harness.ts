// Published-vector harness (AGENTS.md "Testing"): vendored files under
// test-vectors/ are byte-for-byte copies of published vectors, each recorded
// in manifest.json with its source URL and sha256. Every read checks the
// sha256 first, with node:crypto rather than the @noble code under test. That
// binds each file to its manifest entry; CI's `vectors-provenance` step binds
// the entry to its source by re-fetching the commit-pinned URL (T-55).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const VECTORS_ROOT = new URL("../../test-vectors/", import.meta.url);

export interface VendoredFile {
  readonly path: string;
  readonly sha256: string;
  readonly source: string;
  readonly origin: string;
  readonly originUrl: string;
  readonly license: string;
  readonly retrieved: string;
  readonly covers: string;
}

const MANIFEST_FORMAT = "abolish-test-vectors-manifest/1";
const FIELDS = [
  "path",
  "sha256",
  "source",
  "origin",
  "originUrl",
  "license",
  "retrieved",
  "covers",
] as const;
// One directory per publisher, then the file name as published. No "..", no
// absolute paths, nothing outside test-vectors/.
const PATH = /^[a-z0-9-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Parses and validates manifest.json; any deviation throws. */
export function readManifest(root: URL = VECTORS_ROOT): VendoredFile[] {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as unknown;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("manifest.json: not an object");
  const { format, files } = manifest as Record<string, unknown>;
  if (format !== MANIFEST_FORMAT)
    throw new Error(`manifest.json: format must be ${MANIFEST_FORMAT}`);
  if (!Array.isArray(files)) throw new Error("manifest.json: files must be an array");
  const seen = new Set<string>();
  return files.map((entry: unknown, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const keys = Object.keys(e).sort();
    if (keys.join() !== [...FIELDS].sort().join())
      throw new Error(
        `manifest.json: files[${i}] must have exactly the fields ${FIELDS.join(", ")}`,
      );
    for (const field of FIELDS) {
      if (typeof e[field] !== "string" || e[field] === "")
        throw new Error(`manifest.json: files[${i}].${field} must be a non-empty string`);
    }
    const file = e as unknown as VendoredFile;
    if (!PATH.test(file.path)) throw new Error(`manifest.json: bad path ${file.path}`);
    if (!SHA256.test(file.sha256)) throw new Error(`manifest.json: bad sha256 for ${file.path}`);
    if (!file.source.startsWith("https://"))
      throw new Error(`manifest.json: source of ${file.path} must be an https URL`);
    if (seen.has(file.path)) throw new Error(`manifest.json: ${file.path} listed twice`);
    seen.add(file.path);
    return file;
  });
}

/** The bytes of a vendored file, only if they match the manifest's sha256. */
export function readVendored(path: string, root: URL = VECTORS_ROOT): Buffer {
  const entry = readManifest(root).find((f) => f.path === path);
  if (entry === undefined) throw new Error(`${path}: not listed in manifest.json`);
  const bytes = readFileSync(new URL(path, root));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256)
    throw new Error(`${path}: sha256 ${actual} does not match manifest.json (${entry.sha256})`);
  return bytes;
}

/** One record of a NIST CAVP response file, with the bracketed parameters in force. */
export interface RspRecord {
  readonly params: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Strict parser for NIST CAVP `.rsp` files: `#` comment lines, `[name = value]`
 * parameter lines, and `name = value` fields grouped into records by blank
 * lines. Anything else, or a field repeated within a record, throws: a
 * misparse must fail loudly rather than silently drop vectors.
 */
export function parseRsp(text: string): RspRecord[] {
  const records: RspRecord[] = [];
  let params: Record<string, string> = {};
  let fields: Record<string, string> | undefined;
  const flush = () => {
    if (fields !== undefined) records.push({ params, fields });
    fields = undefined;
  };
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.startsWith("#")) return;
    if (line.trim() === "") {
      flush();
      return;
    }
    const param = /^\[([A-Za-z0-9]+) = ([^\]]*)\]$/.exec(line);
    if (param !== null) {
      flush();
      params = { ...params, [param[1] ?? ""]: param[2] ?? "" };
      return;
    }
    const field = /^([A-Za-z0-9]+) = (\S*)$/.exec(line);
    if (field === null) throw new Error(`rsp line ${i + 1}: unrecognised: ${JSON.stringify(line)}`);
    const [, name = "", value = ""] = field;
    fields ??= {};
    if (name in fields) throw new Error(`rsp line ${i + 1}: ${name} repeated in one record`);
    fields[name] = value;
  });
  flush();
  return records;
}
