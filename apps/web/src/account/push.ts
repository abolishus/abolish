// The account page's web push switch (P2-27 part 4b): subscribes this
// browser with its push service and hands the endpoint to the push handler
// on our own origin (src/node/push.ts, /push), or takes it back. The session
// cookie goes only because the calls are same-origin; the handler names the
// account from it, and nothing here names one (T-10).
//
// T-76: only the endpoint leaves the page. The browser makes the
// subscription's encryption keys, but pushes carry no payload, so they are
// never sent; and the subscription is `userVisibleOnly`, as browsers
// require: every push shows the worker's fixed notice (src/app/offline.ts). The worker is the offline
// shell's, `/sw.js`, the only one this site may register.

import { WORKER_PATH } from "../app/offline.ts";

/** What the switch can show for this browser. */
export type PushState =
  /** The browser has no service workers, push or notifications. */
  | "unsupported"
  /** This deployment doesn't push. */
  | "unavailable"
  /** The browser blocks notifications from this site: only its settings can change that. */
  | "denied"
  | "off"
  | "on";

/** Why a change didn't happen. */
export type PushFailure =
  /** The session ended: sign in again. */
  | "signedOut"
  /** The browser, or the person, refused notifications. */
  | "denied"
  /** The browser's push service isn't one our server sends through (T-76). */
  | "service"
  /** The server, the browser or the network failed. */
  | "failed";

export class PushError extends Error {
  readonly failure: PushFailure;
  constructor(failure: PushFailure) {
    super(`push ${failure}`);
    this.name = "PushError";
    this.failure = failure;
  }
}

/** Every call the page makes, so it can be shown with stand-ins (stories, tests). */
export interface PushClient {
  /** Whether this browser is subscribed for the signed-in account. */
  state(): Promise<PushState>;
  /** Asks for notifications, subscribes this browser and keeps it for the account. */
  enable(): Promise<void>;
  /** Takes this browser's subscription away, here and with its push service. */
  disable(): Promise<void>;
}

/** What the client uses of the page's globals, so tests can hand in stand-ins. */
export interface PushPlatform {
  readonly navigator: Navigator;
  /** The page's `Notification`, or undefined where there is none. */
  readonly notification: Pick<typeof Notification, "permission" | "requestPermission"> | undefined;
  /** Whether the page has `PushManager`: an iPhone's Safari has it only in a home-screen app. */
  readonly pushManager: boolean;
  readonly fetch: typeof globalThis.fetch;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const KEY = /^[A-Za-z0-9_-]{87}$/;

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  a != null && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

/** The client for this origin's push handler, on `platform`. */
export function createPushClient(platform: PushPlatform): PushClient {
  const { navigator, notification } = platform;

  const supported = (): boolean =>
    notification !== undefined && platform.pushManager && "serviceWorker" in navigator;

  /** The handler's answer, or undefined for `UNAVAILABLE` (this deployment doesn't push). */
  async function call(
    method: "GET" | "POST",
    path: string,
    body?: object,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await platform
      .fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(body === undefined
          ? {}
          : // Exactly this type, with no charset: the handler refuses anything else.
            { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      })
      .catch(() => {
        throw new PushError("failed");
      });
    const answer: unknown = await response.json().catch(() => undefined);
    if (response.ok && isObject(answer)) return answer;
    const code = isObject(answer) ? answer["code"] : undefined;
    if (code === "SIGNED_OUT") throw new PushError("signedOut");
    if (code === "INVALID_ENDPOINT") throw new PushError("service");
    if (code === "UNAVAILABLE" && response.status === 503) return undefined;
    throw new PushError("failed");
  }

  /** A change the handler must have made: unavailable is a failure here. */
  async function change(path: string, endpoint: string): Promise<void> {
    if ((await call("POST", path, { endpoint })) === undefined) throw new PushError("failed");
  }

  /** The server's public key, or undefined where this deployment doesn't push. */
  async function serverKey(): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const answer = await call("GET", "/push/key");
    if (answer === undefined) return undefined;
    const key = answer["key"];
    if (typeof key !== "string" || !KEY.test(key)) throw new PushError("failed");
    return fromBase64Url(key);
  }

  /** The worker's registration, registering it where the page hasn't yet. */
  async function registration(): Promise<ServiceWorkerRegistration> {
    const { serviceWorker } = navigator;
    try {
      if ((await serviceWorker.getRegistration("/")) === undefined)
        await serviceWorker.register(WORKER_PATH, { scope: "/", updateViaCache: "none" });
      // Pushing needs an active worker: `ready` waits for it.
      return await serviceWorker.ready;
    } catch {
      throw new PushError("failed");
    }
  }

  /** This browser's subscription, if it has one. */
  async function current(): Promise<PushSubscription | null> {
    const found = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
    return (await found?.pushManager.getSubscription().catch(() => null)) ?? null;
  }

  return {
    async state() {
      if (!supported()) return "unsupported";
      const key = await serverKey();
      if (key === undefined) return "unavailable";
      if (notification?.permission === "denied") return "denied";
      const subscription = await current();
      // A subscription under an old key can't be woken any more: it is off
      // until the switch subscribes this browser again.
      if (subscription === null || !sameBytes(subscription.options.applicationServerKey, key))
        return "off";
      const answer = await call("POST", "/push/status", { endpoint: subscription.endpoint });
      return answer?.["subscribed"] === true ? "on" : "off";
    },

    async enable() {
      if (notification === undefined || !supported()) throw new PushError("failed");
      const key = await serverKey();
      if (key === undefined) throw new PushError("failed");
      const permission = await notification.requestPermission().catch(() => "denied");
      if (permission !== "granted") throw new PushError("denied");
      const { pushManager } = await registration();
      let subscription = await pushManager.getSubscription().catch(() => null);
      let made = false;
      // One under an old key can't be woken: its row goes too, so it holds
      // none of the account's places, then it ends with its push service.
      if (subscription !== null && !sameBytes(subscription.options.applicationServerKey, key)) {
        await change("/push/unsubscribe", subscription.endpoint).catch(() => undefined);
        await subscription.unsubscribe().catch(() => false);
        subscription = null;
      }
      // One under our key is kept and handed to this account, even where
      // another account on this device subscribed it: a browser has one
      // subscription, so it wakes for one account, the last to turn it on.
      if (subscription === null) {
        subscription = await pushManager
          .subscribe({ userVisibleOnly: true, applicationServerKey: key })
          .catch(() => {
            throw new PushError("failed");
          });
        made = true;
      }
      try {
        await change("/push/subscribe", subscription.endpoint);
      } catch (e) {
        // One we made and the server didn't keep would never be woken.
        if (made) await subscription.unsubscribe().catch(() => false);
        throw e;
      }
    },

    async disable() {
      const subscription = await current();
      if (subscription === null) return;
      try {
        await change("/push/unsubscribe", subscription.endpoint);
      } finally {
        // Ended with its push service too, so a row the server failed to
        // drop is deleted at the next notice's 404 or 410 (T-76).
        await subscription.unsubscribe().catch(() => false);
      }
    },
  };
}

/** The client for this page's own browser. */
export const pushClient: PushClient = {
  state: () => createPushClient(pagePlatform()).state(),
  enable: () => createPushClient(pagePlatform()).enable(),
  disable: () => createPushClient(pagePlatform()).disable(),
};

/** Read when called, never at import: the server renders the page too. */
const pagePlatform = (): PushPlatform => ({
  navigator,
  notification: typeof Notification === "undefined" ? undefined : Notification,
  pushManager: typeof PushManager !== "undefined",
  fetch: (input, init) => fetch(input, init),
});
