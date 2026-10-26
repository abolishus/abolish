// The seat's side of the operator's opening route (`POST /openings`,
// apps/api; docs/spec/tally.md, Opening record, Boarding): the one call the
// node makes to the board operator's API. It sends a tally opening the seat
// signed and reads back what the operator claims of it. The operator is
// trusted for nothing here: whether a cell is published is read from the
// anchored board (`boardOpenings`), and an answer only decides when the
// opening is sent again (T-53, T-54). The request carries the election's id
// and the opening, both public once boarded, and no credential (T-10).
import { z } from "zod";
import { coordinatorUrl, readCapped, TransportError } from "./client.ts";

/** What the operator answered to one opening. */
export type OperatorAnswer =
  /**
   * 201: the board entry the operator says carries it, `earlier` when the
   * entry carries the same signed message in other bytes. A claim: the
   * sender checks the entry's payload against its own opening.
   */
  | { readonly state: "boarded"; readonly entry: Uint8Array; readonly earlier: boolean }
  /** 422 `OPENING_REJECTED`: the Boarding rule's code, as the operator judged it. */
  | { readonly state: "rejected"; readonly code: string }
  /** 503 `OPENING_NOT_READY`: the operator hasn't fixed the counted set yet. */
  | { readonly state: "not-ready" }
  /** 409 `ELECTION_NOT_OPEN` or 404 `ELECTION_NOT_FOUND`: the operator boards no opening of it now. */
  | { readonly state: "not-open" }
  /**
   * Anything else: the operator couldn't judge it in time
   * (`OPENINGS_UNAVAILABLE`), limited the rate, failed, or couldn't be
   * reached; `reason` says which, never a body.
   */
  | { readonly state: "unavailable"; readonly reason: string };

/** What the node needs of the operator; `HttpOperator` over HTTPS, or one in-process. */
export interface OpeningOperator {
  submit(electionId: Uint8Array, opening: Uint8Array): Promise<OperatorAnswer>;
}

export interface HttpOperatorOptions {
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  /** Per request, in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * The most the node reads of an answer: an entry of the largest whole
 * opening (`MAX_TALLY_OPENING_ENTRY`, about 8 KiB) in hex, with the link and
 * the JSON around it, well under this.
 */
export const MAX_ANSWER = 64 * 1024;

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const HEX = /^(?:[0-9a-f]{2})*$/;

const BOARDED = z.strictObject({
  entry: z.string().regex(HEX),
  link: z.string().regex(/^[0-9a-f]{64}$/),
  earlier: z.boolean(),
});
// oRPC's error body: every field it sends is declared, and only `code` and,
// for a refusal, `data.code` are read. A body of any other shape (a proxy's
// error page) fails the parse and is read as its status alone.
const ERROR = z.strictObject({
  defined: z.boolean().optional(),
  code: z.string(),
  status: z.number().optional(),
  message: z.string().optional(),
  data: z
    .strictObject({
      code: z
        .string()
        .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
        .max(64),
    })
    .optional(),
});

/** The operator's API at its base URL: HTTPS, or HTTP to loopback for a local run. */
export class HttpOperator implements OpeningOperator {
  readonly #url: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(url: string, options: HttpOperatorOptions = {}) {
    this.#url = new URL("openings", coordinatorUrl(url, "operator"));
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async submit(electionId: Uint8Array, opening: Uint8Array): Promise<OperatorAnswer> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        // A redirect could leave HTTPS or the pinned host.
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ electionId: hexOf(electionId), opening: hexOf(opening) }),
      });
    } catch (e) {
      // The cause's code (a timeout, DNS, TLS) holds no secret.
      const name = (x: unknown) => {
        const { code, name } = (x ?? {}) as { code?: unknown; name?: unknown };
        return typeof code === "string" ? code : typeof name === "string" ? name : undefined;
      };
      const cause = (e as { cause?: unknown }).cause;
      const code = (cause instanceof Object ? name(cause) : undefined) ?? name(e) ?? "unknown";
      return { state: "unavailable", reason: `unreached (${code})` };
    }
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder().decode(await readCapped(response, MAX_ANSWER, "operator")),
      );
    } catch (e) {
      if (!(e instanceof TransportError) && !(e instanceof SyntaxError)) throw e;
      return { state: "unavailable", reason: `unreadable ${response.status}` };
    }
    if (response.status === 201) {
      const ok = BOARDED.safeParse(body);
      if (!ok.success) return { state: "unavailable", reason: "unreadable 201" };
      return {
        state: "boarded",
        entry: Uint8Array.from(ok.data.entry.match(/../g) ?? [], (h) => parseInt(h, 16)),
        earlier: ok.data.earlier,
      };
    }
    const error = ERROR.safeParse(body);
    const code = error.success ? error.data.code : undefined;
    if (response.status === 422 && code === "OPENING_REJECTED" && error.data?.data !== undefined)
      return { state: "rejected", code: error.data.data.code };
    if (response.status === 503 && code === "OPENING_NOT_READY") return { state: "not-ready" };
    if (
      (response.status === 409 && code === "ELECTION_NOT_OPEN") ||
      (response.status === 404 && code === "ELECTION_NOT_FOUND")
    )
      return { state: "not-open" };
    return {
      state: "unavailable",
      reason: code !== undefined && /^[A-Z_]{1,64}$/.test(code) ? code : `${response.status}`,
    };
  }
}
