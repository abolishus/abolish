// Every third-party GitHub Action and every container image a workflow runs
// must be pinned immutably: actions to a full commit SHA (with the human-readable
// tag in a trailing comment), images to a sha256 digest. Tags and branches are
// mutable; a compromised upstream could otherwise run arbitrary code with our
// secrets.
//
// The files are parsed as YAML and every `uses`, `container` and service
// `image` value is checked wherever it appears, so equivalent spellings (flow
// mappings, quoted keys, `uses :`) cannot hide a step. Anything that does not
// parse cleanly is itself a violation. Local actions must live under
// `./.github/` so that everything they reference is scanned too, and covered by
// CODEOWNERS.

import { isMap, isScalar, isSeq, parseAllDocuments, type Node } from "yaml";

export interface PinViolation {
  readonly file: string;
  /** Dotted path to the offending value, e.g. "jobs.test.steps.2.uses". */
  readonly path: string;
  readonly value: string;
  readonly reason: string;
}

const SHA_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const LOCAL = /^\.\/\.github\/\S+$/;
const VERSION_COMMENT = /#\s*v?\d/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findUnpinned(file: string, source: string): PinViolation[] {
  const out: PinViolation[] = [];
  const add = (path: string, value: string, reason: string) =>
    out.push({ file, path, value, reason });

  const docs = parseAllDocuments(source, { uniqueKeys: true });
  if (!Array.isArray(docs)) {
    add("", "", "not a YAML stream");
    return out;
  }
  if (docs.length !== 1) add("", "", `expected exactly one YAML document, found ${docs.length}`);
  for (const doc of docs) {
    for (const e of [...doc.errors, ...doc.warnings]) add("", "", `YAML: ${e.message}`);
  }
  if (out.length > 0) return out;

  const lines = source.split("\n");
  const checkUses = (path: string, value: string) => {
    if (value.startsWith("./")) {
      if (!LOCAL.test(value) || value.split("/").includes(".."))
        add(path, value, "local actions must live under ./.github/");
      return;
    }
    if (value.startsWith("docker://")) {
      if (!DIGEST.test(value)) add(path, value, "docker image must be pinned by sha256 digest");
      return;
    }
    if (!SHA_REF.test(value)) {
      add(path, value, "action must be pinned to a 40-character commit SHA");
      return;
    }
    const withComment = new RegExp(`${escapeRegExp(value)}['"]?\\s*(#.*)$`);
    const commented = lines.some((l) => VERSION_COMMENT.test(withComment.exec(l)?.[1] ?? ""));
    if (!commented) add(path, value, "pinned action needs a trailing '# vX.Y.Z' comment");
  };
  const checkImage = (path: string, value: string) => {
    if (!DIGEST.test(value)) add(path, value, "container image must be pinned by sha256 digest");
  };

  const visit = (node: Node | null | undefined, path: string[]) => {
    if (node === null || node === undefined) return;
    if (isSeq(node)) {
      node.items.forEach((item, i) => visit(item as Node, [...path, String(i)]));
      return;
    }
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const keyNode = pair.key as Node | null;
      const key = isScalar(keyNode) ? String(keyNode.value) : undefined;
      const valueNode = pair.value as Node | null;
      const here = [...path, key ?? "?"];
      const where = here.join(".");
      if (key === undefined) {
        add(where, "", "non-scalar mapping key");
        continue;
      }
      const scalar = isScalar(valueNode) ? valueNode.value : undefined;
      const parent = path[path.length - 1];
      const grandparent = path[path.length - 2];
      if (key === "uses") {
        if (typeof scalar !== "string") add(where, String(scalar), "uses must be a plain string");
        else checkUses(where, scalar);
      } else if (key === "container" && typeof scalar === "string") {
        checkImage(where, scalar);
      } else if (
        key === "image" &&
        (parent === "container" || grandparent === "services" || parent === "runs")
      ) {
        // runs.image: docker container actions ("Dockerfile" is local and reviewed).
        if (typeof scalar !== "string") add(where, String(scalar), "image must be a plain string");
        else if (!(parent === "runs" && scalar === "Dockerfile")) checkImage(where, scalar);
      }
      visit(valueNode, here);
    }
  };
  for (const doc of docs) visit(doc.contents as Node, []);
  return out;
}
