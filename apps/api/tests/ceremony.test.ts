import {
  answersMessage,
  type CeremonyParams,
  type CeremonyTranscript,
  ceremonyKeygen,
  challengesMessage,
  checkCeremonyTranscript,
  decodeCeremonyTranscript,
  decodeElectionDefinitionV5,
  electionStubV5Hash,
  encodeCeremonyTranscript,
  identityKey,
  keySetEntry,
  keySetHash,
  keysMessage,
  type Panel,
  revealsMessage,
  type SeatSecrets,
  signCeremonyRegistration,
  tierTreeRoot,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import {
  ACCOUNT_COOKIE_PREFIX,
  approvedCeremony,
  closeCeremonyRounds,
  createPollDraft,
  newAccountId,
  openCeremonyRuns,
  type PollStubDeployment,
  stubPolls,
  submitPollDraft,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  decodeMessagePost,
  encodeApprovalPost,
  encodeMessagePost,
  HttpCoordinator,
  TransportError,
} from "@abolishus/trustee-node";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  ceremonyFromEnv,
  createApiServer,
  MAX_CEREMONY_POST,
  type RequestLogLine,
} from "../src/index.ts";

// The seats' side of the coordinator over HTTP (P2-22 part 4c-2; ADR 0032,
// rule 5): seats built from crypto's round functions, talking to the API
// through apps/trustee-node's own `HttpCoordinator`, run whole ceremonies
// that crypto's `checkCeremonyTranscript` and `verifyCeremonyRegistration`
// judge. Refused posts change nothing and are answered by status (T-54);
// bodies are bounded and the ceremony has slots of its own (T-52); the
// request log names the route's template only (T-10).

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const ROUND_SECONDS = 120;

const address = (b: number) => new Uint8Array(20).fill(b);
const secret = (i: number) => {
  const d = new Uint8Array(32);
  d[0] = 0x42;
  d[31] = i;
  return d;
};
const SECRETS = [1, 2, 3].map(secret);
const PANEL: Panel = { threshold: 2, keys: SECRETS.map(identityKey) };
const ascending = (keys: Uint8Array[]) =>
  keys.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));

const DEPLOYMENT: PollStubDeployment = {
  l2ChainId: 84532n,
  l1ChainId: 11155111n,
  electionRegistry: address(0xa1),
  board: address(0xa2),
  trusteeRegistry: address(0xa3),
  groupRegistry: address(0xa4),
  l1Anchor: address(0xb1),
  l1Relay: address(0xb2),
  panel: PANEL,
  receiptKeys: ascending([identityKey(secret(9)), identityKey(secret(8))]),
  l1InclusionBound: 3600,
  sequencingWindow: 3600n,
  maxSequencerDrift: 1800n,
};

let db: TestDb;
let app: Sql;
let server: Server;
let base: string;
const logs: unknown[] = [];

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const closeServer = (s: Server) => new Promise((r) => s.close(r));

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  server = createApiServer({
    sql: app,
    log: (l) => logs.push(l),
    now: () => NOW_S,
    ceremony: { deployment: DEPLOYMENT },
  });
  base = await listen(server);
});
afterAll(async () => {
  await closeServer(server);
  await db?.close();
});
beforeEach(async () => {
  await db.admin`DELETE FROM ceremony_approvals`;
  await db.admin`DELETE FROM ceremony_messages`;
  await db.admin`DELETE FROM ceremony_runs`;
  await db.admin`DELETE FROM account_polls`;
  await db.admin`DELETE FROM ceremony_stubs`;
  logs.length = 0;
});

/** A poll the stub step moved to `ceremony`, with its run open; returns its stub's hash. */
async function opened(): Promise<Uint8Array> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const submittedAt = new Date(NOW.getTime() - 3600_000);
  const id = await createPollDraft(
    app,
    author,
    {
      language: "en",
      title: "Lunch",
      description: "",
      questions: [
        {
          question: "Which day?",
          description: "",
          options: [
            { label: "Friday", description: "" },
            { label: "Monday", description: "" },
          ],
          minSelections: 0,
          maxSelections: 1,
        },
      ],
      tiers: [0],
      closesAt: NOW_S + 7n * 24n * 3600n,
    },
    submittedAt,
  );
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: submittedAt,
  });
  const electorate = [
    {
      tier: 0,
      rootL2Block: "500",
      groups: [{ groupId: "1", region: 0 }],
      regions: ["3"],
      cells: [{ root: tierTreeRoot([11n, 12n, 13n]).toString(), members: "3" }],
    },
  ];
  await db.admin`
    UPDATE account_polls SET state = 'rooted', creator_address = ${address(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${randomBytes(32)}, created_block = 7,
      l1_origin_timestamp = 1, anchors_checked_block = 9,
      electorate = ${db.admin.json(electorate as never)}
    WHERE id = ${id}`;
  expect((await stubPolls(app, DEPLOYMENT, { now: NOW })).stubbed).toBe(1);
  expect((await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).opened).toBe(1);
  const [row] = await db.admin`SELECT stub_hash FROM account_polls WHERE id = ${id}`;
  return Uint8Array.from(row!["stub_hash"]);
}

const FIELDS = ["keys", "challenges", "answers", "reveals"] as const;
const EMPTY = { keys: [], challenges: [], answers: [], reveals: [] };

/**
 * One honest seat over HTTP, as apps/trustee-node's runs it but without its
 * store: fresh keys per run, one message per round over the rounds it is
 * shown, and an approval of a transcript that checks.
 */
class Seat {
  readonly index: number;
  readonly coordinator: HttpCoordinator;
  /** The last message or approval posted, as bytes, for replays. */
  last: { kind: "message" | "approval"; body: Uint8Array } | undefined;
  readonly #runs = new Map<string, { secrets: SeatSecrets; mus?: readonly Uint8Array[] }>();

  constructor(index: number) {
    this.index = index;
    this.coordinator = new HttpCoordinator(base);
  }

  /** Fetches the seat's requests and answers each; returns how many it answered. */
  async act(): Promise<number> {
    const requests = await this.coordinator.requests(this.index);
    for (const r of requests) {
      const stub = decodeElectionDefinitionV5(r.stub);
      const stubHash = electionStubV5Hash(stub);
      const t = decodeCeremonyTranscript(r.transcript, 1);
      const params: CeremonyParams = {
        l2ChainId: stub.l2_chain_id,
        trusteeRegistry: stub.trustee_registry,
        electionId: stub.election_id,
        stubHash,
        panel: PANEL,
        runId: t.run_id,
      };
      const key = Buffer.from(t.run_id).toString("hex");
      let run = this.#runs.get(key);
      if (run === undefined) {
        run = { secrets: ceremonyKeygen(this.index, SECRETS[this.index - 1]!) };
        this.#runs.set(key, run);
      }
      const open = FIELDS.findIndex((f) => t[f].length === 0);
      if (open === -1) {
        const { runId: _, ...election } = params;
        const check = checkCeremonyTranscript(election, r.transcript, 1);
        if (!check.ok) throw new Error("seat: the transcript doesn't check");
        const registration = {
          l2ChainId: params.l2ChainId,
          trusteeRegistry: params.trusteeRegistry,
          index: this.index,
          stubHash,
          ceremonyTranscriptHash: check.hash,
          keySetHash: keySetHash(check.registered.map(keySetEntry)),
        };
        const post = {
          stub_hash: stubHash,
          ceremony_transcript_hash: registration.ceremonyTranscriptHash,
          key_set_hash: registration.keySetHash,
          signature: signCeremonyRegistration(SECRETS[this.index - 1]!, PANEL, registration),
        };
        await this.coordinator.postApproval(this.index, post);
        this.last = { kind: "approval", body: encodeApprovalPost(post) };
        continue;
      }
      const message = this.#message(open, params, run, t);
      const transcript: CeremonyTranscript = {
        run_id: t.run_id,
        ...EMPTY,
        [FIELDS[open]!]: [message],
      };
      const post = { stub_hash: stubHash, transcript: encodeCeremonyTranscript(transcript) };
      await this.coordinator.postMessage(this.index, post);
      this.last = { kind: "message", body: encodeMessagePost(post) };
    }
    return requests.length;
  }

  #message(
    open: number,
    params: CeremonyParams,
    run: { secrets: SeatSecrets; mus?: readonly Uint8Array[] },
    t: CeremonyTranscript,
  ) {
    if (open === 0) return keysMessage(params, run.secrets);
    if (open === 1) {
      const c = challengesMessage(params, run.secrets, t.keys);
      run.mus = c.secrets;
      return c.message;
    }
    if (open === 2) return answersMessage(params, run.secrets, t.keys, t.challenges);
    return revealsMessage(params, run.secrets, t, run.mus ?? []);
  }
}

const runRow = async (stubHash: Uint8Array) => {
  const [r] = await db.admin`
    SELECT round, outcome FROM ceremony_runs WHERE stub_hash = ${stubHash}`;
  return r!;
};

const post = (path: string, body: Uint8Array, type = "application/octet-stream") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": type },
    body: body as Uint8Array<ArrayBuffer>,
  });

/** The approved run, judged by crypto alone. */
async function expectApproved(stubHash: Uint8Array, qualified: number[]) {
  const approved = await approvedCeremony(app, stubHash);
  expect(approved).toBeDefined();
  const { transcript, keySetHash: setHash, approvals } = approved!;
  const [stub] =
    await db.admin`SELECT election_id FROM ceremony_stubs WHERE stub_hash = ${stubHash}`;
  const check = checkCeremonyTranscript(
    {
      l2ChainId: DEPLOYMENT.l2ChainId,
      trusteeRegistry: DEPLOYMENT.trusteeRegistry,
      electionId: Uint8Array.from(stub!["election_id"]),
      stubHash,
      panel: PANEL,
    },
    transcript,
    1,
  );
  expect(check.ok).toBe(true);
  if (!check.ok) return;
  expect(check.registered.map((k) => k.index)).toEqual(qualified);
  expect(approvals.map((a) => a.seat)).toEqual(qualified);
  for (const a of approvals)
    expect(
      verifyCeremonyRegistration(
        PANEL,
        {
          l2ChainId: DEPLOYMENT.l2ChainId,
          trusteeRegistry: DEPLOYMENT.trusteeRegistry,
          index: a.seat,
          stubHash,
          ceremonyTranscriptHash: check.hash,
          keySetHash: setHash,
        },
        a.signature,
      ),
    ).toBe(true);
}

describe("a whole ceremony over HTTP", () => {
  test("relays every round between three seats' HttpCoordinators and ends approved by all three", async () => {
    const stubHash = await opened();
    const seats = [new Seat(1), new Seat(2), new Seat(3)];
    for (let round = 1; round <= 5; round++) {
      for (const s of seats) {
        expect(await s.act()).toBe(1);
        // A retry after a lost response is answered as the first post was,
        // while its round is open.
        if (s.index === 1) {
          const path = `/v1/ceremony/seats/1/${round === 5 ? "approvals" : "messages"}`;
          expect((await post(path, s.last!.body)).status).toBe(204);
        }
      }
      expect((await runRow(stubHash))["round"]).toBe(round + 1);
    }
    expect((await runRow(stubHash))["outcome"]).toBe("approved");
    await expectApproved(stubHash, [1, 2, 3]);
    // Nothing more is asked of anyone.
    for (const s of seats) expect(await s.act()).toBe(0);
    // Every line names a route's template, never the seat's index.
    const routes = new Set((logs as RequestLogLine[]).map((l) => l.route));
    expect(routes).toEqual(
      new Set([
        "GET /v1/ceremony/seats/{seat}/requests",
        "POST /v1/ceremony/seats/{seat}/messages",
        "POST /v1/ceremony/seats/{seat}/approvals",
      ]),
    );
  });

  test("a withheld seat costs one deadline, and the two left are approved under rule 7", async () => {
    const stubHash = await opened();
    const seats = [new Seat(1), new Seat(2)];
    for (const s of seats) await s.act();
    expect((await runRow(stubHash))["round"]).toBe(1);
    await closeCeremonyRounds(app, DEPLOYMENT, {
      now: new Date(NOW.getTime() + ROUND_SECONDS * 1000),
      roundSeconds: ROUND_SECONDS,
    });
    // Seat 3 is asked for nothing once round 1 has closed without it.
    expect(await new Seat(3).act()).toBe(0);
    for (let round = 2; round <= 5; round++) for (const s of seats) await s.act();
    expect((await runRow(stubHash))["outcome"]).toBe("approved");
    await expectApproved(stubHash, [1, 2]);
  });
});

describe("refusals", () => {
  test("another seat's message, a forged one and one after its round closed change nothing", async () => {
    const stubHash = await opened();
    const one = new Seat(1);
    await one.act();
    const body = one.last!.body;
    // Seat 1's message, posted as seat 2's: it doesn't fit as seat 2's.
    expect((await post("/v1/ceremony/seats/2/messages", body)).status).toBe(403);
    // The same message under a well-formed signature over another statement.
    const sent = decodeMessagePost(body);
    const t = decodeCeremonyTranscript(sent.transcript, 1);
    const [keys] = t.keys;
    const forged = encodeMessagePost({
      ...sent,
      transcript: encodeCeremonyTranscript({
        ...t,
        keys: [{ ...keys!, signature: keys!.signing_pop }],
      }),
    });
    expect((await post("/v1/ceremony/seats/1/messages", forged)).status).toBe(403);
    // Seat 1's own retry is answered as its first post was.
    expect((await post("/v1/ceremony/seats/1/messages", body)).status).toBe(204);
    await new Seat(2).act();
    await new Seat(3).act();
    expect((await runRow(stubHash))["round"]).toBe(2);
    // Round 1 has closed: its message doesn't fit round 2, and no run of
    // this stub takes approvals yet.
    expect((await post("/v1/ceremony/seats/1/messages", body)).status).toBe(403);
    const approval = encodeApprovalPost({
      stub_hash: stubHash,
      ceremony_transcript_hash: new Uint8Array(32),
      key_set_hash: new Uint8Array(32),
      signature: keys!.signing_pop,
    });
    expect((await post("/v1/ceremony/seats/1/approvals", approval)).status).toBe(409);
    const [{ count }] = (await db.admin`SELECT count(*)::int AS count FROM ceremony_messages`) as [
      { count: number },
    ];
    expect(count).toBe(3);
    // The node's client sees a refusal as a transport error, and asks again.
    await expect(
      one.coordinator.postMessage(2, {
        stub_hash: stubHash,
        transcript: encodeCeremonyTranscript({ run_id: new Uint8Array(32), ...EMPTY }),
      }),
    ).rejects.toThrow(TransportError);
  });

  test("bodies with no decoding, of another type or past the bound are refused unread", async () => {
    await opened();
    expect((await post("/v1/ceremony/seats/1/messages", Uint8Array.of(1, 2, 3))).status).toBe(400);
    expect((await post("/v1/ceremony/seats/1/approvals", new Uint8Array(32))).status).toBe(400);
    const json = await post(
      "/v1/ceremony/seats/1/messages",
      Uint8Array.of(0x7b),
      "application/json",
    );
    expect(json.status).toBe(415);
    expect(
      (await post("/v1/ceremony/seats/1/messages", new Uint8Array(MAX_CEREMONY_POST + 1))).status,
    ).toBe(413);
    // A GET carries no body (fetch won't send one, so node's client does).
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/v1/ceremony/seats/1/requests`, {
        method: "GET",
        headers: { "content-type": "application/octet-stream", "content-length": "1" },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end("x");
    });
    expect(status).toBe(400);
  });

  test("a seat outside the path's form, another method or a query matches no route", async () => {
    for (const path of [
      "/v1/ceremony/seats/0/requests",
      "/v1/ceremony/seats/01/requests",
      "/v1/ceremony/seats/100/requests",
      "/v1/ceremony/seats/x/requests",
      "/v1/ceremony/seats/1/requests?x=1",
      "/v1/ceremony/seats/1/other",
    ])
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    expect((await post("/v1/ceremony/seats/1/requests", new Uint8Array())).status).toBe(404);
    expect((await fetch(`${base}/v1/ceremony/seats/1/messages`)).status).toBe(404);
    // A seat past the panel's size is asked for nothing.
    expect(
      new Uint8Array(await (await fetch(`${base}/v1/ceremony/seats/9/requests`)).arrayBuffer()),
    ).toEqual(new Uint8Array(4));
  });

  test("a request carrying an account credential is refused", async () => {
    const res = await fetch(`${base}/v1/ceremony/seats/1/requests`, {
      headers: { cookie: `${ACCOUNT_COOKIE_PREFIX}.session_token=x` },
    });
    expect(res.status).toBe(400);
  });

  test("without a coordinator configured the routes answer 503", async () => {
    const bare = createApiServer({ sql: app, log: () => {} });
    const url = await listen(bare);
    try {
      expect((await fetch(`${url}/v1/ceremony/seats/1/requests`)).status).toBe(503);
    } finally {
      await closeServer(bare);
    }
  });

  test("the ceremony's slots are its own: past them a request is refused, and the rest of the API still answers", async () => {
    const limited = createApiServer({
      sql: app,
      log: () => {},
      ceremony: { deployment: DEPLOYMENT, maxInFlight: 1 },
    });
    const url = await listen(limited);
    try {
      // A post whose body never finishes holds the one slot.
      const held = request(`${url}/v1/ceremony/seats/1/messages`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": "100" },
      });
      held.on("error", () => {});
      held.write(new Uint8Array(10));
      await new Promise((r) => setTimeout(r, 100));
      expect((await fetch(`${url}/v1/ceremony/seats/2/requests`)).status).toBe(503);
      expect(
        (await fetch(`${url}/elections/definition?electionId=${"00".repeat(32)}`)).status,
      ).not.toBe(503);
      held.destroy();
    } finally {
      await closeServer(limited);
    }
  });
});

describe("the coordinator's environment", () => {
  const keys = SECRETS.map((s) => Buffer.from(identityKey(s)).toString("hex")).join(",");
  const full = {
    API_CEREMONY_PANEL_THRESHOLD: "2",
    API_CEREMONY_PANEL_KEYS: keys,
    API_CEREMONY_L2_CHAIN_ID: "84532",
    API_CEREMONY_TRUSTEE_REGISTRY: `0x${"a3".repeat(20)}`,
  };

  test("is all or nothing, and gives the deployment the seats sign under", () => {
    expect(ceremonyFromEnv({})).toBeUndefined();
    expect(ceremonyFromEnv(full)).toEqual({
      panel: PANEL,
      l2ChainId: 84532n,
      trusteeRegistry: address(0xa3),
    });
    expect(() => ceremonyFromEnv({ API_CEREMONY_PANEL_THRESHOLD: "2" })).toThrow("every one");
  });

  test("refuses malformed values and a threshold or keys that aren't a panel, naming the variable", () => {
    for (const [name, value] of [
      ["API_CEREMONY_PANEL_THRESHOLD", "02"],
      ["API_CEREMONY_PANEL_KEYS", `${keys},`],
      ["API_CEREMONY_L2_CHAIN_ID", "0"],
      ["API_CEREMONY_L2_CHAIN_ID", "18446744073709551616"],
      ["API_CEREMONY_TRUSTEE_REGISTRY", "0xa3"],
    ] as const)
      expect(() => ceremonyFromEnv({ ...full, [name]: value }), `${name}=${value}`).toThrow(name);
    expect(() => ceremonyFromEnv({ ...full, API_CEREMONY_PANEL_THRESHOLD: "4" })).toThrow(
      "aren't a panel",
    );
    const repeated = [keys.split(",")[0], keys.split(",")[0], keys.split(",")[1]].join(",");
    expect(() => ceremonyFromEnv({ ...full, API_CEREMONY_PANEL_KEYS: repeated })).toThrow(
      "aren't a panel",
    );
  });
});
