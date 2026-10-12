# @abolishus/ui

Shared UI for `apps/web` and `apps/ballot`: shadcn/ui (preset `b2CQ2Q281`: style `base-lyra` on Base UI, zinc neutrals, emerald primary, Oxanium), self-hosted fonts, i18n, and components. Internal and source-only (AGPL-3.0-only).

## Use

- Import `@abolishus/ui/styles.css` once and run Tailwind's Vite plugin (`@tailwindcss/vite`) in the app. It brings shadcn's tokens (`background`, `foreground`, `primary`, `muted`, `accent`, `destructive`, … plus `recorded` and `pending` for status), Oxanium (`font-sans`, `font-heading`) and JetBrains Mono (`font-mono`, for evidence), and the dark theme: the system preference by default, or `.dark` / `data-theme="dark"` (and `data-theme="light"`) on any element.
- Wrap the app in `<I18nProvider locale="en-US">`. `useTranslate(catalogs)` returns `t(key, params)` over the current locale's catalog; messages use `{name}` placeholders, and a plural is an object keyed by `Intl.PluralRules` category with `other` required, chosen by `count`. Numbers are formatted for the locale.
- Components: `Button` (shadcn's, from `src/components/ui/`: variants `default`, `outline`, `secondary`, `ghost`, `destructive`, `link`; sizes `default`, `lg`, `icon`, `icon-lg`, every one at least 48px), `Hash` (evidence in JetBrains Mono; copying it yields the exact value), `Count` (a locale-grouped count in tabular figures), `Card` (shadcn's), and the signature elements:
  - `Fingerprint`: a left-right symmetric 8×8 glyph drawn from a 32-byte hash, so people can compare a receipt with the board without reading hex. The left half's 32 cells show the hash's first 64 bits, 2 bits each, most significant first (`00` empty, `01` square, `10` dot, `11` corner triangle), row by row; the right half mirrors it. The mapping is pinned by a test: changing it changes every glyph a voter has seen. A different glyph is conclusive; a matching one is only as strong as what a person compares, so the hash stays beside it.
  - `ReceiptStub`: the receipt as a ticket stub with a perforated divider: hash, fingerprint, board entry number and the time (UTC by default, the board's).
  - `StatusTrail`: the receipt's steps (encrypted on device, recorded on the board, anchored to Ethereum, counted), each state with its own icon and words; a trail must run complete, then at most one pending, then upcoming.

## Rules

- Components are shadcn/ui: add new ones with `vp exec shadcn add <component>` from this package (the CLI version pinned in the catalog; it writes to `src/components/ui/`) (`components.json`, aliases `#/components`, `#/lib`, `#/hooks`), then adapt them. The runtime is React plus Base UI, `class-variance-authority`, `cn` and `lucide-react`; `apps/ballot`'s bundle test allowlists exactly those, so any other runtime package needs an owner-reviewed change there. Tailwind and its Vite plugin are build-time only.
- Fonts are bundled from `@fontsource` packages, never loaded from a CDN.
- Every component has a Storybook story with a play function (interaction test); `test` fails if a component, in any subdirectory of `src/components`, has none.
- Every story passes axe's WCAG 2.0–2.2 A and AA rules; a violation fails the story (`a11y.test: "error"`). Stories render on the theme's ground, so the colour-contrast rule sees the real pairing; a component with colour gets a dark-theme story too.
- `test` checks every text colour against its ground at 4.5:1 in both themes, from the oklch values in `styles.css`.
- No user-facing string is hard-coded in a component: callers pass translated text.

## Test

- `vp run --filter @abolishus/ui test`: node-side checks (stories exist, palette contrast, message formatting with fast-check, the provider).
- `vp run --filter @abolishus/ui test:storybook`: every story in headless Chromium, its play function, then axe. Needs Playwright's Chromium (`vp exec playwright install chromium`).
- `vp run --filter @abolishus/ui storybook`: the Storybook UI on port 6006.
