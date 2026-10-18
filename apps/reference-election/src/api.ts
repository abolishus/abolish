// The operator's API (apps/api, P2-3) with its worker (apps/worker): ballots
// are cast through `ballots.submit` over HTTP, queued on Redis for the
// worker, judged there by @abolishus/verifier's admission through core's
// `BallotAdmissions` (5.1 to 5.4 and 5.7) and boarded in Postgres, as a
// deployment takes them (T-17, T-38, T-52). The fixture checks each answer
// against the entry its own board holds, so the verifier's judgement of that
// board is a judgement of what the API boarded. The database is a schema of
// its own, migrated as a deployment's is and dropped at close; the queue's
// keys are under a prefix of their own, deleted at close.

import { BallotAdmissions, appendEntry, storeDefinition } from "@abolishus/core";
import { testDb } from "@abolishus/core/test-db";
import { createApiServer } from "@abolishus/api";
import type { Panel, PeriodClock } from "@abolishus/crypto";
import { BallotQueue, startWorker } from "@abolishus/worker";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";

/** The API's answer to one ballot: its board entry, or the refusal's code and the verifier's. */
export type Submitted =
  | { readonly ok: true; readonly entry: Uint8Array }
  | { readonly ok: false; readonly code: string; readonly admission?: string };

export interface OperatorApi {
  /**
   * Stores `definition` and boards `transcript` as the election's first entry
   * in `segment`, as the operator does before any ballot (core's admission
   * reads the transcript there).
   */
  open(
    definition: Uint8Array,
    electionId: Uint8Array,
    segment: number,
    transcript: Uint8Array,
  ): Promise<void>;
  /** Submits `ballot` (a ballot record) to `ballots.submit`. */
  submit(electionId: Uint8Array, ballot: Uint8Array): Promise<Submitted>;
  close(): Promise<void>;
}

export interface OperatorOptions {
  /** The panels this release pins: the fixture's. */
  readonly panels: readonly Panel[];
  /** The anchor's clock, which labels each entry's segment. */
  readonly clock: PeriodClock;
  /** UNIX time in seconds: the worker judges each batch's window and segment by it. */
  readonly now: () => bigint;
}

/** Starts the worker and the API on loopback, over a database and queue of their own. */
export async function startApi({ panels, clock, now }: OperatorOptions): Promise<OperatorApi> {
  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) throw new Error("REDIS_URL is not set");
  const prefix = `abolish-reference-${randomBytes(6).toString("hex")}`;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const closing: (() => Promise<unknown>)[] = [
    async () => {
      for (const key of await connection.keys(`${prefix}*`)) await connection.del(key);
      connection.disconnect();
    },
  ];
  // Every step runs whatever an earlier one threw, so the keys and the
  // schema go however the run ends; the first error is rethrown.
  const close = async () => {
    let failed: { readonly error: unknown } | undefined;
    for (const step of closing.reverse())
      try {
        await step();
      } catch (error) {
        failed ??= { error };
      }
    if (failed !== undefined) throw failed.error;
  };
  try {
    const db = await testDb();
    closing.push(() => db.close());
    const sql = await db.as("abolish_app");
    const worker = await startWorker({
      connection,
      sql,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix,
      now: () => new Date(Number(now()) * 1000),
      ballots: { admissions: new BallotAdmissions({ panels, clock }) },
    });
    closing.push(() => worker.close());
    const ballots = await BallotQueue.open({ connection, prefix });
    closing.push(() => ballots.close());
    const server = createApiServer({ sql, log: () => {}, ballots, now });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closing.push(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ballots`;
    return {
      async open(definition, electionId, segment, transcript) {
        await storeDefinition(sql, definition);
        await appendEntry(sql, electionId, segment, transcript);
      },
      async submit(electionId, ballot) {
        const r = await post(
          url,
          JSON.stringify({ electionId: bytesToHex(electionId), ballot: bytesToHex(ballot) }),
        );
        const body = JSON.parse(r.body) as {
          entry?: string;
          code?: string;
          data?: { code?: string };
        };
        if (r.status === 201 && typeof body.entry === "string")
          return { ok: true, entry: hexToBytes(body.entry) };
        return {
          ok: false,
          code: body.code ?? `HTTP ${r.status}`,
          ...(body.data?.code === undefined ? {} : { admission: body.data.code }),
        };
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * POSTs `json` to `url` on a connection of its own: a ballot's proof takes
 * longer than the server's keep-alive timeout, and a kept-alive socket the
 * server closes just as the next ballot is sent fails it with `ECONNRESET`.
 */
function post(url: string, json: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", agent: false, headers: { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(json);
  });
}
