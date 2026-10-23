// The offline shell (P2-28 part 1b): a service worker that shows one page,
// `/offline`, when a page of this site can't be fetched because the device
// has no connection. It answers nothing else: every page is fetched from the
// network as before, and only a failed fetch gets the offline page.
//
// What it keeps on the device is that page, its stylesheet and the fonts the
// stylesheet names, all public and the same for everyone: no poll, account
// or search page a visitor opened is ever stored (T-45, T-10). The offline
// page is fetched without the account cookie (src/node/serve.ts) and has no
// script (src/security.ts, `offlineHeaders`).
//
// Only the website installs one. The ballot client is another origin, with
// its own policy and entry points (ADR 0020; T-41, T-43), and nothing here
// reaches it.
//
// The same worker shows web push's notice (P2-27 part 4b; T-76): a push
// from our server carries no payload, so it shows one fixed notice, words
// set here when the worker is served, whatever a push carries, and a click
// opens the account page, where what happened is said. It reads nothing
// from the push and sends nothing on.
//
// A service worker outlives the page that registered it, so it is kept as
// small as it can be (T-43, T-57): it takes no input but the requests it
// sees, the page may register only our own `/sw.js` (`worker-src 'self'`),
// and the browser fetches `/sw.js` again on every navigation, past any HTTP
// cache (`updateViaCache: "none"`), so a changed worker replaces the old one
// at the next page a visitor opens.

import { toHex } from "../values.ts";

/** Where the worker is served: the site's root, so its scope is every page. */
export const WORKER_PATH = "/sw.js";

/** The page shown when a page can't be fetched. */
export const OFFLINE_PATH = "/offline";

/** The names of every cache the worker fills begin with this. */
export const CACHE_PREFIX = "abolish-offline:";

export interface OfflineWorkerConfig {
  /** This version's cache: `CACHE_PREFIX` and the offline page's hash. */
  readonly cache: string;
  /** `OFFLINE_PATH`. */
  readonly offline: string;
  /** The offline page's stylesheet, a content-hashed path under `/assets/`. */
  readonly stylesheet: string;
  /** What a push shows: always these words, whatever it carries. */
  readonly notice: PushNotice;
}

/** Web push's one notice (P2-27 part 4b). */
export interface PushNotice {
  readonly title: string;
  readonly body: string;
  /** The site's icon, on this origin. */
  readonly icon: string;
  /** The page a click opens, on this origin: the account page. */
  readonly open: string;
}

// What the worker uses of its global scope, typed here: the site's code is
// typed for pages (lib "dom"), not workers.
interface ExtendableEvent {
  waitUntil(work: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  readonly preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response>): void;
}

interface NotificationEvent extends ExtendableEvent {
  readonly notification: { close(): void };
}

export interface OfflineWorkerScope {
  readonly location: { readonly origin: string };
  readonly caches: CacheStorage;
  readonly registration: {
    readonly navigationPreload?: { enable(): Promise<void> };
    showNotification(
      title: string,
      options: { body: string; icon: string; tag: string },
    ): Promise<void>;
  };
  readonly clients: {
    claim(): Promise<void>;
    openWindow(url: string): Promise<unknown>;
  };
  fetch(request: Request | string): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "install" | "activate" | "push",
    listener: (event: ExtendableEvent) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
}

/**
 * The worker itself. It runs as the text `offlineWorkerSource` makes of it,
 * so it uses nothing from outside its own body but its two arguments and
 * the platform's `URL`, `Response` and `Set`.
 */
export function offlineWorker(scope: OfflineWorkerScope, config: OfflineWorkerConfig): void {
  const prefix = "abolish-offline:";
  // A font: one content-hashed file under /assets/, as the stylesheet names it.
  const font = /^\/assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.woff2$/;

  // The page, its stylesheet, then the fonts that stylesheet names. A fetch
  // that fails fails the install, and the browser tries again later.
  async function fill() {
    const cache = await scope.caches.open(config.cache);
    await cache.addAll([config.offline, config.stylesheet]);
    const css = await cache.match(config.stylesheet);
    if (css === undefined) throw new Error("stylesheet missing");
    const named = (await css.text()).matchAll(/url\(([^)]*)\)/g);
    const fonts = new Set([...named].map((m) => m[1] as string).filter((u) => font.test(u)));
    await cache.addAll([...fonts]);
  }

  async function navigate(event: FetchEvent): Promise<Response> {
    try {
      return (await event.preloadResponse) ?? (await scope.fetch(event.request));
    } catch {
      // The fetch failed before any answer: no connection. A server's own
      // error page is an answer, and passes through above.
      const page = await (await scope.caches.open(config.cache)).match(config.offline);
      return page ?? Response.error();
    }
  }

  async function stored(request: Request, path: string): Promise<Response> {
    const hit = await (await scope.caches.open(config.cache)).match(path);
    return hit ?? scope.fetch(request);
  }

  scope.addEventListener("install", (event) => {
    event.waitUntil(fill().then(() => scope.skipWaiting()));
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await scope.caches.keys())
          if (name.startsWith(prefix) && name !== config.cache) await scope.caches.delete(name);
        await scope.registration.navigationPreload?.enable();
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== scope.location.origin) return;
    // A page opened in a tab. A frame (another site's embed of a poll)
    // goes to the network untouched: the offline page refuses framing.
    if (request.mode === "navigate") {
      if (request.destination === "document") event.respondWith(navigate(event));
      return;
    }
    // The offline page's stylesheet and fonts, from the cache when it has
    // them: their names carry their content's hash, so they never change.
    if (url.search === "" && (url.pathname === config.stylesheet || font.test(url.pathname)))
      event.respondWith(stored(request, url.pathname));
  });

  // A push wakes the worker with nothing to read (T-76): it shows the one
  // notice, as a browser requires of every push, and never the push's data.
  // One tag, so a second notice replaces the first rather than stacking.
  scope.addEventListener("push", (event) => {
    const { title, body, icon } = config.notice;
    event.waitUntil(scope.registration.showNotification(title, { body, icon, tag: "notice" }));
  });

  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(scope.clients.openWindow(config.notice.open));
  });
}

/** `/sw.js`: the worker as a classic script, run with `config`. */
export const offlineWorkerSource = (config: OfflineWorkerConfig): string =>
  `"use strict";\n(${offlineWorker.toString()})(self, ${JSON.stringify(config)});\n`;

/** The worker's configuration for an offline page whose HTML is `html`, showing `notice` on a push. */
export async function offlineWorkerConfig(
  html: string,
  stylesheet: string,
  notice: PushNotice,
): Promise<OfflineWorkerConfig> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)),
  );
  // The page's own hash names the cache, so `/sw.js` changes whenever the
  // page does (its words, or its stylesheet's name) and the browser
  // installs the worker again, filling a fresh cache.
  const hash = toHex(digest.slice(0, 16));
  return { cache: `${CACHE_PREFIX}${hash}`, offline: OFFLINE_PATH, stylesheet, notice };
}

/**
 * Registers the worker from a page. Where a browser has no service workers,
 * or refuses one (a private window, a policy), the site works as before,
 * only not offline, so a refusal is left unreported.
 */
export function registerOfflineShell(navigator: Navigator): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register(WORKER_PATH, { scope: "/", updateViaCache: "none" })
    .catch(() => {});
}
