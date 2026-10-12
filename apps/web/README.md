# @abolishus/web

The public website: a TanStack Start app rendered on the server, for finding polls, reading what our server says about them and, later, their results. It never casts a vote: ballots are cast only in [`apps/ballot`](../ballot/README.md). Internal (AGPL-3.0-only).

## What it holds to

- **Our server calls the API; the browser doesn't** (T-10). Pages get data from server functions (`src/data.ts`), which call the public API (`src/server/api.ts`) with requests built from the contract and the poll ID alone, so a visitor's cookies, account session, address or user agent never reach the API. Every answer is checked against `@abolishus/api-contract` before use.
- **Claims, shown as claims** (T-24, T-34). A poll page decodes the definition with `@abolishus/crypto`, the verifier's own code, and refuses one that doesn't decode or names another election. It shows the definition's hash, to compare with the election registry, and the board's size, chain head and root, saying plainly that they are only this server's word until an L1 checkpoint covers them.
- **One spelling per poll** (T-31). A poll page's address is its ID in lowercase hex; anything else is not found. The lookup form forgives `0x`, capitals and spaces and redirects to that one address.
- **A CSP with a nonce per response** (T-43). Scripts only from our own origin plus the inline scripts the server rendered that response with, each carrying its nonce; styles, fonts and images from our origin; `connect-src 'self'`; no framing, `<base>` or plugins. With `no-referrer`, `nosniff`, same-origin opener and resource policies and a restrictive `Permissions-Policy` on every response (`src/security.ts`, `src/start.ts`).
- **Server functions refuse other sites** (`createCsrfMiddleware`, by `Sec-Fetch-Site` and `Origin`), before any handler runs.
- **Errors quote nothing.** A failed API call reaches the page as one fixed error, because a server function's error is serialised into the page; the log gets its kind only.
- **Moderation is public** (T-68). `/moderation` lists every decision with its reason code, never who made or reported it; a delisted or hidden poll says so on its page and tells search engines not to index it.

## Configuration

- `API_URL`: the public API's base URL (`http(s)`, no credentials, query or fragment). Read when the first page needs data.

## Test

- `vp run --filter @abolishus/web test`: unit and property tests of the ID and `u64` rules, the definition view against `docs/spec/vectors/election-definition.json`, and the security headers; then `tests/ssr.test.ts` builds the app and renders every page with the built server against a stub API: headers and nonces on every page, what a poll page shows and refuses, that nothing of the visitor's reaches the API, lookups and redirects, the moderation log, server functions refusing other sites, and an API outage that leaks nothing.
- `vp run --filter @abolishus/web test:storybook`: every component's stories in headless Chromium, their play functions, then axe (WCAG 2.2 AA), in both themes.
