import { describe, expect, test } from "vite-plus/test";
import { createPostmarkSender, type EmailMessage, POSTMARK_EMAIL } from "../src/index.ts";

// The Postmark adapter against a stand-in for its API: what is sent (one
// recipient, plain text, tracking off, nothing about the account), and that
// anything but Postmark's clear success is `unavailable` (ADR 0038; T-67,
// T-73).

const TOKEN = "POSTMARK_API_TEST";
const FROM = "codes@abolish.test";
const CODE: EmailMessage = {
  kind: "email-code",
  to: "Ana@Example.org",
  code: "01234567",
  locale: "en-US",
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A Postmark that answers `answer` (a JSON body, a status and body, or a thrown error). */
function postmark(answer: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url instanceof Request ? url.url : url.toString(), init });
    if (answer instanceof Error) throw answer;
    if (typeof answer === "object" && answer !== null && "status" in answer && "body" in answer)
      return new Response(String(answer.body), { status: Number(answer.status) });
    return Response.json(answer);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const OK = { To: CODE.to, ErrorCode: 0, Message: "OK", MessageID: "b7bc2f4a" };

describe("createPostmarkSender", () => {
  test("sends one plain-text message to the one recipient, with tracking off", async () => {
    const { sent, fetch } = postmark(OK);
    const sender = createPostmarkSender({ serverToken: TOKEN, from: FROM, fetch });
    expect(await sender.send(CODE)).toBe("sent");
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(POSTMARK_EMAIL);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": TOKEN,
    });
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    // Exactly these fields: no HTML, tag, metadata or reply address.
    expect(Object.keys(body).sort()).toEqual([
      "From",
      "MessageStream",
      "Subject",
      "TextBody",
      "To",
      "TrackLinks",
      "TrackOpens",
    ]);
    expect(body).toMatchObject({
      From: FROM,
      // The domain in its ASCII form, which UTS 46 lowercases; the local part as typed.
      To: "Ana@example.org",
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
    });
    expect(body["Subject"]).toContain("01234567");
    expect(body["TextBody"]).toContain("01234567");
  });

  test("sends a held address's notice with no code", async () => {
    const { sent, fetch } = postmark(OK);
    const sender = createPostmarkSender({ serverToken: TOKEN, from: FROM, fetch });
    expect(await sender.send({ kind: "email-held", to: "ana@example.org", locale: "en-US" })).toBe(
      "sent",
    );
    const body = JSON.parse(sent[0]?.init?.body as string) as Record<string, unknown>;
    expect(body["To"]).toBe("ana@example.org");
    expect(body["TextBody"]).not.toMatch(/[0-9]{8}/);
  });

  test("sends a domain written in Unicode in its ASCII form", async () => {
    const { sent, fetch } = postmark(OK);
    const sender = createPostmarkSender({ serverToken: TOKEN, from: FROM, fetch });
    expect(await sender.send({ ...CODE, to: "ana@bücher.de" })).toBe("sent");
    expect(JSON.parse(sent[0]?.init?.body as string)).toMatchObject({
      To: "ana@xn--bcher-kva.de",
    });
  });

  test("uses the stream it is given", async () => {
    const { sent, fetch } = postmark(OK);
    const sender = createPostmarkSender({
      serverToken: TOKEN,
      from: FROM,
      messageStream: "codes",
      fetch,
    });
    await sender.send(CODE);
    expect(JSON.parse(sent[0]?.init?.body as string)).toMatchObject({ MessageStream: "codes" });
  });

  test.each([
    ["an HTTP error", { status: 500, body: "{}" }],
    ["a refused token", { status: 401, body: '{"ErrorCode":10,"Message":"Bad token"}' }],
    ["a suppressed recipient", { status: 422, body: '{"ErrorCode":406,"Message":"Inactive"}' }],
    ["a 200 with an error code", { ErrorCode: 300, Message: "Invalid email request" }],
    ["a 200 without an error code", { Message: "OK" }],
    ["a body that isn't an object", ["OK"]],
    ["a body that isn't JSON", { status: 200, body: "OK" }],
    ["a network failure", new TypeError("fetch failed")],
  ])("answers unavailable on %s", async (_, answer) => {
    const { fetch } = postmark(answer);
    const sender = createPostmarkSender({ serverToken: TOKEN, from: FROM, fetch });
    expect(await sender.send(CODE)).toBe("unavailable");
  });

  test.each([
    "two@example.org, three@example.org",
    "Ana <ana@example.org>",
    '"ana"@example.org',
    " ana@example.org",
    "not an address",
  ])("sends nothing to %j, which isn't one bare address", async (to) => {
    const { sent, fetch } = postmark(OK);
    const sender = createPostmarkSender({ serverToken: TOKEN, from: FROM, fetch });
    expect(await sender.send({ kind: "email-held", to, locale: "en-US" })).toBe("unavailable");
    expect(sent).toHaveLength(0);
  });

  test.each([
    [{ serverToken: "", from: FROM }, "serverToken"],
    [{ serverToken: "a token", from: FROM }, "serverToken"],
    [{ serverToken: TOKEN, from: "Abolish <codes@abolish.test>" }, "from"],
    [{ serverToken: TOKEN, from: "códigos@abolish.test" }, "from"],
    [{ serverToken: TOKEN, from: FROM, messageStream: "Out Bound" }, "messageStream"],
  ])("refuses %j", (options, field) => {
    expect(() => createPostmarkSender(options)).toThrow(field);
  });
});
