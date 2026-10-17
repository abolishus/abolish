// Storing and serving display text (docs/spec/display-text.md). A record is
// stored only once @abolishus/crypto has checked it against the stored
// definition's commitment and the spec's rules, the same check the ballot
// client runs before it shows a ballot, so the server never serves text the
// client would refuse. Serving it is no claim: the client checks it again
// against the definition whose hash the L2 registry holds (T-34, T-41).
//
// What is served follows the moderation policy (docs/moderation-policy.md,
// Open polls; T-68): a hidden poll's text is withheld, except a poll hidden
// only as a `threat` while ballots can still land, whose text the ballot
// client keeps showing under a notice. The text stays in this table until the
// unpinning job deletes it (P4-3).

import {
  checkElectionToShow,
  decodeElectionDefinition,
  electionDefinitionHash,
  type ShowRefusal,
} from "@abolishus/crypto";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { displayTexts, moderationActions } from "./db/schema/index.ts";
import { readDefinition } from "./definitions.ts";
import { REMOVAL_REASONS } from "./moderation.ts";

export type DisplayTextErrorCode =
  /** No definition is stored for the election, so nothing to check the text against. */
  | "unknown-election"
  /** The text fails the show check against the stored definition (the refusal is the cause). */
  | "refused"
  /** The election already has different text; a definition commits to one. */
  | "conflict";

export class DisplayTextError extends Error {
  override readonly name = "DisplayTextError";
  readonly code: DisplayTextErrorCode;
  constructor(code: DisplayTextErrorCode, options?: { cause?: ShowRefusal }) {
    super(`display text refused: ${code}`, options);
    this.code = code;
  }
}

/** What the API serves for an election's text. */
export type ServedDisplayText =
  | { readonly served: "text"; readonly displayText: Uint8Array }
  /** Moderation withholds it (docs/moderation-policy.md). */
  | { readonly served: "withheld" }
  /** The election is known but no text is stored for it. */
  | { readonly served: "none" };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function checkElectionId(electionId: unknown): asserts electionId is Uint8Array {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
}

/**
 * Stores `displayText` for `electionId`, after `checkElectionToShow` passes it
 * against the stored definition. Storing the same bytes again is a no-op;
 * other bytes for an election that has text are a `conflict` (the
 * commitment binds one record, so they can't pass the check unless the hash
 * collides).
 */
export async function storeDisplayText(
  client: Sql,
  electionId: Uint8Array,
  displayText: Uint8Array,
): Promise<void> {
  checkElectionId(electionId);
  if (!isBytes(displayText)) throw new TypeError("displayText must be a Uint8Array");
  const id = new Uint8Array(electionId);
  const bytes = new Uint8Array(displayText);
  const definition = await readDefinition(client, id);
  if (definition === undefined) throw new DisplayTextError("unknown-election");
  // A stored definition decoded and was well formed when it was stored, so
  // its hash is the one the registry holds if it was taken from the registry.
  const registered = electionDefinitionHash(decodeElectionDefinition(definition));
  const checked = checkElectionToShow(id, registered, definition, bytes);
  if (!checked.ok) throw new DisplayTextError("refused", { cause: checked });
  const db = drizzle({ client });
  const inserted = await db
    .insert(displayTexts)
    .values({ electionId: id, displayText: bytes })
    .onConflictDoNothing({ target: displayTexts.electionId })
    .returning({ electionId: displayTexts.electionId });
  if (inserted.length === 0) {
    const [stored] = await db
      .select({ displayText: displayTexts.displayText })
      .from(displayTexts)
      .where(eq(displayTexts.electionId, id));
    // A row deleted in between is a takedown: storing it again would undo it.
    if (stored === undefined || !equal(new Uint8Array(stored.displayText), bytes))
      throw new DisplayTextError("conflict");
  }
}

/**
 * The text the API serves for `electionId` at `now` (UNIX seconds), or
 * `undefined` if no definition is stored for it. A hidden poll's text is
 * withheld unless ballots can still land (until `closes_at` plus
 * `l1_inclusion_bound`, the window in which `moderate` refuses any other
 * hide) and every ground cited since it was hidden is `threat`: a re-citation
 * adds a ground rather than replacing one, so text hidden as `personal-data`
 * or `illegal` stays withheld however it is re-cited, and a `threat` hide
 * re-cited under either is withheld from then on (docs/moderation-policy.md,
 * Open polls and Reasons).
 */
export async function readServedDisplayText(
  client: Sql,
  electionId: Uint8Array,
  now: bigint,
): Promise<ServedDisplayText | undefined> {
  checkElectionId(electionId);
  const id = new Uint8Array(electionId);
  const definition = await readDefinition(client, id);
  if (definition === undefined) return undefined;
  const db = drizzle({ client });
  // Within a run of one state each ground is cited once (`moderate`), so a
  // run of hides holds at most one row per removal reason.
  const recent = await db
    .select({ action: moderationActions.action, reason: moderationActions.reason })
    .from(moderationActions)
    .where(eq(moderationActions.electionId, id))
    .orderBy(desc(moderationActions.seq))
    .limit(REMOVAL_REASONS.length + 1);
  const end = recent.findIndex((r) => r.action !== "hide");
  const hiddenRun = end === -1 ? recent : recent.slice(0, end);
  if (hiddenRun.length > 0) {
    const def = decodeElectionDefinition(definition);
    const open = now < def.closes_at + BigInt(def.l1_inclusion_bound);
    if (!(open && hiddenRun.every((r) => r.reason === "threat"))) return { served: "withheld" };
  }
  const [row] = await db
    .select({ displayText: displayTexts.displayText })
    .from(displayTexts)
    .where(eq(displayTexts.electionId, id));
  if (row === undefined) return { served: "none" };
  return { served: "text", displayText: new Uint8Array(row.displayText) };
}
