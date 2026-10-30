// The relay's configuration (README, Configuration): where it listens, and
// for each resource it serves, the one node it carries that resource's
// requests to (docs/spec/sealed-delivery.md, The relay). JSON at a transport
// boundary, so it is parsed with a strict schema. A resource's path is
// spelled as the deployment record lists it ([[deployment]], `relay`, by
// [[release]]'s path grammar), so the client's exact bytes reach it (T-31).
import { z } from "zod";

/** Thrown for a configuration the relay refuses; its message never quotes a value. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

// [[release]]'s `path`: one to 16 segments of 1 to 128 bytes of `A`–`Z`,
// `a`–`z`, `0`–`9`, `-`, `.` and `_`, neither `.` nor `..`; or empty, for the
// origin's root. At most 128 bytes in all, the record's bound.
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const isPath = (p: string) =>
  p === "" ||
  (p.length <= 128 &&
    p.split("/").length <= 16 &&
    p.split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== ".."));

// The node's origin. HTTPS, or plain HTTP only to a loopback address, for a
// TLS proxy on the same host; either way the route is the relay's to add.
const nodeOrigin = z.string().refine(
  (s) => {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return false;
    }
    if (url.origin !== s) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  },
  { message: "must be an https origin, or http on a loopback address" },
);

const RESOURCE = z.strictObject({
  path: z.string().refine(isPath, { message: "must be a relay path" }),
  node: nodeOrigin,
  // The node's certificate or its CA, for a node whose certificate no public
  // CA signed (a staging seat on the private network).
  ca: z.string().min(1).optional(),
});

const RATE = z.strictObject({
  requests: z.number().int().min(1).max(1_000_000),
  windowSeconds: z.number().int().min(1).max(3600),
  // The header the host's own edge sets to the client's address, its last
  // value being the one the edge appended. Without it the socket's peer is
  // the address, which behind a proxy is the proxy's.
  addressHeader: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
});

const CONFIG = z
  .strictObject({
    host: z.string().min(1),
    port: z.number().int().min(0).max(65_535),
    // Bodies held at once, across every resource (T-52).
    queue: z.number().int().min(1).max(1024).default(16),
    timeoutSeconds: z.number().int().min(1).max(300).default(60),
    resources: z.array(RESOURCE).min(1).max(128),
    rate: RATE.optional(),
  })
  .refine((c) => new Set(c.resources.map((r) => r.path)).size === c.resources.length, {
    message: "must name each path once",
    path: ["resources"],
  });

export type RelayConfig = z.output<typeof CONFIG>;
export type RelayResource = RelayConfig["resources"][number];

/** `RELAY_CONFIG` parsed; a `ConfigError` naming the first bad field otherwise. */
export function parseRelayConfig(json: string | undefined): RelayConfig {
  if (json === undefined || json === "") throw new ConfigError("RELAY_CONFIG: not set");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ConfigError("RELAY_CONFIG: not JSON");
  }
  const parsed = CONFIG.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The field's place and the rule, never its value (a CA or an origin).
    const at = issue?.path.join(".") ?? "";
    throw new ConfigError(`RELAY_CONFIG: ${at === "" ? "" : `${at}: `}${issue?.code ?? "invalid"}`);
  }
  return parsed.data;
}
