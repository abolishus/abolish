import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { DecodeError, ds, H, PanelError, panelId, UNPINNED } from "../src/index.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/deployment-record.json, printed by
// scripts/deployment-record-vectors.py (P4-4 part 2b-3). Until the deployment
// record's codec and rules are in this package (part 2c), the file's own
// type descriptors decode each vector, so this checks the file against
// itself and the spec's framing: every vector round-trips under its
// deployment hash, its panels are the ones this package's panel check
// accepts or refuses, and every pair's release names its deployment's hash
// exactly when the pair passes that rule (T-31, T-36, T-37, T-41).
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type DeploymentVector = Vector & {
  readonly deploymentHash?: string;
  readonly illFormedAt?: Readonly<Record<string, string>>;
};

interface Pair {
  readonly id: string;
  readonly release: string;
  readonly deployment: string;
  readonly inconsistent?: string;
}

type DeploymentFile = Omit<VectorFile, "vectors"> & {
  readonly tag: string;
  readonly maxSequencerDrift: string;
  readonly largestEncoding: number;
  readonly rules: readonly string[];
  readonly pairRules: readonly string[];
  readonly vectors: readonly DeploymentVector[];
  readonly pairs: readonly Pair[];
};

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;

const file = read<DeploymentFile>("deployment-record.json");
const releaseFile = read<VectorFile>("release-record.json");
const page = readFileSync(new URL("../deployment.md", SPEC_VECTORS), "utf8");

// The codes of a table in docs/spec/deployment.md, top to bottom.
function codes(from: string, to: string): string[] {
  const section = page.slice(page.indexOf(`\n## ${from}\n`), page.indexOf(`\n## ${to}\n`));
  return [...section.matchAll(/^\| `([a-z0-9-]+)` +\|/gm)].map((m) => m[1] ?? "");
}

// The spec's way of writing a type descriptor, as its Record tables do.
type Descriptor = {
  readonly kind: string;
  readonly length?: number;
  readonly max?: number;
  readonly values?: readonly string[];
  readonly of?: Descriptor;
  readonly name?: string;
  readonly fields?: readonly { readonly name: string; readonly type: Descriptor }[];
};

function spelled(t: Descriptor): string {
  switch (t.kind) {
    case "bytes":
      return t.length === undefined ? `bytes<${t.max}>` : `bytes[${t.length}]`;
    case "enum8":
      return `enum8<${(t.values ?? []).join(", ")}>`;
    case "list":
      return `list<${t.of === undefined ? "?" : spelled(t.of)}, ${t.max}>`;
    case "ref":
      return t.name ?? "?";
    case "struct":
      return "seat";
    default:
      return t.kind;
  }
}

// Each table of the spec's Record section, as [field, type] rows.
function recordTables(): string[][][] {
  const section = page.slice(page.indexOf("\n## Record\n"), page.indexOf("\n## Well-formedness\n"));
  return section
    .split(/\n\s*\n/)
    .map((block) =>
      [...block.matchAll(/^\| `([a-z0-9_]+)` +\| `([^`]+)` +\|/gm)].map((m) => [
        m[1] ?? "",
        m[2] ?? "",
      ]),
    )
    .filter((rows) => rows.length > 0);
}

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

function panelError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof PanelError) return e.code;
    throw e;
  }
  return undefined;
}

interface DecodedDeployment {
  readonly initial_panel: Uint8Array;
  readonly panels: readonly {
    readonly threshold: number;
    readonly seats: readonly { readonly key: Uint8Array }[];
  }[];
}

const panelOf = (p: DecodedDeployment["panels"][number]) => ({
  threshold: p.threshold,
  keys: p.seats.map((s) => s.key),
});

describe("deployment record (docs/spec/deployment.md)", () => {
  const { schema, type } = buildSchema(file);
  const deployment = type({ kind: "ref", name: "deployment" });
  const release = buildSchema(releaseFile);
  const releaseType = release.type({ kind: "ref", name: "release" });
  const decodeDeployment = (encoding: string) =>
    schema.decode(deployment.recordType, hex(encoding), UNPINNED).value as DecodedDeployment;

  test("has its format, tag and bounds, and exactly one of value or error on each vector", () => {
    expect(file.format).toBe("abolish-deployment-record-vectors/1");
    expect(file.tag).toBe("abolish/v1/deployment");
    expect(file.maxSequencerDrift).toBe("1800");
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    expect(new Set(file.pairs.map((p) => p.id)).size).toBe(file.pairs.length);
    for (const v of file.vectors) {
      expect("value" in v !== "error" in v, v.id).toBe(true);
      expect("value" in v === "deploymentHash" in v, v.id).toBe(true);
    }
  });

  test("has the spec's layout: every table's fields and types, and its largest encoding", () => {
    type Named = Readonly<Record<string, Descriptor>>;
    const types = file.types as unknown as Named;
    const rows = (t: Descriptor | undefined) =>
      (t?.fields ?? []).map((f) => [f.name, spelled(f.type)]);
    const seat = types["panel"]?.fields?.find((f) => f.name === "seats")?.type.of;
    expect(recordTables()).toEqual([
      rows(types["deployment"]),
      rows(types["panel"]),
      rows(seat),
      rows(types["group"]),
    ]);
    expect(page).toContain(
      `At its maximums a version-1 record is ${file.largestEncoding.toLocaleString("en")} bytes.`,
    );
    expect(Math.max(...decoded.map(([, v]) => hex(v.encoding).length))).toBe(file.largestEncoding);
  });

  test("lists the spec's rules, in its order, each with a vector that breaks it", () => {
    expect(codes("Well-formedness", "Deployment hash")).toEqual(file.rules);
    expect(codes("Against its release", "Test vectors")).toEqual(file.pairRules);
    expect(
      new Set(file.vectors.flatMap((v) => (v.illFormed === undefined ? [] : [v.illFormed]))),
    ).toEqual(new Set(file.rules));
    expect(
      new Set(file.pairs.flatMap((p) => (p.inconsistent === undefined ? [] : [p.inconsistent]))),
    ).toEqual(new Set(file.pairRules));
  });

  const decoded = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const rejected = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(decoded)("%s decodes to its value and back, under its deployment hash", (_id, v) => {
    const bytes = hex(v.encoding);
    const expected = deployment.built.fromJson(v.value);
    expect(schema.decode(deployment.recordType, bytes, UNPINNED)).toEqual({
      version: 1,
      value: expected,
    });
    expect(toHex(schema.encode(deployment.recordType, 1, expected))).toBe(v.encoding);
    expect(toHex(H(ds("abolish/v1/deployment", bytes)))).toBe(v.deploymentHash);
  });

  test.each(rejected)("%s is rejected", (_id, v) => {
    expect(decodeError(() => schema.decode(deployment.recordType, hex(v.encoding), UNPINNED))).toBe(
      v.error,
    );
  });

  // The panel rules are trustee-identity.md's, which this package already
  // implements: each well-formed record's panels pass its check in
  // ascending panel_id with the initial panel among them, and each panel
  // rule's vector is refused there with the matching code.
  test.each(decoded.filter(([, v]) => v.illFormed === undefined))(
    "%s pins valid panels in panel_id order, the initial one among them",
    (_id, v) => {
      const d = decodeDeployment(v.encoding);
      const ids = d.panels.map((p) => toHex(panelId(panelOf(p))));
      expect(ids).toEqual([...new Set(ids)].sort());
      expect(ids).toContain(toHex(d.initial_panel));
    },
  );

  const panelCodes: Readonly<Record<string, string>> = {
    "panel-threshold": "threshold",
    "panel-key": "key",
    "panel-duplicate-key": "duplicate-key",
  };
  test.each(decoded.filter(([, v]) => v.illFormed !== undefined && v.illFormed in panelCodes))(
    "%s has a panel this package refuses with the same rule",
    (_id, v) => {
      const d = decodeDeployment(v.encoding);
      const at = Number(v.illFormedAt?.["panel"]);
      const p = d.panels[at];
      if (p === undefined) throw new Error(`no panel ${at}`);
      expect(panelError(() => panelId(panelOf(p)))).toBe(panelCodes[v.illFormed ?? ""]);
      for (const earlier of d.panels.slice(0, at))
        expect(() => panelId(panelOf(earlier))).not.toThrow();
    },
  );

  test.each(file.pairs.map((p) => [p.id, p] as const))(
    "%s: the release names its deployment's hash unless the pair breaks deployment-hash",
    (_id, p) => {
      const deploymentBytes = hex(p.deployment);
      schema.decode(deployment.recordType, deploymentBytes, UNPINNED);
      const r = release.schema.decode(releaseType.recordType, hex(p.release), UNPINNED).value as {
        readonly deployment_hash: Uint8Array;
      };
      const named =
        toHex(r.deployment_hash) === toHex(H(ds("abolish/v1/deployment", deploymentBytes)));
      expect(named).toBe(p.inconsistent !== "deployment-hash");
    },
  );
});
