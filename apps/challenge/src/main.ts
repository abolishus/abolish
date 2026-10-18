// The challenge page ([[registration]], Challenge page): one Turnstile widget
// for the action the fragment names, and its token posted to the ballot
// client that framed the page, and to no one else. The page reads nothing
// from the voter and makes no request of its own; Turnstile's script is the
// only code here that isn't this file (T-67, T-43).

import { ENTRY_POINTS, SITE_KEY } from "virtual:challenge-deployment";

import { isToken, parseFragment } from "./fragment.ts";
import { TURNSTILE_SCRIPT } from "./turnstile.ts";

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

// Read once: a later change to the fragment asks for nothing.
const request = parseFragment(location.hash, ENTRY_POINTS);
const container = document.getElementById("challenge");

// A page that isn't framed has no one to hand a token to, so it loads
// nothing: neither does one with no site key or a fragment it refuses.
if (window.parent !== window && request !== undefined && SITE_KEY !== null && container !== null) {
  const { origin, action } = request;
  const script = document.createElement("script");
  script.src = TURNSTILE_SCRIPT;
  script.async = true;
  script.onload = () => {
    const api = window.turnstile;
    if (api === undefined) return;
    let posted = false;
    const widget = api.render(container, {
      sitekey: SITE_KEY,
      action,
      theme: "auto",
      language: "auto",
      // The token goes to the client by message, never into a form field.
      "response-field": false,
      callback: (token: unknown) => {
        // One token per frame: the client sends the first and ignores the
        // rest, so a second is never posted.
        if (posted || !isToken(token)) return;
        posted = true;
        // The browser delivers it only if the parent's origin is `origin`,
        // an entry point, and `frame-ancestors` lets only those frame the
        // page (T-43).
        window.parent.postMessage({ v: 1, token }, origin);
        if (widget !== undefined) api.remove(widget);
      },
    });
  };
  document.head.append(script);
}
