# @abolishus/ui

Shared UI for `apps/web` and `apps/ballot`: the design tokens, self-hosted IBM Plex, i18n, and components. Internal and source-only (AGPL-3.0-only).

## Use

- Import `@abolishus/ui/styles.css` once and run Tailwind's Vite plugin (`@tailwindcss/vite`) in the app. It brings the palette (`paper`, `ink`, `pencil`, `accent`, `recorded`, `pending`), the three Plex families (`font-sans`, `font-mono`, `font-serif`) and the dark theme: the system preference by default, or `data-theme="light"`/`"dark"` on any element.
- Wrap the app in `<I18nProvider locale="en-US">`. `useTranslate(catalogs)` returns `t(key, params)` over the current locale's catalog; messages use `{name}` placeholders, and a plural is an object keyed by `Intl.PluralRules` category with `other` required, chosen by `count`. Numbers are formatted for the locale.
- Components: `Button` (`primary`, `secondary`, `quiet`), `Hash` (evidence in Plex Mono; copying it yields the exact value), `Count` (a locale-grouped count in tabular figures).

## Rules

- No third-party runtime code beyond React. `apps/ballot` imports this package and may carry none (AGENTS.md, Dependencies; T-43). So components follow shadcn/ui's model (owned source, Tailwind classes, variant maps) without its runtime libraries; Radix, `class-variance-authority`, `clsx` and `tailwind-merge` stay out. Tailwind and its Vite plugin are build-time only. A component that needs a behaviour the platform lacks (a dialog's focus trap, say) builds it here, with tests.
- Fonts are bundled from `@fontsource` packages, never loaded from a CDN.
- Every component has a Storybook story with a play function (interaction test); `test` fails if a component, in any subdirectory of `src/components`, has none.
- Every story passes axe's WCAG 2.0–2.2 A and AA rules; a violation fails the story (`a11y.test: "error"`). Stories render on the theme's ground, so the colour-contrast rule sees the real pairing; a component with colour gets a dark-theme story too.
- `test` checks every text colour against the ground at 4.5:1 in both themes, from the values in `styles.css`.
- No user-facing string is hard-coded in a component: callers pass translated text.

## Test

- `vp run --filter @abolishus/ui test`: node-side checks (stories exist, palette contrast, message formatting with fast-check, the provider).
- `vp run --filter @abolishus/ui test:storybook`: every story in headless Chromium, its play function, then axe. Needs Playwright's Chromium (`vp exec playwright install chromium`).
- `vp run --filter @abolishus/ui storybook`: the Storybook UI on port 6006.
