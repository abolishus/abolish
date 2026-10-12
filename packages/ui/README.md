# @abolishus/ui

Shared UI components. Internal and source-only (AGPL-3.0-only). Today it holds one component, `Button`, as the Storybook-under-Vite+ smoke test (P0-2); shadcn/ui, Tailwind and i18n arrive with P2-7.

## Rules

- Every component has a Storybook story with a play function (interaction test); `test` fails if a component has none.
- Every story passes axe's WCAG 2.0–2.2 A and AA rules; a violation fails the story (`a11y.test: "error"`).
- No user-facing string is hard-coded in a component: callers pass translated text.

## Test

- `vp run --filter @abolishus/ui test`: node-side checks (every component has a story).
- `vp run --filter @abolishus/ui test:storybook`: every story in headless Chromium, its play function, then axe. Needs Playwright's Chromium (`vp exec playwright install chromium`).
- `vp run --filter @abolishus/ui storybook`: the Storybook UI on port 6006.
