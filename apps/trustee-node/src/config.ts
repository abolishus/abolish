// The node's deployment configuration (README, Configuration): the pinned
// panel, the seat, where the identity key and the store live, and the
// coordinator. JSON at a transport boundary, so it is parsed with a strict
// schema; the panel's keys are protocol bytes, so they are checked by
// `@abolishus/crypto` (`panelId`) and must hash to the `panelId` the trustee
// compared out of band, so a mistyped key can't pin another panel (T-17).
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { panelId, PanelError, type Panel } from "@abolishus/crypto";
import { z } from "zod";
import { coordinatorUrl } from "./client.ts";

const hexOf = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^(0x)?[0-9a-f]{${2 * bytes}}$`))
    .transform((s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex")));

const CONFIG = z.strictObject({
  panel: z.strictObject({
    threshold: z.number().int().min(1),
    keys: z.array(hexOf(33)).min(1),
  }),
  panelId: hexOf(32),
  l2ChainId: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .transform(BigInt)
    .refine((v) => v < 1n << 64n),
  trusteeRegistry: hexOf(20),
  seat: z.number().int().min(1),
  identityKeyFile: z.string().min(1),
  store: z.string().min(1),
  coordinator: z.string().min(1),
  pollSeconds: z.number().min(1).max(3600).default(5),
});

export interface NodeConfig {
  readonly panel: Panel;
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  readonly seat: number;
  readonly identityKeyFile: string;
  readonly store: string;
  readonly coordinator: string;
  readonly pollSeconds: number;
}

/** A configuration the node can't run with; the message says which field. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function parseConfig(json: string): NodeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ConfigError("config: not JSON");
  }
  const parsed = CONFIG.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`config: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
  }
  const c = parsed.data;
  const panel: Panel = { threshold: c.panel.threshold, keys: c.panel.keys };
  let id: Uint8Array;
  try {
    id = panelId(panel);
  } catch (e) {
    if (e instanceof PanelError) throw new ConfigError(`config: panel: ${e.message}`);
    throw e;
  }
  if (!Buffer.from(id).equals(Buffer.from(c.panelId)))
    throw new ConfigError("config: panelId: the panel's keys hash to another identifier");
  if (c.seat > panel.keys.length) throw new ConfigError("config: seat: not a seat of the panel");
  try {
    coordinatorUrl(c.coordinator);
  } catch (e) {
    throw new ConfigError(`config: coordinator: ${(e as Error).message}`);
  }
  return {
    panel,
    l2ChainId: c.l2ChainId,
    trusteeRegistry: c.trusteeRegistry,
    seat: c.seat,
    identityKeyFile: c.identityKeyFile,
    store: c.store,
    coordinator: c.coordinator,
    pollSeconds: c.pollSeconds,
  };
}

/**
 * The seat's identity secret key: 32 bytes as hex in a regular file only
 * its owner can reach, as `FileStore` requires of its root. A key others
 * can read could sign the seat's approvals (T-37).
 */
export async function readIdentityKey(path: string): Promise<Uint8Array> {
  // Opened without following a link and checked through the same handle, so
  // the file checked is the file read.
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw new ConfigError(`identity key: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ConfigError("identity key: not a regular file");
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new ConfigError(
        "identity key: the file must be owned by this user and mode 0600 or 0400",
      );
    const text = (await file.readFile("utf8")).replace(/\n$/, "");
    if (!/^[0-9a-f]{64}$/.test(text)) throw new ConfigError("identity key: expected 64 hex digits");
    return Uint8Array.from(Buffer.from(text, "hex"));
  } finally {
    await file.close();
  }
}
