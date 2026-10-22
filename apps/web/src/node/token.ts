// An account's Tier 0 token, under /token on apps/web's origin
// ([[tier0-token]], Issuance; [[0039-tier0-token-issuance]]; P2-30 part 3b):
// the signed-in account sends the key's identifier, its region and a blinded
// element `B`, and gets back the issuer's evaluation and its proof. The
// account system lives here, so issuance is here too, never on the API, and
// the issuer's keys sit in this service's environment apart from every
// other secret (T-10, T-74, ADR 0017). This transport parses, asks core and
// serialises; the rules are packages/core's (src/tier0-tokens.ts).
//
// T-10: `B` is perfectly hiding, so nothing this route sees joins the account
// to a commitment; the ballot client blinds and finalises (P2-30 part 4).
// T-10, T-11, T-67: a request's session names its account and nothing else
// is read from it; answers are no-store, and the request log keeps only the
// route class: never `B`, the key or the answer. A database error (an
// account deleted mid-request, say) goes to the server's generic 500, logged
// by kind only. CSRF: the session cookie is SameSite=Strict, and every POST
// must also carry our own Origin. T-01: one token per account and
// deployment is core's, and a retry costs only an evaluation.

import {
  issueTier0Token,
  Tier0IssuanceError,
  type Tier0IssuanceErrorCode,
  type Tier0Issuer,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every token route: `METHOD /path`. Anything else is answered 404. */
export const TOKEN_ROUTES = ["POST /token"] as const;

const ROUTES: ReadonlySet<string> = new Set(TOKEN_ROUTES);

export interface TokenOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** The issuer's keys and the deployment's groups, if this deployment has them. */
  readonly issuer: Tier0Issuer | undefined;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** The clock; the system's by default. Injected so tests can set it. */
  readonly now?: () => Date;
}

/** 32 bytes as lowercase hex, as [[notation]] writes bytes. */
const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);

// The forms only: whether the key issues, the region has a group and `B` is
// an element is core's, in the spec's order.
const Input = z.strictObject({
  keyId: Hex32,
  region: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1),
  blindedElement: Hex32,
});

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string) => answer(status, { code, status });

const ERRORS: Record<Tier0IssuanceErrorCode, [number, string]> = {
  account: [403, "ACCOUNT_UNVERIFIED"],
  "key-not-issuing": [409, "KEY_NOT_ISSUING"],
  "region-unknown": [422, "REGION_UNKNOWN"],
  "blinded-element": [422, "BLINDED_ELEMENT"],
  "token-taken": [409, "TOKEN_TAKEN"],
  // The client keeps its values and retries ([[tier0-token]], Issuance, step 4).
  inverse: [503, "INVERSE"],
};

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The token handler: answers every route in `TOKEN_ROUTES` for the signed-in account. */
export function createTokenHandler({
  sql,
  accountOf,
  issuer,
  origin,
  now = () => new Date(),
}: TokenOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route) || url.search !== "") return refuse(404, "NOT_FOUND");
    // A browser sends Origin on every POST; another site's form or script can't send ours.
    if (request.headers.get("origin") !== origin) return refuse(403, "FORBIDDEN_ORIGIN");
    if (request.headers.get("content-type") !== "application/json")
      return refuse(415, "UNSUPPORTED_MEDIA_TYPE");
    const account = await accountOf(request.headers);
    if (account === undefined) return refuse(401, "SIGNED_OUT");
    if (issuer === undefined) return refuse(503, "TOKEN_UNAVAILABLE");

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return refuse(400, "BAD_REQUEST");
    }
    const input = Input.safeParse(body);
    if (!input.success) return refuse(400, "BAD_REQUEST");
    try {
      const { evaluationElement, proof } = await issueTier0Token(
        sql,
        account,
        {
          keyId: bytes(input.data.keyId),
          region: input.data.region,
          blindedElement: bytes(input.data.blindedElement),
        },
        { issuer, now: now() },
      );
      return answer(200, { evaluationElement: hex(evaluationElement), proof: hex(proof) });
    } catch (e) {
      if (!(e instanceof Tier0IssuanceError)) throw e;
      const [status, code] = ERRORS[e.code];
      return refuse(status, code);
    }
  };
}
