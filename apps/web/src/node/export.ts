// An account's own data, under /export on apps/web's origin (P2-27 part 2b):
// the signed-in account takes away everything the account tables hold about
// it, as packages/core's `exportAccount` gives it. It reads account tables,
// so it is here, never on the API, which reads none (T-10, ADR 0017). This
// transport parses, asks core and serialises; what the export holds and
// leaves out is core's (src/account-export.ts).
//
// T-10: the route takes no account ID; the session names the account, so no
// one takes another's data. T-11, T-67: the answer is no-store and the
// request log keeps only the route class, never a byte of the export. T-73:
// the address is opened here only to hand it to its own account. CSRF: the
// session cookie is SameSite=Strict, and the POST must also carry our own
// Origin, so another site can neither send it nor read the answer.

import { type EmailKeys, exportAccount } from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every export route: `METHOD /path`. Anything else is answered 404. */
export const EXPORT_ROUTES = ["POST /export"] as const;

const ROUTES: ReadonlySet<string> = new Set(EXPORT_ROUTES);

export interface ExportOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** Opens the verified address's box; without them the export gives it as `null`. */
  readonly emailKeys: EmailKeys | undefined;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** The clock the export is dated by. */
  readonly now?: () => Date;
}

const Input = z.strictObject({});

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string) => answer(status, { code, status });

/** The export handler: answers `POST /export` for the signed-in account alone. */
export function createExportHandler({
  sql,
  accountOf,
  emailKeys,
  origin,
  now = () => new Date(),
}: ExportOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (!ROUTES.has(`${request.method} ${url.pathname}`) || url.search !== "")
      return refuse(404, "NOT_FOUND");
    // A browser sends Origin on every POST; another site's form or script can't send ours.
    if (request.headers.get("origin") !== origin) return refuse(403, "FORBIDDEN_ORIGIN");
    if (request.headers.get("content-type") !== "application/json")
      return refuse(415, "UNSUPPORTED_MEDIA_TYPE");
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return refuse(400, "BAD_REQUEST");
    }
    if (!Input.safeParse(body).success) return refuse(400, "BAD_REQUEST");
    const account = await accountOf(request.headers);
    if (account === undefined) return refuse(401, "SIGNED_OUT");
    const data = await exportAccount(sql, account, { keys: emailKeys, now: now() });
    // Deleted between the session's check and the read.
    if (data === undefined) return refuse(401, "SIGNED_OUT");
    return answer(200, data);
  };
}
