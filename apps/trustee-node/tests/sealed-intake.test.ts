import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import {
  decodeSealedAnswer,
  type DeliveryEnvelope,
  type DeliveryHolder,
  type DeliveryKey,
  kemKeygen,
  kemKeyHash,
  MAX_SEALED_REQUEST,
  openSealedAnswer,
  openSealedDelivery,
  SEALED_ANSWER_LENGTH,
  sealDelivery,
} from "@abolishus/crypto";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  encodeDelivery,
  type Endpoint,
  type Intake,
  type IntakeOutcome,
  type SealedKeys,
  seatKeys,
  serveIntake,
} from "../src/index.ts";
import type { CeremonySeat } from "../src/ceremony.ts";
import { MemoryStore } from "../src/store.ts";
import { election, runCeremony, value } from "./fixture.ts";

// docs/spec/vectors/sealed-delivery.json comes from the spec's independent
// Python generator, so the requests below, and the keys their answers open
// under, never come from the code under test.
interface Vectors {
  readonly seats: readonly {
    readonly seat: number;
    readonly kemKeyHash: string;
    readonly seed: string;
    readonly x: string;
  }[];
  readonly stub: string;
  readonly deliveries: readonly {
    readonly id: string;
    readonly seat: number;
    readonly sealing: { readonly key: string };
    readonly record: string;
    readonly requestHash: string;
    readonly answers: readonly { readonly outcome: string; readonly body: string }[];
  }[];
  readonly rejectedRequests: readonly {
    readonly description: string;
    readonly code: string;
    readonly openedBy: number;
    readonly record: string;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/sealed-delivery.json", import.meta.url), "utf8"),
) as Vectors;

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const RECEIPT = bytes(164, 9);

/** The vectors' seat `seat` as a node holds it. */
function vectorHolder(seat: number): DeliveryHolder {
  const s = V.seats.find((x) => x.seat === seat);
  if (s === undefined) throw new Error(`no seat ${seat} in the vectors`);
  return {
    kemKeyHash: fromHex(s.kemKeyHash),
    secretKey: { seed: fromHex(s.seed), x: BigInt(s.x) },
  };
}

/** Stand-in keys: the holders given, found by their key hash, and the hashes asked for. */
function keys(...holders: DeliveryHolder[]) {
  const asked: string[] = [];
  const sealed: SealedKeys = {
    async withHolder(kemKeyHash, open) {
      asked.push(toHex(kemKeyHash));
      const holder = holders.find((h) => toHex(h.kemKeyHash) === toHex(kemKeyHash));
      return holder === undefined ? undefined : open(holder);
    },
  };
  return { sealed, asked };
}

/** A stand-in seat answering what `answer` says, recording each delivery it was given. */
function seat(
  answer: () => Promise<IntakeOutcome> = async () => ({
    ok: true,
    ballotHash: bytes(32),
    receipt: RECEIPT,
  }),
) {
  const given: DeliveryEnvelope[] = [];
  const intake: Intake = {
    async intake(stub, transcript, record, ciphertext) {
      // Copied: the route erases the envelope once it has answered.
      given.push({
        stub: stub.slice(),
        transcript: transcript.slice(),
        record: record.slice(),
        ciphertext: ciphertext.slice(),
      });
      return answer();
    },
  };
  return { intake, given };
}

const open: Endpoint[] = [];
async function serve(intake: Intake, sealed: SealedKeys, queue = 4, log?: (e: unknown) => void) {
  const endpoint = await serveIntake(intake, {
    host: "127.0.0.1",
    port: 0,
    queue,
    sealed,
    ...(log === undefined ? {} : { log }),
  });
  open.push(endpoint);
  return endpoint;
}
afterAll(async () => {
  for (const e of open) await e.close();
});

const sealedUrl = (e: Endpoint) => {
  if (e.sealedUrl === undefined) throw new Error("the endpoint serves no sealed route");
  return e.sealedUrl;
};

const post = (url: string, body: Uint8Array, type = "message/ohttp-req") =>
  fetch(url, { method: "POST", headers: { "content-type": type }, body: Buffer.from(body) });

const envelope: DeliveryEnvelope = {
  stub: bytes(3, 1),
  transcript: bytes(4, 2),
  record: bytes(5, 3),
  ciphertext: bytes(6, 4),
};

/** The answer's plaintext under the client's own `K` and `request_hash`. */
async function answerOf(res: Response, sent: DeliveryKey) {
  const body = new Uint8Array(await res.arrayBuffer());
  expect(body.length).toBe(SEALED_ANSWER_LENGTH);
  const opened = openSealedAnswer(sent, body);
  if (!opened.ok) expect.fail(`the answer didn't open: ${opened.code}`);
  return opened.answer;
}

describe("the sealed route", () => {
  it("opens a request sealed to the seat's key, runs intake on its envelope and seals the receipt back", async () => {
    const pair = kemKeygen();
    const k = keys({ kemKeyHash: kemKeyHash(pair.publicKey), secretKey: pair.secretKey });
    const s = seat();
    const endpoint = await serve(s.intake, k.sealed);
    expect(sealedUrl(endpoint)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/sealed-intake$/);
    const { request, sent } = sealDelivery(pair.publicKey, envelope);
    const res = await post(sealedUrl(endpoint), request);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("message/ohttp-res");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Its only peers are relays: no browser origin is allowed (T-43).
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await answerOf(res, sent)).toEqual({ outcome: "receipt", receipt: RECEIPT });
    expect(s.given).toEqual([envelope]);
    expect(k.asked).toEqual([toHex(kemKeyHash(pair.publicKey))]);
  });

  it("answers the spec's deliveries under the keys their vectors give, for a receipt, a refusal and busy", async () => {
    for (const d of V.deliveries) {
      for (const a of d.answers) {
        const outcome: IntakeOutcome =
          a.outcome === "receipt"
            ? { ok: true, ballotHash: bytes(32), receipt: fromHex(a.body) }
            : {
                ok: false,
                code: Buffer.from(fromHex(a.body)).toString("ascii") as "intake-closed",
              };
        const s = seat(async () => {
          if (a.outcome === "busy") throw new Error("the seat's store is down");
          return outcome;
        });
        const endpoint = await serve(s.intake, keys(vectorHolder(d.seat)).sealed);
        const res = await post(sealedUrl(endpoint), fromHex(d.record));
        expect(res.status).toBe(200);
        const sent = { key: fromHex(d.sealing.key), requestHash: fromHex(d.requestHash) };
        const answer = await answerOf(res, sent);
        expect(answer.outcome).toBe(a.outcome);
        if (answer.outcome === "receipt") expect(toHex(answer.receipt)).toBe(a.body);
        if (answer.outcome === "refused") expect(answer.code).toBe("intake-closed");
        expect(s.given.map((g) => toHex(g.stub))).toEqual([V.stub]);
      }
    }
  });

  for (const c of V.rejectedRequests)
    it(`answers the spec's refused request as its code says (${c.code}): ${c.description}`, async () => {
      const s = seat();
      const k = keys(vectorHolder(c.openedBy));
      const endpoint = await serve(s.intake, k.sealed);
      const res = await post(sealedUrl(endpoint), fromHex(c.record));
      const body = new Uint8Array(await res.arrayBuffer());
      if (c.code === "sealed-envelope") {
        // It opened, so its refusal is sealed back like any other answer.
        expect(res.status).toBe(200);
        expect(body.length).toBe(SEALED_ANSWER_LENGTH);
        expect(() => decodeSealedAnswer(body, 1)).not.toThrow();
      } else {
        // The same 400 with no body for all three (T-39).
        expect(res.status).toBe(400);
        expect(body.length).toBe(0);
      }
      // A malformed request is refused before any key is looked up.
      expect(k.asked.length).toBe(c.code === "sealed-malformed" ? 0 : 1);
      expect(s.given).toEqual([]);
    });

  it("seals each answer to a replayed request under its own nonce, the same receipt inside (T-25)", async () => {
    const pair = kemKeygen();
    const s = seat();
    const endpoint = await serve(
      s.intake,
      keys({ kemKeyHash: kemKeyHash(pair.publicKey), secretKey: pair.secretKey }).sealed,
    );
    const { request, sent } = sealDelivery(pair.publicKey, envelope);
    const first = await post(sealedUrl(endpoint), request);
    const second = await post(sealedUrl(endpoint), request);
    const [a, b] = [
      new Uint8Array(await first.clone().arrayBuffer()),
      new Uint8Array(await second.clone().arrayBuffer()),
    ];
    expect(toHex(a)).not.toBe(toHex(b));
    expect(await answerOf(first, sent)).toEqual(await answerOf(second, sent));
  });

  it("answers busy, sealed, when intake throws or gives a code an answer can't carry, logging only the error's name (T-13)", async () => {
    const pair = kemKeygen();
    const k = keys({ kemKeyHash: kemKeyHash(pair.publicKey), secretKey: pair.secretKey });
    const logged: unknown[] = [];
    const answers: (() => Promise<IntakeOutcome>)[] = [
      () => Promise.reject(new TypeError(`secret ${"ab".repeat(8)}`)),
      async () => ({ ok: false, code: "Not A Code" as "intake-closed" }),
    ];
    const s = seat(() => (answers.shift() as () => Promise<IntakeOutcome>)());
    const endpoint = await serve(s.intake, k.sealed, 4, (e) => logged.push(e));
    for (let i = 0; i < 2; i++) {
      const { request, sent } = sealDelivery(pair.publicKey, envelope);
      const res = await post(sealedUrl(endpoint), request);
      expect(res.status).toBe(200);
      expect(await answerOf(res, sent)).toEqual({ outcome: "busy" });
    }
    expect(logged).toEqual([
      { event: "intake-error", error: "TypeError" },
      { event: "intake-error", error: "RangeError" },
    ]);
  });

  it("answers 400 for a key the seat no longer holds, never running intake", async () => {
    const pair = kemKeygen();
    const s = seat();
    // A seat that has begun destroying the election: no holder.
    const endpoint = await serve(s.intake, keys().sealed);
    const res = await post(sealedUrl(endpoint), sealDelivery(pair.publicKey, envelope).request);
    expect(res.status).toBe(400);
    expect(s.given).toEqual([]);
  });

  it("refuses other methods and types, and a body past its bound, without opening anything (T-52)", async () => {
    const pair = kemKeygen();
    const s = seat();
    const k = keys({ kemKeyHash: kemKeyHash(pair.publicKey), secretKey: pair.secretKey });
    const url = sealedUrl(await serve(s.intake, k.sealed));
    const { request } = sealDelivery(pair.publicKey, envelope);
    const options = await fetch(url, { method: "OPTIONS" });
    expect(options.status).toBe(405);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(url)).status).toBe(405);
    expect((await post(url, request, "application/octet-stream")).status).toBe(415);
    // The plain route's envelope at the sealed route is malformed there.
    expect((await post(url, encodeDelivery(envelope))).status).toBe(400);
    const declared = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "message/ohttp-req",
            "content-length": String(MAX_SEALED_REQUEST + 1),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(declared).toBe(413);
    const streamed = await post(url, new Uint8Array(MAX_SEALED_REQUEST + 1));
    expect(streamed.status).toBe(413);
    expect(k.asked).toEqual([]);
    expect(s.given).toEqual([]);
  });

  it("shares the plain route's queue: past it either answers 503 before reading the body", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pair = kemKeygen();
    const s = seat(async () => {
      await gate;
      return { ok: true, ballotHash: bytes(32), receipt: RECEIPT };
    });
    const endpoint = await serve(
      s.intake,
      keys({ kemKeyHash: kemKeyHash(pair.publicKey), secretKey: pair.secretKey }).sealed,
      1,
    );
    const held = post(sealedUrl(endpoint), sealDelivery(pair.publicKey, envelope).request);
    while (s.given.length < 1) await new Promise((r) => setTimeout(r, 5));
    const busy = await post(sealedUrl(endpoint), sealDelivery(pair.publicKey, envelope).request);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    const plain = await post(endpoint.url, encodeDelivery(envelope), "application/octet-stream");
    expect(plain.status).toBe(503);
    release();
    expect((await held).status).toBe(200);
  });

  it("isn't served without the seat's keys", async () => {
    const endpoint = await serveIntake(seat().intake, { host: "127.0.0.1", port: 0, queue: 1 });
    open.push(endpoint);
    expect(endpoint.sealedUrl).toBeUndefined();
    const url = endpoint.url.replace("/v1/intake", "/v1/sealed-intake");
    expect((await post(url, new Uint8Array(10))).status).toBe(404);
  });
});

describe("the seat's keys", () => {
  /** Seat 1 of a 3-of-4 panel that approved a fresh stub over `store`, and its registered KEM key. */
  async function approve(store: MemoryStore) {
    const e = election(4, 3, { stores: [store] });
    const run = await runCeremony(e);
    for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
    const kemKey = run.keys.find((k) => k.index === 1)?.kem_key;
    if (kemKey === undefined) expect.fail("seat 1 sent its keys");
    return { e, seat: e.seats[0] as CeremonySeat, kemKey };
  }

  /** Whether `keys` opens a request sealed to `kemKey`. */
  const opens = async (keys: SealedKeys, kemKey: Parameters<typeof sealDelivery>[0]) => {
    const { request } = sealDelivery(kemKey, envelope);
    const result = await keys.withHolder(kemKeyHash(kemKey), (h) =>
      openSealedDelivery([h], request),
    );
    return result === undefined ? undefined : result.ok;
  };

  it("opens with the secret of the run the seat approved, and finds an election approved since", async () => {
    const store = new MemoryStore();
    const first = await approve(store);
    const keys = seatKeys(first.seat);
    expect(await opens(keys, first.kemKey)).toBe(true);
    // A key no election of the seat's registered.
    expect(await opens(keys, kemKeygen().publicKey)).toBeUndefined();
    // Another election over the same store, approved after the index was built.
    const second = await approve(store);
    expect(await opens(keys, second.kemKey)).toBe(true);
    expect(await opens(keys, first.kemKey)).toBe(true);
  }, 60_000);

  it("holds no key once the seat has begun destroying its election (T-14)", async () => {
    const a = await approve(new MemoryStore());
    const keys = seatKeys(a.seat);
    expect(await opens(keys, a.kemKey)).toBe(true);
    await a.seat.destroy(a.e.stubHash);
    expect(await opens(keys, a.kemKey)).toBeUndefined();
    // Nor does a fresh index, which sees the approval but no secret.
    expect(await opens(seatKeys(a.seat), a.kemKey)).toBeUndefined();
  }, 60_000);
});
