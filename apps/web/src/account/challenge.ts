// Cloudflare Turnstile in the browser: the token a poll's submission carries
// (packages/core, Turnstile; ADR 0032; T-72). The server checks the token for
// its action and this site's host; nothing here decides anything.
//
// The script is third-party code running on our origin, so it is loaded only
// when an author asks to submit, never with the page, and only on the pages
// whose policy allows it (src/security.ts, `isChallengePage`; T-43, T-55).
// It is loaded from Cloudflare's own URL, as Cloudflare requires: it can't be
// pinned or given an integrity hash, which is why it stays off every other
// page.

import { MAX_TURNSTILE_TOKEN, type TurnstileAction } from "@abolishus/core/turnstile";

import { CHALLENGE_ORIGIN } from "../security.ts";
import { isSiteKey } from "../values.ts";

/** Turnstile's script, for widgets the page renders itself. */
export const CHALLENGE_SCRIPT = `${CHALLENGE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

// Printable ASCII without spaces, as the server reads a token.
const TOKEN = /^[\x21-\x7e]+$/;

/** The check couldn't load or failed: Cloudflare's to answer, not the author's. */
export class ChallengeError extends Error {
  constructor() {
    super("challenge unavailable");
    this.name = "ChallengeError";
  }
}

/** Something that gets one solved token, so pages can be shown with a stand-in. */
export interface Challenge {
  /**
   * Shows the check in `container` and resolves with one token solved for
   * `action`. Rejects with `ChallengeError` if the check can't load or
   * fails, and with the signal's reason once `signal` aborts; either way the
   * check is removed from the page.
   */
  solve(container: HTMLElement, action: TurnstileAction, signal: AbortSignal): Promise<string>;
}

// The part of Turnstile's explicit-rendering API this uses.
interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  remove(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

function load(): Promise<TurnstileApi> {
  if (loading !== undefined) return loading;
  const script = document.createElement("script");
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    script.src = CHALLENGE_SCRIPT;
    script.async = true;
    script.onload = () => {
      if (window.turnstile !== undefined) resolve(window.turnstile);
      else reject(new ChallengeError());
    };
    script.onerror = () => reject(new ChallengeError());
    document.head.append(script);
  }).catch((e: unknown) => {
    // A failed load is tried again on the next submission, from a fresh tag.
    loading = undefined;
    script.remove();
    throw e;
  });
  return loading;
}

/** Turnstile with this deployment's site key. */
export function turnstileChallenge(siteKey: string): Challenge {
  if (!isSiteKey(siteKey)) throw new RangeError("not a Turnstile site key");
  return {
    async solve(container, action, signal) {
      signal.throwIfAborted();
      const api = await load();
      signal.throwIfAborted();
      return new Promise<string>((resolve, reject) => {
        let widget: string | undefined;
        let settled = false;
        const finish = (settle: () => void) => {
          signal.removeEventListener("abort", aborted);
          settled = true;
          if (widget !== undefined) api.remove(widget);
          widget = undefined;
          settle();
        };
        const aborted = () => finish(() => reject(signal.reason));
        const failed = () => finish(() => reject(new ChallengeError()));
        signal.addEventListener("abort", aborted);
        try {
          widget = api.render(container, {
            sitekey: siteKey,
            action,
            theme: "auto",
            // The token goes in a header, never in a form field.
            "response-field": false,
            callback: (token: unknown) => {
              if (
                typeof token === "string" &&
                token.length <= MAX_TURNSTILE_TOKEN &&
                TOKEN.test(token)
              )
                finish(() => resolve(token));
              else failed();
            },
            // Handled here (`true`), so Turnstile doesn't throw it too; the
            // author starts the check over by submitting again.
            "error-callback": () => {
              failed();
              return true;
            },
            "timeout-callback": failed,
            "unsupported-callback": failed,
          });
        } catch {
          failed();
          return;
        }
        // Settled during `render` (a callback it ran at once): its widget is ours to remove.
        if (settled) {
          if (widget !== undefined) api.remove(widget);
          widget = undefined;
        } else if (widget === undefined) failed();
      });
    },
  };
}
