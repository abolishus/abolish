import { describe, expect, test } from "vite-plus/test";
import { coordinatorUrl, HttpCoordinator, TransportError } from "../src/client.ts";
import { encodeRequests, MAX_BODY } from "../src/wire.ts";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fake(response: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return response();
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("the coordinator URL", () => {
  test("is HTTPS, or HTTP to loopback", () => {
    expect(coordinatorUrl("https://coordinator.example/ceremony").href).toBe(
      "https://coordinator.example/ceremony/",
    );
    for (const ok of ["http://127.0.0.1:8080", "http://[::1]/", "http://localhost/"])
      expect(() => coordinatorUrl(ok)).not.toThrow();
    for (const bad of [
      "http://coordinator.example/",
      "http://127.0.0.2/",
      "ftp://coordinator.example/",
      "https://user:pw@coordinator.example/",
      "https://coordinator.example/?seat=1",
      "https://coordinator.example/#x",
    ])
      expect(() => coordinatorUrl(bad), bad).toThrow(RangeError);
  });
});

describe("HttpCoordinator", () => {
  test("asks for its seat's requests and posts its messages and approvals under its seat, refusing redirects", async () => {
    const requests = [{ stub: Uint8Array.of(1), transcript: Uint8Array.of(2) }];
    const f = fake(() => new Response(encodeRequests(requests)));
    const c = new HttpCoordinator("https://coordinator.example/base", { fetch: f.fetch });
    expect(await c.requests(3)).toEqual(requests);
    const g = fake(() => new Response(null, { status: 204 }));
    const d = new HttpCoordinator("https://coordinator.example/base/", { fetch: g.fetch });
    const message = { stub_hash: new Uint8Array(32), transcript: Uint8Array.of(9) };
    await d.postMessage(3, message);
    expect(f.calls[0]?.url).toBe("https://coordinator.example/base/v1/ceremony/seats/3/requests");
    expect(f.calls[0]?.init?.method).toBe("GET");
    expect(f.calls[0]?.init?.redirect).toBe("error");
    expect(g.calls[0]?.url).toBe("https://coordinator.example/base/v1/ceremony/seats/3/messages");
    expect(g.calls[0]?.init?.method).toBe("POST");
    expect(g.calls[0]?.init?.redirect).toBe("error");
  });

  test("an error status, an unreachable coordinator, a body with no decoding and an oversized body are transport errors", async () => {
    const cases: (() => Response)[] = [
      () => new Response(null, { status: 503 }),
      // A reset after the headers: the body errors, and so does cancelling it.
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("reset"));
            },
          }),
          { status: 503 },
        ),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response(Uint8Array.of(0, 0, 0, 1)),
      () => new Response(new Uint8Array(MAX_BODY + 1)),
    ];
    for (const response of cases) {
      const c = new HttpCoordinator("https://coordinator.example/", {
        fetch: fake(response).fetch,
      });
      await expect(c.requests(1)).rejects.toThrow(TransportError);
    }
  });

  test("a body streamed past the bound is cut off without reading the rest", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1 << 20));
      },
    });
    const c = new HttpCoordinator("https://coordinator.example/", {
      fetch: fake(() => new Response(stream)).fetch,
    });
    await expect(c.requests(1)).rejects.toThrow("body too large");
    expect(pulled).toBeLessThan(MAX_BODY / (1 << 20) + 4);
  });
});
