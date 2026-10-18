# @abolishus/challenge

The challenge page ([[registration]], Challenge page): Cloudflare's Turnstile widget on an origin of its own, which the ballot client frames for a Tier 0 registration or a Tier 1 relay. Turnstile is third-party code the ballot client never runs, so it runs here and only its token crosses to the client, by `postMessage`. Built reproducibly into `dist/`. Internal (AGPL-3.0-only).

## What it holds to

- **It reads only its fragment** (`src/fragment.ts`): exactly `#origin=<origin>&action=<action>`, as the ballot client's `challengeFrameSrc` writes it, the keys once each and in that order, the origin in `encodeURIComponent`'s one encoding and one of the deployment's entry points, the action `tier0-register` or `tier1-relay`. Anything else, a page that isn't framed, or a build with no site key, loads nothing. It reads nothing from the voter and makes no request of its own (T-11).
- **One widget, one token, one recipient** (`src/main.ts`): Turnstile's script from Cloudflare's own URL, one widget for the deployment's site key and the fragment's action, and the first token of Turnstile's form posted to the parent with `origin` as the target, so the browser delivers it only to a parent of that origin. The widget is removed after; no second token is posted (T-43).
- **Its policy is the spec's** (`src/policy.ts`): `default-src 'none'`, scripts from itself and Cloudflare, Cloudflare's frame, its own stylesheet, no `<base>` and no form posts, as a `<meta>` in `index.html` and as a header with `frame-ancestors` listing exactly the entry points, so no other page can frame it; no referrer and no cookie (T-43, T-10).
- **One source for both** (`page-build.ts`): the deployment (`src/deployment.ts`; staging's, until a release pins its own) reaches the page as a virtual module and the host as `dist/headers.json`, so the page never posts to an origin the headers don't let frame it. Staging has no site key yet, so its build drops the code that would load Turnstile.
- **No third-party code of its own and no analytics** (T-67): the bundle is this app's code alone, and the only URLs in it are Turnstile's script and the entry points.

## Serving it

`server/serve.mjs`, with no dependencies, serves `/` (the page) and `assets/*.js` and `assets/*.css` with the headers in `dist/headers.json`, and nothing else; `Dockerfile` packs it with `dist/` for staging. The host must not be the ballot RP ID, under it, or under any domain we ask passkeys for, and must be on a registrable domain where nothing of ours sets cookies ([[registration]], Challenge page, Origin).

## Test

- `vp run --filter @abolishus/challenge test`: the fragment parser (each request has exactly one fragment, and no origin outside the entry points ever comes out, with fast-check), the token form, the policy directive by directive and its `<meta>` copy, the deployment checks, and the build for staging and for a test deployment: four files, this app's modules only, no URL but Turnstile's and the entry points, no inline code, and the deployment's headers.
- `vp run --filter @abolishus/challenge test:e2e`: the page served by its own server in headless Chromium, at HTTPS origins Playwright routes, with a stand-in Turnstile. Framed by an entry point it renders one widget for the fragment's action and posts the first well-formed token to that parent alone; it can't be framed by any other page; it loads nothing for a refused fragment or when it isn't framed; and the server sends the headers and serves nothing but the page and its assets.
