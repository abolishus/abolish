# @abolishus/ballot

The ballot client: a static single-page app, the only place a vote is cast. Built reproducibly into `dist/`, which is hash-addressed and served unchanged from IPFS, `abolishus.eth`, our domains and the Capacitor shell. Internal (AGPL-3.0-only).

## What it holds to

- **No third-party runtime code beyond React** (AGENTS.md, Dependencies; T-43). `tests/bundle.test.ts` builds the app and fails if any module in the bundle comes from an npm package other than `react`, `react-dom` and `scheduler`, or from workspace code other than this app and `@abolishus/ui`. The IBM Plex fonts are bundled, never fetched from a CDN.
- **No analytics** (T-67). The same test fails on any analytics, tracking or error-reporting SDK's markers (PostHog, Google Analytics, Segment, Sentry and others) and on any URL other than a short list of inert strings (XML namespace names, React's error-decoder link, Tailwind's licence comment).
- **A strict CSP** (T-43), in a `<meta>` tag ahead of everything that loads, so it travels with the bytes whoever serves them: scripts, styles, fonts and images from the client's own origin only; no inline code or `eval`; `connect-src 'none'` until the screens that fetch an election add the API's origin; Trusted Types with no policy, so no string becomes markup or script; no `<base>` and no form posts. `tests/csp.ts` pins the policy directive by directive. A `<meta>` policy can't set `frame-ancestors`, so framing protection needs a header from the host.
- **Relative URLs only** (`base: "./"`), so one build works under any path, such as an IPFS gateway's `/ipfs/<cid>/` (T-41, T-49).
- **Reproducible**: `dist/` is declared as the build output, and `repro-build` builds it twice and compares every byte.

## Test

- `vp run --filter @abolishus/ballot test`: builds the app and checks the bundle, the CSP and `index.html`.
- `vp run --filter @abolishus/ballot test:e2e`: serves the production build and loads it in headless Chromium: it renders with its styles and fonts, with no CSP violation, console error or request to another origin, and the browser refuses an injected script, markup written into an HTML sink, an event-handler attribute, a request to any origin and an image from another origin. Needs Playwright's Chromium (`vp exec playwright install chromium`).
- `vp run --filter @abolishus/ballot test:storybook`: every screen's story in headless Chromium, its play function, then axe (WCAG 2.2 AA), in both themes.
- `vp run --filter @abolishus/ballot preview`: builds and serves the production client. There is no dev-server script: Vite's development client injects inline styles and a WebSocket that the CSP refuses, and a relaxed development policy would be a second policy to keep from leaking into a release. Use Storybook for working on screens.
