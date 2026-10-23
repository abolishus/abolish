import { runInNewContext } from "node:vm";

import fc from "fast-check";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  CACHE_PREFIX,
  OFFLINE_PATH,
  type OfflineWorkerConfig,
  offlineWorkerConfig,
  offlineWorkerSource,
  registerOfflineShell,
  WORKER_PATH,
} from "../src/app/offline.ts";

// The offline shell's worker (src/app/offline.ts), run as the text `/sw.js`
// serves, in a context of its own with a stand-in for its global scope: that
// it keeps the offline page and nothing a visitor opens, shows that page only
// when a page can't be fetched, and leaves every other request alone.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const ORIGIN = "https://abolish.test";
const STYLESHEET = "/assets/styles-CV1SuR5e.css";
const FONTS = [
  "/assets/oxanium-latin-wght-normal-BwpvAp5U.woff2",
  "/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2",
];
const CSS = [
  `@font-face{src:url(${FONTS[0]}) format("woff2")}`,
  `@font-face{src:url(${FONTS[1]}) format("woff2")}`,
  // Named twice, kept once; anything not one of our fonts is never fetched.
  `@font-face{src:url(${FONTS[0]}) format("woff2")}`,
  `.a{background:url(data:image/svg+xml;base64,AAAA)}`,
  `.b{background:url(https://elsewhere.test/x.woff2)}`,
  `.c{background:url(/assets/../secret.woff2)}`,
].join("");
const PAGE = "<!doctype html><title>You're offline</title>";
const NOTICE = {
  title: "A moderation decision",
  body: "Open your account page to see it.",
  icon: "/icons/icon-192.png",
  open: "/account",
};
const CONFIG: OfflineWorkerConfig = {
  cache: `${CACHE_PREFIX}00112233445566778899aabbccddeeff`,
  offline: OFFLINE_PATH,
  stylesheet: STYLESHEET,
  notice: NOTICE,
};

type Listener = (event: never) => void;

/** A cache: path to a stored answer. */
class FakeCache {
  readonly entries = new Map<string, Response>();
  constructor(private readonly fetch: (path: string) => Promise<Response>) {}
  async addAll(paths: string[]) {
    const answers = await Promise.all(paths.map((p) => this.fetch(p)));
    if (answers.some((a) => !a.ok)) throw new TypeError("addAll: a response wasn't ok");
    paths.forEach((p, i) => this.entries.set(p, answers[i]!));
  }
  async match(path: string) {
    return this.entries.get(path)?.clone();
  }
}

/** A worker's scope: its listeners, its caches, and a network that answers from `site`. */
function scope(site: Record<string, string> = {}) {
  const listeners = new Map<string, Listener>();
  const fetched: string[] = [];
  let online = true;
  const network = async (target: Request | string) => {
    const url = new URL(typeof target === "string" ? target : target.url, ORIGIN);
    fetched.push(url.pathname + url.search);
    if (!online) throw new TypeError("Failed to fetch");
    const body = site[url.pathname];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200 });
  };
  const caches = new Map<string, FakeCache>();
  const self = {
    location: { origin: ORIGIN },
    caches: {
      open: async (name: string) => {
        let cache = caches.get(name);
        if (cache === undefined) caches.set(name, (cache = new FakeCache(network)));
        return cache;
      },
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
      has: async (name: string) => caches.has(name),
    },
    registration: {
      navigationPreload: { enable: vi.fn(async () => {}) },
      showNotification: vi.fn(async (_title: string, _options: object) => {}),
    },
    clients: { claim: vi.fn(async () => {}), openWindow: vi.fn(async (_url: string) => null) },
    fetch: network,
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  // As a browser runs it: the served text in a context with nothing of ours.
  runInNewContext(offlineWorkerSource(CONFIG), { self, URL, Response });

  /** Dispatches an extendable event and waits for the work it hands over. */
  async function extend(type: "install" | "activate" | "push" | "notificationclick", extra = {}) {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...extra, waitUntil: (p: Promise<unknown>) => (work = p) } as never);
    await work;
  }

  /** Dispatches a fetch: the worker's answer, or undefined where it leaves the request alone. */
  async function request(
    url: string,
    init: { method?: string; mode?: string; destination?: string; preload?: Response } = {},
  ): Promise<Response | undefined> {
    const request = {
      url: new URL(url, ORIGIN).href,
      method: init.method ?? "GET",
      mode: init.mode ?? "no-cors",
      destination: init.destination ?? "",
    } as Request;
    let answer: Promise<Response> | undefined;
    listeners.get("fetch")!({
      request,
      preloadResponse: Promise.resolve(init.preload),
      respondWith: (p: Promise<Response>) => (answer = p),
    } as never);
    return answer;
  }

  const page = (url: string, preload?: Response) =>
    request(url, {
      mode: "navigate",
      destination: "document",
      ...(preload === undefined ? {} : { preload }),
    });

  return {
    self,
    caches,
    fetched,
    extend,
    request,
    page,
    online: (now: boolean) => void (online = now),
  };
}

const SITE = { [OFFLINE_PATH]: PAGE, [STYLESHEET]: CSS, [FONTS[0]!]: "f0", [FONTS[1]!]: "f1" };

/** A worker that has installed and activated against `SITE`. */
async function installed() {
  const s = scope({ ...SITE, "/discover": "<p>discover</p>" });
  await s.extend("install");
  await s.extend("activate");
  s.fetched.length = 0;
  return s;
}

describe("the offline shell's worker", () => {
  test("keeps the offline page, its stylesheet and the fonts it names, and nothing else", async () => {
    const s = scope(SITE);
    await s.extend("install");
    expect([...s.caches.keys()]).toEqual([CONFIG.cache]);
    expect([...s.caches.get(CONFIG.cache)!.entries.keys()].sort()).toEqual(
      [OFFLINE_PATH, STYLESHEET, ...FONTS].sort(),
    );
    // Never another origin's file, a data: URL or a path out of /assets/.
    expect(s.fetched.sort()).toEqual([OFFLINE_PATH, STYLESHEET, ...FONTS].sort());
    expect(s.self.skipWaiting).toHaveBeenCalledOnce();
  });

  test("fails to install, to be tried again, when any file can't be fetched", async () => {
    const { [FONTS[1]!]: _, ...missing } = SITE;
    const s = scope(missing);
    await expect(s.extend("install")).rejects.toThrow(TypeError);
    expect(s.self.skipWaiting).not.toHaveBeenCalled();
    const down = scope(SITE);
    down.online(false);
    await expect(down.extend("install")).rejects.toThrow();
  });

  test("on taking over, drops its older caches and no one else's", async () => {
    const s = scope(SITE);
    await s.self.caches.open(`${CACHE_PREFIX}old`);
    await s.self.caches.open("someone-else");
    await s.extend("install");
    await s.extend("activate");
    expect([...s.caches.keys()].sort()).toEqual([CONFIG.cache, "someone-else"].sort());
    expect(s.self.registration.navigationPreload.enable).toHaveBeenCalledOnce();
    expect(s.self.clients.claim).toHaveBeenCalledOnce();
  });

  test("passes every page through from the network, a server's error page included", async () => {
    const s = await installed();
    expect(await (await s.page("/discover?q=ferry"))!.text()).toBe("<p>discover</p>");
    const missing = (await s.page("/nowhere"))!;
    expect([missing.status, await missing.text()]).toEqual([404, "missing"]);
    expect(s.fetched).toEqual(["/discover?q=ferry", "/nowhere"]);
    // The browser's own early fetch, when it made one, is the answer.
    const preloaded = new Response("preloaded");
    expect(await s.page("/polls", preloaded)).toBe(preloaded);
    expect(s.fetched).toHaveLength(2);
  });

  test("shows the offline page when a page can't be fetched", async () => {
    const s = await installed();
    s.online(false);
    const answer = (await s.page("/polls/ab?after=3"))!;
    expect([answer.status, await answer.text()]).toEqual([200, PAGE]);
    // Its stylesheet and fonts come from the cache.
    expect(await (await s.request(STYLESHEET))!.text()).toBe(CSS);
    expect(await (await s.request(FONTS[1]!))!.text()).toBe("f1");
    expect(s.fetched).toEqual(["/polls/ab?after=3"]);
  });

  test("gives the browser's own failure when it has no offline page yet", async () => {
    const s = scope(SITE);
    s.online(false);
    const answer = (await s.page("/discover"))!;
    expect(answer.type).toBe("error");
  });

  test("leaves frames, posts, other origins and every other file to the browser", async () => {
    const s = await installed();
    s.online(false);
    // Another site's embed of a poll: the offline page refuses framing anyway.
    expect(await s.request("/embed/p/abc", { mode: "navigate", destination: "iframe" })).toBe(
      undefined,
    );
    expect(await s.request("/account", { method: "POST", mode: "navigate" })).toBe(undefined);
    expect(
      await s.request("https://elsewhere.test/", { mode: "navigate", destination: "document" }),
    ).toBe(undefined);
    for (const path of ["/assets/index-AbC.js", `${STYLESHEET}?v=1`, "/_serverFn/x", "/sw.js"])
      expect(await s.request(path), path).toBe(undefined);
    expect(s.fetched).toEqual([]);
  });

  test("fetches a font it doesn't hold, and keeps nothing it fetches", async () => {
    const s = await installed();
    const other = "/assets/oxanium-greek-wght-normal-Zz9.woff2";
    expect((await s.request(other))!.status).toBe(404);
    expect(s.fetched).toEqual([other]);
    // Offline it fails as the network does, which the browser reports as its own error.
    s.online(false);
    await expect(s.request(other)).rejects.toThrow("Failed to fetch");
  });

  test("never stores what a visitor opens or fetches", async () => {
    const s = await installed();
    const kept = () => [...s.caches.get(CONFIG.cache)!.entries.keys()].sort();
    const before = kept();
    const path = fc
      .array(fc.constantFrom("a", "polls", "assets", "x.woff2", "account", "..", "offline"), {
        maxLength: 4,
      })
      .map((parts) => `/${parts.join("/")}`);
    await fc.assert(
      fc.asyncProperty(
        path,
        fc.constantFrom("GET", "HEAD", "POST"),
        fc.constantFrom("navigate", "no-cors", "cors", "same-origin"),
        fc.constantFrom("document", "iframe", "font", "style", ""),
        fc.boolean(),
        async (p, method, mode, destination, online) => {
          s.online(online);
          // A rejected answer is the browser's own network error, and only a
          // font it doesn't hold, fetched while offline, may get one.
          const answer = await s
            .request(p, { method, mode, destination })
            .catch((error: unknown) => {
              expect(!online && mode !== "navigate" && p.endsWith(".woff2")).toBe(true);
              expect(error).toEqual(new TypeError("Failed to fetch"));
              return Response.error();
            });
          // It answers only a page opened in a tab, or a file it keeps.
          if (answer !== undefined)
            expect(
              (method === "GET" && mode === "navigate" && destination === "document") ||
                before.includes(p) ||
                p.endsWith(".woff2"),
            ).toBe(true);
          expect(kept()).toEqual(before);
          expect([...s.caches.keys()]).toEqual([CONFIG.cache]);
        },
      ),
      runs,
    );
  });

  test("runs as served, with nothing from the module around it", () => {
    const source = offlineWorkerSource(CONFIG);
    expect(source.startsWith('"use strict";\n(')).toBe(true);
    expect(source).toContain(JSON.stringify(CONFIG));
    // The literal prefix inside the worker is the module's.
    expect(source).toContain(JSON.stringify(CACHE_PREFIX));
  });
});

describe("web push's notice", () => {
  test("a push shows the one fixed notice, whatever it carries, and fetches nothing", async () => {
    const s = await installed();
    // A push from anyone holding the VAPID key could carry data: it is never read (T-76).
    const data = { text: () => "Your poll was removed", json: () => ({ title: "x" }) };
    await s.extend("push", { data });
    await s.extend("push", { data: null });
    expect(s.self.registration.showNotification.mock.calls).toEqual([
      [NOTICE.title, { body: NOTICE.body, icon: NOTICE.icon, tag: "notice" }],
      [NOTICE.title, { body: NOTICE.body, icon: NOTICE.icon, tag: "notice" }],
    ]);
    expect(s.fetched).toEqual([]);
  });

  test("a click closes the notice and opens the account page", async () => {
    const s = await installed();
    const close = vi.fn();
    await s.extend("notificationclick", { notification: { close } });
    expect(close).toHaveBeenCalledOnce();
    expect(s.self.clients.openWindow.mock.calls).toEqual([["/account"]]);
  });
});

describe("the worker's configuration", () => {
  test("names its cache by the offline page's hash, so a changed page installs again", async () => {
    const a = await offlineWorkerConfig(PAGE, STYLESHEET, NOTICE);
    expect(a).toEqual({
      cache: expect.stringMatching(new RegExp(`^${CACHE_PREFIX}[0-9a-f]{32}$`)),
      offline: OFFLINE_PATH,
      stylesheet: STYLESHEET,
      notice: NOTICE,
    });
    expect(await offlineWorkerConfig(PAGE, STYLESHEET, NOTICE)).toEqual(a);
    await fc.assert(
      fc.asyncProperty(fc.string(), async (extra) => {
        fc.pre(extra !== "");
        expect((await offlineWorkerConfig(PAGE + extra, STYLESHEET, NOTICE)).cache).not.toBe(
          a.cache,
        );
      }),
      runs,
    );
  });
});

describe("registering the worker", () => {
  test("registers /sw.js for the whole site, always asking the server for it afresh", () => {
    const register = vi.fn(async () => ({}));
    registerOfflineShell({ serviceWorker: { register } } as unknown as Navigator);
    expect(register).toHaveBeenCalledWith(WORKER_PATH, { scope: "/", updateViaCache: "none" });
  });

  test("leaves the site as it is where a browser has no workers or refuses one", async () => {
    expect(() => registerOfflineShell({} as Navigator)).not.toThrow();
    const refused = Promise.reject(new DOMException("denied", "SecurityError"));
    registerOfflineShell({ serviceWorker: { register: () => refused } } as unknown as Navigator);
    await expect(refused).rejects.toThrow();
  });
});
