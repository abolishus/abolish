// The public API as apps/web's server calls it. Only the server calls it:
// pages get their data through server functions, so a visitor's browser talks
// to our origin alone (src/security.ts, connect-src 'self').
//
// T-10: a request to the API carries nothing of the visitor's. Each one is
// built here from the contract and the poll ID, never from the incoming
// request, so no cookie, account session or forwarded address reaches the
// API (which refuses account credentials anyway, ADR 0017).

import { contract } from "@abolishus/api-contract";
import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { ResponseValidationPlugin } from "@orpc/contract/plugins";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

export type Api = ContractRouterClient<typeof contract>;

/** How long one API call may take before the page gives up on it. */
export const API_TIMEOUT_MS = 5_000;

/** A client for the API at `baseUrl`, checking every answer against the contract. */
export function createApi(baseUrl: string, fetchImpl: typeof fetch = fetch): Api {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new RangeError("API_URL must be an http(s) URL");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new RangeError("API_URL must not carry credentials, a query or a fragment");
  const link = new OpenAPILink(contract, {
    url: url.href.replace(/\/$/, ""),
    // Only what the contract defines: no cookie, no credentials mode.
    fetch: (request, init) =>
      fetchImpl(request, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      }),
    // An answer that breaks the contract is an error, not something to render.
    plugins: [new ResponseValidationPlugin(contract)],
  });
  return createORPCClient(link);
}

let configured: Api | undefined;

/** The API this deployment names in `API_URL`. */
export function api(): Api {
  if (configured !== undefined) return configured;
  const baseUrl = process.env["API_URL"];
  if (baseUrl === undefined || baseUrl === "") throw new Error("API_URL is not set");
  configured = createApi(baseUrl);
  return configured;
}
