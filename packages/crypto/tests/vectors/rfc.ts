// Strict parsers for the test-vector appendices of the vendored RFC texts
// (test-vectors/rfc/). Each takes the text between two headings and throws on
// any line it doesn't recognise, so a misparse fails instead of dropping
// vectors; the tests also assert how many vectors each parser returned.

import { readVendored } from "./harness.ts";

/** The text of `rfc/<name>.txt` between the line `from` and the line `to`. */
export function rfcSection(name: string, from: string, to: string): string[] {
  const lines = readVendored(`rfc/${name}.txt`).toString("ascii").split("\n");
  const start = lines.indexOf(from);
  const end = lines.indexOf(to, start + 1);
  if (start === -1 || end === -1) throw new Error(`${name}: no section ${from} … ${to}`);
  return lines.slice(start + 1, end);
}

const HEX_GROUPS = /^ {3,}((?:[0-9a-f]{2})+(?: (?:[0-9a-f]{2})+)*)$/;

/** RFC 9496 A.1: the `B[ k]: <hex>` entries, with continuation lines, in order. */
export function parseMultiples(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const entry = /^ {3}B\[ ?(\d+)\]: ((?:[0-9a-f]{8} ?)+)$/.exec(line);
    if (entry !== null) {
      if (Number(entry[1]) !== out.length) throw new Error(`out of order: ${line}`);
      out.push((entry[2] ?? "").replaceAll(" ", ""));
      continue;
    }
    const more = /^ {10}((?:[0-9a-f]{8} ?)+)$/.exec(line);
    if (more !== null && out.length > 0) {
      out[out.length - 1] += (more[1] ?? "").replaceAll(" ", "");
      continue;
    }
    // The list ends at the first other line after it starts; the caller
    // checks the count, so an entry the patterns miss fails there.
    if (out.length > 0 && line.trim() !== "") break;
  }
  return out;
}

/**
 * RFC 9496 A.2: hex blocks separated by blank lines; `#` lines name the class
 * of the blocks that follow. Prose lines are skipped only before the first
 * class heading.
 */
export function parseInvalidEncodings(
  lines: readonly string[],
): { readonly kind: string; readonly hex: string }[] {
  const out: { kind: string; hex: string }[] = [];
  let kind: string | undefined;
  let current = "";
  const flush = () => {
    if (current === "") return;
    if (kind === undefined) throw new Error("encoding before any class heading");
    out.push({ kind, hex: current });
    current = "";
  };
  for (const line of lines) {
    const heading = /^ {3}# (.+)$/.exec(line);
    if (heading !== null) {
      flush();
      kind = heading[1] ?? "";
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const hex = HEX_GROUPS.exec(line);
    if (hex !== null && kind !== undefined) {
      current += (hex[1] ?? "").replaceAll(" ", "");
      continue;
    }
    if (kind !== undefined) throw new Error(`unrecognised: ${line}`);
  }
  flush();
  return out;
}

/**
 * `name: value` (RFC 9496 A.3) or `name = value` (RFC 9380, RFC 9497) fields,
 * with values continued on following lines: indented deeper than a field, or
 * by the same three spaces when the line is one token. Spaces inside a value
 * are dropped (they group hex digits). Returns the fields in order, so callers
 * group them.
 */
export function parseFields(
  lines: readonly string[],
  separator: ":" | "=",
): { readonly name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const field = separator === ":" ? /^ {3}([A-Za-z_]+): ?(.*)$/ : /^ {3}([A-Za-z_]+) *= ?(.*)$/;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const f = field.exec(line);
    if (f !== null) {
      out.push({ name: f[1] ?? "", value: (f[2] ?? "").replaceAll(" ", "") });
      continue;
    }
    const last = out.at(-1);
    if (last !== undefined && (/^ {4,}\S/.test(line) || /^ {3}\S+$/.test(line))) {
      last.value += line.replaceAll(" ", "");
      continue;
    }
    // Prose (several words at the field indent) and subsection headings.
    if (/^ {3}\S+ /.test(line) || /^[A-Z]\.[\d.]+ {2}/.test(line)) continue;
    throw new Error(`unrecognised: ${JSON.stringify(line)}`);
  }
  return out;
}
