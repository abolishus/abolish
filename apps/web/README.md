# @abolishus/web

The public website: a TanStack Start app rendered on the server, for finding polls, reading what our server says about them and, later, their results. It never casts a vote: ballots are cast only in [`apps/ballot`](../ballot/README.md). Internal (AGPL-3.0-only).

## What it holds to

- **Our server calls the API; the browser doesn't** (T-10). Pages get data from server functions (`src/data.ts`), which call the public API (`src/server/api.ts`) with requests built from the contract and the poll ID alone, so a visitor's cookies, account session, address or user agent never reach the API. Every answer is checked against `@abolishus/api-contract` before use.
- **Claims, shown as claims** (T-24, T-34). A poll page decodes the definition with `@abolishus/crypto`, the verifier's own code, and refuses one that doesn't decode or names another election. It shows the definition's hash, to compare with the election registry, and the board's size, chain head and root, saying plainly that they are only this server's word until an L1 checkpoint covers them.
- **One spelling per poll** (T-31). A poll page's address is its ID in lowercase hex; anything else is not found. The lookup form forgives `0x`, capitals and spaces and redirects to that one address.
- **A CSP with a nonce per response** (T-43). Scripts only from our own origin plus the inline scripts the server rendered that response with, each carrying its nonce; styles, fonts and images from our origin; `connect-src 'self'`; no framing, `<base>` or plugins. With `no-store` (a cached page would share its nonce), HSTS, `no-referrer`, `nosniff`, same-origin opener and resource policies and a restrictive `Permissions-Policy` on every response (`src/security.ts`, `src/start.ts`).
- **Server functions refuse other sites** (`createCsrfMiddleware`, by `Sec-Fetch-Site` and `Origin`), before any handler runs.
- **Errors quote nothing.** A failed API call reaches the page as one fixed error, because a server function's error is serialised into the page; the log gets its kind only.
- **Accounts live here, never votes** (T-10, ADR 0017). `/auth` is the account handler from `@abolishus/core` (passkeys only), mounted by the Node front, so its host-only session cookie never reaches the API or the ballot client's host. `/account` signs up, signs in and out, manages passkeys and deletes the account; its WebAuthn JSON conversions are our own (`src/account/webauthn.ts`), so the page adds no third-party browser code (T-55). The pages never read the session.
- **A front that logs no paths** (T-10, T-11, T-67, T-52). `src/node/serve.ts` serves the built Start handler, `/auth` and the hashed assets on `node:http`. It builds every request's URL on `WEB_ORIGIN`, never on `Host`; it bounds bodies at 64 KiB and requests in flight at 64, and times out idle or slow connections; its log line is the method, a route class, the status and the duration, never a path, query, header or address.
- **Moderation is public** (T-68). `/moderation` lists every decision with its reason code, never who made or reported it; a delisted or hidden poll says so on its page and tells search engines not to index it.

## Build and run

`vp run --filter @abolishus/web... build` builds the Start app into `dist/server` and `dist/client`, with every dependency inlined into the server, then packs the Node entry into `dist/node/main.mjs`. `node dist/node/main.mjs` runs from `dist/` alone, with no `node_modules` (the image comes with P2-11).

## Configuration

- `API_URL`: the public API's base URL (`http(s)`, no credentials, query or fragment).
- `WEB_ORIGIN`: this site's public `https` origin. Every request's URL is built on it, and it is the passkeys' origin.
- `ACCOUNT_RP_ID`: the passkeys' RP ID; `WEB_ORIGIN`'s host by default. Never the ballot client's RP ID or same-site with it (ADR 0017).
- `ACCOUNT_SECRET`: signs account cookies; at least 32 bytes of randomness.
- `DATABASE_URL`: a login granted `abolish_app` only (packages/core, Database).
- `WEB_HOST`, `WEB_PORT`: where to listen; `127.0.0.1:3000` by default, behind the proxy that terminates TLS.

## Test

- `vp run --filter @abolishus/web test`: unit and property tests of the ID and `u64` rules, the definition view against `docs/spec/vectors/election-definition.json`, and the security headers; then `tests/ssr.test.ts` builds the app and renders every page with the built server against a stub API: headers and nonces on every page, what a poll page shows and refuses, that nothing of the visitor's reaches the API, lookups and redirects, the moderation log, server functions refusing other sites, and an API outage that leaks nothing.
- The same task, against Postgres (`TEST_DATABASE_URL`): `tests/serve.test.ts` runs the front with the real account handler as `abolish_app` and a software authenticator fed through the page's own WebAuthn conversions (sign-up, a second passkey, sign-out, sign-in, deletion, a cross-origin sign-out refused), and checks assets, path traversal, the origin the URL is built on, `Set-Cookie`, body bounds, the in-flight limit and the log; `tests/deployable.test.ts` copies `dist/` out of the repository, runs `main.mjs` with plain Node and checks a page, its assets and `/auth`, a refusal to start on bad configuration that quotes none of it, and that no client asset carries account server code.
- `vp run --filter @abolishus/web test:storybook`: every component's stories in headless Chromium, their play functions, then axe (WCAG 2.2 AA), in both themes.
