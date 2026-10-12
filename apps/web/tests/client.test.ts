import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { AccountError, accountClient } from "../src/account/client.ts";

// The page's account calls, with the browser's fetch and passkey prompt
// stubbed: how each way of failing reaches the panel.

const OPTIONS = { challenge: "AQID", rpId: "abolish.test" };

function serve(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new TypeError("no answer");
    return next;
  });
  return calls;
}

class FakeCredential {}

function prompt(get: () => Promise<unknown>) {
  vi.stubGlobal("PublicKeyCredential", FakeCredential);
  vi.stubGlobal("navigator", { credentials: { get, create: get } });
}

async function failure(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AccountError);
  return (error as AccountError).failure;
}

afterEach(() => vi.unstubAllGlobals());

describe("account client", () => {
  test("a dismissed prompt is cancelled, and nothing is sent to verify", async () => {
    const calls = serve(Response.json(OPTIONS));
    prompt(() => Promise.reject(new DOMException("dismissed", "NotAllowedError")));
    expect(await failure(accountClient.signIn())).toBe("cancelled");
    expect(calls.map((c) => c.url)).toEqual(["/auth/passkey/generate-authenticate-options"]);
  });

  test("any other prompt error, or no credential, is a failure", async () => {
    serve(Response.json(OPTIONS), Response.json(OPTIONS));
    prompt(() => Promise.reject(new DOMException("bad", "SecurityError")));
    expect(await failure(accountClient.signIn())).toBe("failed");
    prompt(() => Promise.resolve(null));
    expect(await failure(accountClient.signIn())).toBe("failed");
  });

  test("a browser without passkeys is unsupported, before any call", async () => {
    const calls = serve();
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await failure(accountClient.signUp())).toBe("unsupported");
    expect(calls).toEqual([]);
  });

  test("a refusal, an unreadable answer or a network error is a failure", async () => {
    serve(new Response("{}", { status: 401 }), new Response("not json"));
    expect(await failure(accountClient.signOut())).toBe("failed");
    expect(await failure(accountClient.signOut())).toBe("failed");
    expect(await failure(accountClient.signOut())).toBe("failed");
  });

  test("calls stay on this origin, uncached, refusing redirects, and name no passkey", async () => {
    const calls = serve(Response.json(null), Response.json({}));
    expect(await accountClient.signedIn()).toBe(false);
    await accountClient.removePasskey("pk-1");
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      ["/auth/get-session", "GET"],
      ["/auth/passkey/delete-passkey", "POST"],
    ]);
    for (const { init } of calls) {
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.redirect).toBe("error");
    }
    expect(calls[1]?.init.body).toBe(JSON.stringify({ id: "pk-1" }));
  });

  test("a passkey list in the wrong shape is a failure", async () => {
    serve(Response.json([{ id: "pk", createdAt: 1, backedUp: true }]), Response.json({}));
    expect(await failure(accountClient.passkeys())).toBe("failed");
    expect(await failure(accountClient.passkeys())).toBe("failed");
  });
});
