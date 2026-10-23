import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { WORKER_PATH } from "../src/app/offline.ts";
import { createPushClient, PushError, type PushPlatform } from "../src/account/push.ts";

// The account page's push switch (src/account/push.ts) against stand-ins
// for the browser and the push handler: what it sends, that only the
// endpoint leaves the page (T-10, T-76), and how it reads each answer.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const KEY = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
const OLD_KEY = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : 255 - i));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc:APA91b";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly init: RequestInit;
}

/** A subscription its push service holds, until `unsubscribe`. */
class FakeSubscription {
  ended = false;
  constructor(
    readonly endpoint: string,
    readonly key: Uint8Array,
  ) {}
  get options() {
    return { applicationServerKey: this.key.slice().buffer, userVisibleOnly: true };
  }
  async unsubscribe() {
    this.ended = true;
    return true;
  }
}

interface Setup {
  /** The handler's answer to each path, by default a plain success. */
  readonly answers?: Record<string, { status: number; body: unknown } | "network">;
  readonly permission?: NotificationPermission;
  /** What the prompt answers. */
  readonly prompt?: NotificationPermission;
  readonly existing?: FakeSubscription;
  readonly registered?: boolean;
  readonly pushManager?: boolean;
  readonly notification?: boolean;
  readonly serviceWorker?: boolean;
}

function browser(setup: Setup = {}) {
  const calls: Call[] = [];
  const registered: [string, unknown][] = [];
  const subscribed: unknown[] = [];
  const prompted: number[] = [];
  let subscription: FakeSubscription | null = setup.existing ?? null;
  let hasRegistration = setup.registered ?? true;
  const pushManager = {
    getSubscription: async () =>
      subscription === null || subscription.ended ? null : subscription,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      subscribed.push(options);
      subscription = new FakeSubscription(ENDPOINT, new Uint8Array(options.applicationServerKey));
      return subscription;
    },
  };
  const registration = { pushManager };
  const serviceWorker = {
    getRegistration: async (scope: string) => {
      expect(scope).toBe("/");
      return hasRegistration ? registration : undefined;
    },
    register: async (path: string, options: unknown) => {
      registered.push([path, options]);
      hasRegistration = true;
      return registration;
    },
    get ready() {
      return Promise.resolve(registration);
    },
  };
  const answers = setup.answers ?? {};
  const platform: PushPlatform = {
    navigator: (setup.serviceWorker === false ? {} : { serviceWorker }) as unknown as Navigator,
    notification:
      setup.notification === false
        ? undefined
        : ({
            permission: setup.permission ?? "default",
            requestPermission: async () => {
              prompted.push(1);
              return setup.prompt ?? "granted";
            },
          } as unknown as typeof Notification),
    pushManager: setup.pushManager ?? true,
    fetch: async (input, init = {}) => {
      // The client passes a path, always.
      const path = input as string;
      calls.push({
        method: init.method ?? "GET",
        path,
        ...(init.body === undefined ? {} : { body: JSON.parse(init.body as string) }),
        init,
      });
      const answer = answers[path];
      if (answer === "network") throw new TypeError("Failed to fetch");
      if (answer !== undefined) return Response.json(answer.body, { status: answer.status });
      if (path === "/push/key") return Response.json({ key: b64(KEY) });
      if (path === "/push/status") return Response.json({ subscribed: true });
      return Response.json({});
    },
  };
  return {
    client: createPushClient(platform),
    calls,
    registered,
    subscribed,
    prompted,
    current: () => subscription,
  };
}

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (e) {
    if (e instanceof PushError) return e.failure;
    throw e;
  }
  throw new Error("no failure");
};

describe("the switch's state", () => {
  test("a browser without workers, push or notifications is unsupported, asking nothing", async () => {
    for (const missing of [
      { serviceWorker: false },
      { pushManager: false },
      { notification: false },
    ]) {
      const b = browser(missing);
      expect(await b.client.state()).toBe("unsupported");
      expect(b.calls).toEqual([]);
    }
  });

  test("a deployment without push is unavailable", async () => {
    const b = browser({
      answers: { "/push/key": { status: 503, body: { code: "UNAVAILABLE", status: 503 } } },
    });
    expect(await b.client.state()).toBe("unavailable");
  });

  test("blocked notifications are denied, and nothing is subscribed", async () => {
    const b = browser({ permission: "denied" });
    expect(await b.client.state()).toBe("denied");
    expect(b.calls.map((c) => c.path)).toEqual(["/push/key"]);
  });

  test("no subscription, or one under an old key, is off without asking the server", async () => {
    expect(await browser().client.state()).toBe("off");
    const b = browser({ existing: new FakeSubscription(ENDPOINT, OLD_KEY) });
    expect(await b.client.state()).toBe("off");
    expect(b.calls.map((c) => c.path)).toEqual(["/push/key"]);
  });

  test("a subscription is on only if the server says it is this account's", async () => {
    const mine = browser({ existing: new FakeSubscription(ENDPOINT, KEY) });
    expect(await mine.client.state()).toBe("on");
    expect(mine.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/push/status",
      body: { endpoint: ENDPOINT },
    });
    // Another account's on a shared device (T-10).
    const theirs = browser({
      existing: new FakeSubscription(ENDPOINT, KEY),
      answers: { "/push/status": { status: 200, body: { subscribed: false } } },
    });
    expect(await theirs.client.state()).toBe("off");
  });

  test("a malformed key, an outage and a lost session are failures", async () => {
    for (const key of ["", "short", `${b64(KEY)}=`, b64(KEY).replace("A", "+"), 7])
      expect(
        await failure(
          browser({ answers: { "/push/key": { status: 200, body: { key } } } }).client.state(),
        ),
      ).toBe("failed");
    expect(await failure(browser({ answers: { "/push/key": "network" } }).client.state())).toBe(
      "failed",
    );
    expect(
      await failure(
        browser({
          existing: new FakeSubscription(ENDPOINT, KEY),
          answers: { "/push/status": { status: 401, body: { code: "SIGNED_OUT", status: 401 } } },
        }).client.state(),
      ),
    ).toBe("signedOut");
  });
});

describe("turning it on", () => {
  test("asks, subscribes with our key for visible notices, and sends only the endpoint", async () => {
    const b = browser();
    await b.client.enable();
    expect(b.prompted).toHaveLength(1);
    expect(b.subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: KEY }]);
    const sent = b.calls.find((c) => c.path === "/push/subscribe")!;
    // T-76: the subscription's keys never leave the page; T-10: no account is named.
    expect(sent.body).toEqual({ endpoint: ENDPOINT });
    expect(sent.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "content-type": "application/json" },
    });
  });

  test("registers the site's own worker when the page hasn't", async () => {
    const b = browser({ registered: false });
    await b.client.enable();
    expect(b.registered).toEqual([[WORKER_PATH, { scope: "/", updateViaCache: "none" }]]);
  });

  test("keeps a subscription under our key, and replaces one under an old key", async () => {
    const same = new FakeSubscription(ENDPOINT, KEY);
    const a = browser({ existing: same });
    await a.client.enable();
    expect(a.subscribed).toEqual([]);
    expect(same.ended).toBe(false);
    const old = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", OLD_KEY);
    const b = browser({ existing: old });
    await b.client.enable();
    expect(old.ended).toBe(true);
    expect(b.subscribed).toHaveLength(1);
    // The old one's row goes first, so it holds none of the account's places.
    expect(b.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      ["/push/unsubscribe", { endpoint: old.endpoint }],
      ["/push/subscribe", { endpoint: ENDPOINT }],
    ]);
  });

  test("another account's subscription on a shared device moves to this one", async () => {
    const theirs = new FakeSubscription(ENDPOINT, KEY);
    const b = browser({
      existing: theirs,
      answers: { "/push/status": { status: 200, body: { subscribed: false } } },
    });
    expect(await b.client.state()).toBe("off");
    await b.client.enable();
    // One browser, one subscription: it now wakes for this account alone.
    expect(b.subscribed).toEqual([]);
    expect(theirs.ended).toBe(false);
    expect(b.calls.at(-1)).toMatchObject({ path: "/push/subscribe", body: { endpoint: ENDPOINT } });
  });

  test("a refused prompt is denied, and nothing is subscribed or sent", async () => {
    for (const prompt of ["denied", "default"] as const) {
      const b = browser({ prompt });
      expect(await failure(b.client.enable())).toBe("denied");
      expect(b.subscribed).toEqual([]);
      expect(b.calls.map((c) => c.path)).toEqual(["/push/key"]);
    }
  });

  test("a subscription the server won't keep is ended, so it is never left unwakeable", async () => {
    for (const [answer, why] of [
      [{ status: 400, body: { code: "INVALID_ENDPOINT", status: 400 } }, "service"],
      [{ status: 401, body: { code: "SIGNED_OUT", status: 401 } }, "signedOut"],
      [{ status: 500, body: {} }, "failed"],
      ["network", "failed"],
    ] as const) {
      const b = browser({ answers: { "/push/subscribe": answer } });
      expect(await failure(b.client.enable())).toBe(why);
      expect(b.current()?.ended).toBe(true);
    }
  });

  test("on a deployment without push, nothing is asked", async () => {
    const b = browser({
      answers: { "/push/key": { status: 503, body: { code: "UNAVAILABLE", status: 503 } } },
    });
    expect(await failure(b.client.enable())).toBe("failed");
    expect(b.prompted).toEqual([]);
  });
});

describe("turning it off", () => {
  test("tells the server, then ends the subscription", async () => {
    const existing = new FakeSubscription(ENDPOINT, KEY);
    const b = browser({ existing });
    await b.client.disable();
    expect(b.calls.at(-1)).toMatchObject({
      path: "/push/unsubscribe",
      body: { endpoint: ENDPOINT },
    });
    expect(existing.ended).toBe(true);
  });

  test("ends the subscription even when the server fails, and says so", async () => {
    const existing = new FakeSubscription(ENDPOINT, KEY);
    const b = browser({ existing, answers: { "/push/unsubscribe": "network" } });
    expect(await failure(b.client.disable())).toBe("failed");
    expect(existing.ended).toBe(true);
  });

  test("with no subscription, nothing is sent", async () => {
    const b = browser();
    await b.client.disable();
    expect(b.calls).toEqual([]);
  });
});

test("any refusal's code or status maps to a failure, never a success", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 400, max: 599 }),
      fc.oneof(
        fc.constantFrom("SIGNED_OUT", "INVALID_ENDPOINT", "UNAVAILABLE", "BAD_REQUEST"),
        fc.string(),
      ),
      async (status, code) => {
        const b = browser({ answers: { "/push/subscribe": { status, body: { code, status } } } });
        const why = await failure(b.client.enable());
        expect(why).toBe(
          code === "SIGNED_OUT" ? "signedOut" : code === "INVALID_ENDPOINT" ? "service" : "failed",
        );
      },
    ),
    runs,
  );
});
