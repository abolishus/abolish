// The seat's side of the operator's opening route (`POST /openings`): the
// request carries the election's id and the opening in lowercase hex and
// nothing else, and each answer the route gives is read as what it says
// (apps/api's openings.submit: 201 with the entry, 422 OPENING_REJECTED with
// the Boarding rule's code, 503 OPENING_NOT_READY, 409 ELECTION_NOT_OPEN, 404
// ELECTION_NOT_FOUND), anything else as unavailable, never trusted further.
// A body past MAX_ANSWER is refused unread, and no redirect is followed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { HttpOperator, MAX_ANSWER } from "../src/operator.ts";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_, __, res) => res.end();
const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c: string) => (body += c));
  req.on("end", () => handler(req, body, res));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
afterAll(() => new Promise((r) => server.close(r)));

const json =
  (status: number, value: unknown): Handler =>
  (_, __, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
const ID = new Uint8Array(32).fill(0xab);
const OPENING = Uint8Array.of(0, 6, 1, 0xfe);
const entry = "000501ab";

describe("HttpOperator", () => {
  test("posts the election's id and the opening, in hex, to the base URL's openings route", async () => {
    let seen: {
      method?: string | undefined;
      url?: string | undefined;
      type?: string | undefined;
      body: string;
    } = { body: "" };
    handler = (req, body, res) => {
      seen = { method: req.method, url: req.url, type: req.headers["content-type"], body };
      json(201, { entry, link: "cd".repeat(32), earlier: false })(req, body, res);
    };
    expect(await new HttpOperator(base).submit(ID, OPENING)).toEqual({
      state: "boarded",
      entry: Uint8Array.of(0, 5, 1, 0xab),
      earlier: false,
    });
    expect(seen).toEqual({
      method: "POST",
      url: "/api/openings",
      type: "application/json",
      body: JSON.stringify({ electionId: "ab".repeat(32), opening: "000601fe" }),
    });
  });

  test.each([
    [
      422,
      { code: "OPENING_REJECTED", data: { code: "tally-aggregate" } },
      { state: "rejected", code: "tally-aggregate" },
    ],
    [503, { code: "OPENING_NOT_READY" }, { state: "not-ready" }],
    // oRPC's whole error body.
    [
      503,
      {
        defined: true,
        code: "OPENING_NOT_READY",
        status: 503,
        message: "The counted set isn't fixed yet.",
      },
      { state: "not-ready" },
    ],
    // A body of another shape is read as its status alone.
    [503, { code: "OPENING_NOT_READY", extra: 1 }, { state: "unavailable", reason: "503" }],
    [409, { code: "ELECTION_NOT_OPEN" }, { state: "not-open" }],
    [404, { code: "ELECTION_NOT_FOUND" }, { state: "not-open" }],
    [
      503,
      { code: "OPENINGS_UNAVAILABLE" },
      { state: "unavailable", reason: "OPENINGS_UNAVAILABLE" },
    ],
    [429, { code: "RATE_LIMITED" }, { state: "unavailable", reason: "RATE_LIMITED" }],
    [
      500,
      { code: "INTERNAL_SERVER_ERROR" },
      { state: "unavailable", reason: "INTERNAL_SERVER_ERROR" },
    ],
    // A code under another status, or a refusal without its code, is no answer.
    [422, { code: "OPENING_REJECTED" }, { state: "unavailable", reason: "OPENING_REJECTED" }],
    [400, { code: "OPENING_NOT_READY" }, { state: "unavailable", reason: "OPENING_NOT_READY" }],
    [
      422,
      { code: "OPENING_REJECTED", data: { code: "Not A Code" } },
      { state: "unavailable", reason: "422" },
    ],
    // A 201 that isn't the route's answer, and a code that isn't one.
    [
      201,
      { entry: "0g", link: "cd".repeat(32), earlier: false },
      { state: "unavailable", reason: "unreadable 201" },
    ],
    [
      201,
      { entry, link: "cd".repeat(32), earlier: false, extra: 1 },
      { state: "unavailable", reason: "unreadable 201" },
    ],
    [502, { code: "x".repeat(100) }, { state: "unavailable", reason: "502" }],
  ])("reads %i %j as what it says", async (status, body, answer) => {
    handler = json(status, body);
    expect(await new HttpOperator(base).submit(ID, OPENING)).toEqual(answer);
  });

  test("a body that isn't JSON, or past MAX_ANSWER, is unavailable", async () => {
    handler = (_, __, res) => res.writeHead(201).end("<html>");
    expect(await new HttpOperator(base).submit(ID, OPENING)).toEqual({
      state: "unavailable",
      reason: "unreadable 201",
    });
    handler = json(201, { entry: "00".repeat(MAX_ANSWER), link: "cd".repeat(32), earlier: false });
    expect(await new HttpOperator(base).submit(ID, OPENING)).toEqual({
      state: "unavailable",
      reason: "unreadable 201",
    });
  });

  test("follows no redirect, and an operator not reached or too slow is unavailable", async () => {
    // The redirect's target would board it: only refusing it answers unavailable.
    handler = (req, body, res) =>
      req.url === "/api/openings"
        ? res.writeHead(307, { location: "/elsewhere" }).end()
        : json(201, { entry, link: "cd".repeat(32), earlier: false })(req, body, res);
    expect(await new HttpOperator(base).submit(ID, OPENING)).toMatchObject({
      state: "unavailable",
    });
    handler = () => {};
    expect(await new HttpOperator(base, { timeoutMs: 50 }).submit(ID, OPENING)).toEqual({
      state: "unavailable",
      reason: "unreached (TimeoutError)",
    });
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    expect(await new HttpOperator(`http://127.0.0.1:${port}/`).submit(ID, OPENING)).toEqual({
      state: "unavailable",
      reason: "unreached (ECONNREFUSED)",
    });
  });

  test("takes only an https base URL, or http to loopback", () => {
    expect(() => new HttpOperator("http://api.example/")).toThrow(/operator URL must be https/);
    expect(() => new HttpOperator("https://u:p@api.example/")).toThrow(/operator URL takes no/);
    expect(() => new HttpOperator("https://api.example/v1")).not.toThrow();
  });
});
