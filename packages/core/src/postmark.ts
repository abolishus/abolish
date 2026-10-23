// The e-mail provider behind `EmailSender` ([[0038-verified-accounts]],
// Email; P2-31 part 2b): Postmark's single-message API, sending plain-text
// transactional mail. Amazon SES, the alternative, would be a second
// implementation of the same interface; the owner's sign-up picks one.
//
// T-67: open and link tracking are off on every message, whatever the
// server's defaults, and `renderEmail` gives no link or image to track
// anyway. T-73: the provider is told an address, a subject and a body, never
// an account, a poll or a ballot; no tag or metadata goes with it.

import { domainToASCII } from "node:url";
import {
  type EmailMessage,
  type EmailSender,
  parseEmailAddress,
  renderEmail,
} from "./account-emails.ts";

/** Postmark's single-message endpoint. */
export const POSTMARK_EMAIL = "https://api.postmarkapp.com/email";

export interface PostmarkOptions {
  /** The server's API token (`POSTMARK_API_TEST` takes messages and sends none). */
  readonly serverToken: string;
  /** The sender's address, on a domain the Postmark server has verified. */
  readonly from: string;
  /** The message stream: a transactional one, never broadcast. */
  readonly messageStream?: string;
  /** How long to wait for Postmark before answering `unavailable`. */
  readonly timeoutMs?: number;
  /** For tests; the platform's otherwise. */
  readonly fetch?: typeof globalThis.fetch;
}

// What a header value or token may hold: printable ASCII without spaces.
const TOKEN = /^[\x21-\x7e]+$/;
const STREAM = /^[a-z0-9-]{1,64}$/;

/** `address` with its domain in ASCII form (UTS 46), as SMTP without SMTPUTF8 takes it. */
function asciiDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return `${address.slice(0, at)}@${domainToASCII(address.slice(at + 1))}`;
}

/**
 * Sends each message through Postmark. `sent` only on Postmark's own clear
 * success (HTTP 200 and `ErrorCode` 0); anything else, a suppressed
 * recipient included, is `unavailable`.
 */
export function createPostmarkSender({
  serverToken,
  from,
  messageStream = "outbound",
  timeoutMs = 10_000,
  fetch = globalThis.fetch,
}: PostmarkOptions): EmailSender {
  if (!TOKEN.test(serverToken)) throw new Error("serverToken is not a token");
  // An ASCII address only: it goes in a header as typed.
  if (parseEmailAddress(from) !== from || !TOKEN.test(from))
    throw new Error("from is not a plain ASCII address");
  if (!STREAM.test(messageStream)) throw new Error("messageStream is not a stream ID");
  return {
    async send(message: EmailMessage) {
      // One bare address, as requestEmailCode and sendNotices only ever pass: no comma,
      // angle bracket or quote that could add a recipient.
      if (parseEmailAddress(message.to) !== message.to) return "unavailable";
      const { subject, text } = renderEmail(message);
      try {
        const response = await fetch(POSTMARK_EMAIL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-postmark-server-token": serverToken,
          },
          body: JSON.stringify({
            From: from,
            To: asciiDomain(message.to),
            Subject: subject,
            TextBody: text,
            MessageStream: messageStream,
            TrackOpens: false,
            TrackLinks: "None",
          }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return "unavailable";
        }
        const outcome: unknown = await response.json();
        return typeof outcome === "object" &&
          outcome !== null &&
          (outcome as Record<string, unknown>)["ErrorCode"] === 0
          ? "sent"
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
