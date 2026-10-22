import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { deliverShare, type Delivery, type IntakeAnswer } from "../src/intake.ts";

// Delivering one seat's share through the operator's relay (src/intake.ts;
// [[delivery]], Client rule 4): the request carries the node's own envelope
// and nothing of the account, with no credential, referrer or redirect
// (T-10, T-11), each answer the relay passes on is read only in its own
// shape, and a receipt only up to a few kilobytes (T-52). Nothing here
// judges a receipt: the worker does (tests/cast.test.ts).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const API = "https://api-staging.abolish.us";

const DELIVERY: Delivery = {
  stub: new Uint8Array(40).fill(1),
  transcript: new Uint8Array(300).fill(2),
  record: new Uint8Array(500).fill(3),
  ciphertext: new Uint8Array(1120).fill(4),
};

/**
 * The node's `Delivery` read back by hand, not with the codec under test:
 * four fields, each a big-endian `u32` length and then that many bytes.
 */
function parseEnvelope(body: Uint8Array): Uint8Array[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const fields: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < 4; i++) {
    const length = view.getUint32(at);
    fields.push(body.slice(at + 4, at + 4 + length));
    at += 4 + length;
  }
  if (at !== body.length) throw new Error("trailing bytes");
  return fields;
}

/** Delivers `DELIVERY` to seat 2 against `answer`, returning what it read and what was asked. */
async function deliverAgainst(answer: () => Response, delivery = DELIVERY, seat = 2) {
  const calls: [string, RequestInit][] = [];
  const read = await deliverShare({ api: API }, seat, delivery, async (url, init) => {
    calls.push([url, init]);
    return answer();
  });
  return { read, calls };
}

const octets = (body: Uint8Array<ArrayBuffer> | string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/octet-stream" } });
const text = (body: string, status = 422) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

describe("deliverShare", () => {
  test("posts the node's envelope to the seat's relay route, with nothing but its type", async () => {
    const receipt = new Uint8Array(170).fill(9);
    const { read, calls } = await deliverAgainst(() => octets(receipt));
    expect(read).toEqual({ kind: "receipt", receipt });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/v1/intake/seats/2`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      headers: { "content-type": "application/octet-stream" },
    });
    expect(Object.keys(init.headers as object)).toEqual(["content-type"]);
    expect(parseEnvelope(init.body as Uint8Array)).toEqual([
      DELIVERY.stub,
      DELIVERY.transcript,
      DELIVERY.record,
      DELIVERY.ciphertext,
    ]);
  });

  test("any delivery's envelope carries its four fields in order, byte for byte", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 64 }),
        fc.uint8Array({ maxLength: 64 }),
        fc.uint8Array({ maxLength: 64 }),
        fc.uint8Array({ maxLength: 64 }),
        fc.integer({ min: 1, max: 16 }),
        async (stub, transcript, record, ciphertext, seat) => {
          const { calls } = await deliverAgainst(
            () => octets(new Uint8Array(1)),
            { stub, transcript, record, ciphertext },
            seat,
          );
          const [url, init] = calls[0] as [string, RequestInit];
          expect(url).toBe(`${API}/v1/intake/seats/${seat}`);
          expect(parseEnvelope(init.body as Uint8Array)).toEqual([
            stub,
            transcript,
            record,
            ciphertext,
          ]);
        },
      ),
      { numRuns },
    );
  });

  test("refuses a seat outside a panel before sending anything", async () => {
    for (const seat of [0, -1, 1.5, 17, Number.NaN]) {
      let sent = 0;
      await expect(
        deliverShare({ api: API }, seat, DELIVERY, async () => (sent++, octets(""))),
      ).rejects.toThrow(RangeError);
      expect(sent).toBe(0);
    }
  });

  test.each<[string, () => Response, IntakeAnswer]>([
    [
      "a refusal with the node's code",
      () => text("intake-transcript"),
      {
        kind: "refused",
        code: "intake-transcript",
      },
    ],
    ["a busy relay or node", () => new Response("", { status: 503 }), { kind: "busy" }],
    [
      "a node the relay couldn't reach",
      () => new Response("", { status: 502 }),
      {
        kind: "unavailable",
      },
    ],
    ["a seat with no endpoint", () => new Response("", { status: 404 }), { kind: "not-relayed" }],
    [
      "a body the relay refused",
      () => new Response("", { status: 400 }),
      {
        kind: "not-relayed",
      },
    ],
    [
      "a body over the relay's bound",
      () => new Response("", { status: 413 }),
      {
        kind: "not-relayed",
      },
    ],
    ["another body type", () => new Response("", { status: 415 }), { kind: "not-relayed" }],
  ])("reads %s", async (_, answer, expected) => {
    expect((await deliverAgainst(answer)).read).toEqual(expected);
  });

  test.each<[string, () => Response]>([
    ["a receipt of another type", () => new Response(new Uint8Array(170), { status: 200 })],
    ["a receipt past the bound", () => octets(new Uint8Array(4097))],
    ["a refusal that isn't a code", () => text("Intake Refused")],
    ["a refusal code that is too long", () => text("a".repeat(65))],
    ["a refusal that isn't UTF-8", () => new Response(Uint8Array.of(0xff), { status: 422 })],
    ["a refusal past the bound", () => text("a".repeat(5000))],
    ["a redirect's or proxy's status", () => new Response("", { status: 500 })],
    ["a created status", () => octets(new Uint8Array(170), 201)],
  ])("reads %s as unreachable", async (_, answer) => {
    expect((await deliverAgainst(answer)).read).toEqual({ kind: "unreachable" });
  });

  test("a network failure is unreachable", async () => {
    const read = await deliverShare({ api: API }, 1, DELIVERY, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(read).toEqual({ kind: "unreachable" });
  });
});
