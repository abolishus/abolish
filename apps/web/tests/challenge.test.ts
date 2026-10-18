import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { Challenge } from "../src/account/challenge.ts";

// The page's side of Turnstile, with the browser's document and Cloudflare's
// script stood in for: what is loaded, what the widget is rendered with, and
// that every way out takes the widget down. The server's check of the token
// is packages/core's (tests/turnstile.test.ts).

const SITE_KEY = "0x4AAAAAAAexample_Key-1";

interface FakeScript {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  removed: boolean;
  remove(): void;
}

let scripts: FakeScript[];
let rendered: { container: unknown; options: Record<string, (...a: unknown[]) => unknown> }[];
let removed: string[];

const api = {
  render(container: unknown, options: Record<string, (...a: unknown[]) => unknown>) {
    rendered.push({ container, options });
    return `widget-${rendered.length}`;
  },
  remove(widget: string) {
    removed.push(widget);
  },
};

beforeEach(() => {
  scripts = [];
  rendered = [];
  removed = [];
  vi.resetModules();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("script");
      const script: FakeScript = {
        src: "",
        async: false,
        onload: null,
        onerror: null,
        removed: false,
        remove() {
          this.removed = true;
        },
      };
      return script;
    },
    head: { append: (script: FakeScript) => scripts.push(script) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function challenge(): Promise<Challenge> {
  const { turnstileChallenge } = await import("../src/account/challenge.ts");
  return turnstileChallenge(SITE_KEY);
}

/** Lets the script "load", defining Turnstile's API as Cloudflare's script does. */
async function loaded() {
  await vi.waitFor(() => expect(scripts).toHaveLength(1));
  (globalThis.window as { turnstile?: typeof api }).turnstile = api;
  scripts[0]!.onload?.();
  await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
}

const container = { id: "check" } as unknown as HTMLElement;

describe("turnstileChallenge", () => {
  test("refuses anything but a site key", async () => {
    const { turnstileChallenge } = await import("../src/account/challenge.ts");
    for (const bad of ["", "key with space", "a".repeat(101), '"><script>', "k/ey"])
      expect(() => turnstileChallenge(bad)).toThrow(RangeError);
  });

  test("loads nothing until asked to solve", async () => {
    await challenge();
    expect(scripts).toEqual([]);
  });

  test("loads Cloudflare's script for explicit rendering, once, and renders one widget for the action", async () => {
    const c = await challenge();
    const solved = c.solve(container, "poll-create", new AbortController().signal);
    await loaded();
    expect(scripts[0]!.src).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    );
    const [{ container: where, options }] = rendered as [(typeof rendered)[number]];
    expect(where).toBe(container);
    expect(options["sitekey"]).toBe(SITE_KEY);
    expect(options["action"]).toBe("poll-create");
    // The token goes in a header: no hidden form field holds it.
    expect(options["response-field"]).toBe(false);
    options["callback"]!("tok.en-1");
    await expect(solved).resolves.toBe("tok.en-1");
    expect(removed).toEqual(["widget-1"]);
    // A second solve reuses the loaded script.
    const again = c.solve(container, "poll-create", new AbortController().signal);
    await vi.waitFor(() => expect(rendered).toHaveLength(2));
    rendered[1]!.options["callback"]!("tok.en-2");
    await expect(again).resolves.toBe("tok.en-2");
    expect(scripts).toHaveLength(1);
  });

  test.each(["", "has space", "x".repeat(2049), 42, undefined])(
    "refuses %j from the widget as a token",
    async (token) => {
      const c = await challenge();
      const solved = c.solve(container, "poll-create", new AbortController().signal);
      await loaded();
      rendered[0]!.options["callback"]!(token);
      await expect(solved).rejects.toMatchObject({ name: "ChallengeError" });
      expect(removed).toEqual(["widget-1"]);
    },
  );

  test.each(["error-callback", "timeout-callback", "unsupported-callback"])(
    "the widget's %s fails the solve and takes the widget down",
    async (event) => {
      const c = await challenge();
      const solved = c.solve(container, "poll-create", new AbortController().signal);
      await loaded();
      rendered[0]!.options[event]!();
      await expect(solved).rejects.toMatchObject({ name: "ChallengeError" });
      expect(removed).toEqual(["widget-1"]);
    },
  );

  test("an abort takes the widget down with the signal's reason", async () => {
    const c = await challenge();
    const controller = new AbortController();
    const solved = c.solve(container, "poll-create", controller.signal);
    await loaded();
    controller.abort(new Error("edited"));
    await expect(solved).rejects.toThrow("edited");
    expect(removed).toEqual(["widget-1"]);
    // A token arriving after that is nobody's.
    rendered[0]!.options["callback"]!("late");
    expect(removed).toEqual(["widget-1"]);
  });

  test("an aborted signal loads nothing", async () => {
    const c = await challenge();
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(c.solve(container, "poll-create", controller.signal)).rejects.toThrow("gone");
    expect(scripts).toEqual([]);
  });

  test("a script that fails to load is removed and tried again from a fresh tag", async () => {
    const c = await challenge();
    const first = c.solve(container, "poll-create", new AbortController().signal);
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    scripts[0]!.onerror?.();
    await expect(first).rejects.toMatchObject({ name: "ChallengeError" });
    expect(scripts[0]!.removed).toBe(true);
    // Loaded, but defining no API, is a failure too.
    const second = c.solve(container, "poll-create", new AbortController().signal);
    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    scripts[1]!.onload?.();
    await expect(second).rejects.toMatchObject({ name: "ChallengeError" });
    expect(scripts[1]!.removed).toBe(true);
    expect(rendered).toEqual([]);
  });

  test("a token given during `render` itself still takes the widget down", async () => {
    const c = await challenge();
    const solved = c.solve(container, "poll-create", new AbortController().signal);
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    (globalThis.window as { turnstile?: unknown }).turnstile = {
      render: (_: unknown, options: Record<string, (t: string) => void>) => {
        options["callback"]!("at-once");
        return "widget-sync";
      },
      remove: (widget: string) => removed.push(widget),
    };
    scripts[0]!.onload?.();
    await expect(solved).resolves.toBe("at-once");
    expect(removed).toEqual(["widget-sync"]);
  });

  test("a widget that won't render fails the solve", async () => {
    const c = await challenge();
    const solved = c.solve(container, "poll-create", new AbortController().signal);
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    (globalThis.window as { turnstile?: unknown }).turnstile = {
      render: () => {
        throw new Error("bad container");
      },
      remove: () => {},
    };
    scripts[0]!.onload?.();
    await expect(solved).rejects.toMatchObject({ name: "ChallengeError" });
  });
});
