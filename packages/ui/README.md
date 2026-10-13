# @abolishus/ui

Shared UI for `apps/web` and `apps/ballot`: shadcn/ui (preset `b2CQ2Q281`: style `base-lyra` on Base UI, zinc neutrals, emerald primary, Oxanium), self-hosted fonts, i18n, and components. Internal and source-only (AGPL-3.0-only).

## Use

- Import `@abolishus/ui/styles.css` once and run Tailwind's Vite plugin (`@tailwindcss/vite`) in the app. It brings shadcn's tokens (`background`, `foreground`, `primary`, `muted`, `accent`, `destructive`, … plus `recorded` and `pending` for status), Oxanium (`font-sans`, `font-heading`) and JetBrains Mono (`font-mono`, for evidence), and the dark theme: the system preference by default, or `.dark` / `data-theme="dark"` (and `data-theme="light"`) on any element.
- Wrap the app in `<I18nProvider locale="en-US">`. `useTranslate(catalogs)` returns `t(key, params)` over the current locale's catalog; messages use `{name}` placeholders, and a plural is an object keyed by `Intl.PluralRules` category with `other` required, chosen by `count`. Numbers are formatted for the locale.
- Components: `Button` (shadcn's, from `src/components/ui/`: variants `default`, `outline`, `secondary`, `ghost`, `destructive`, `link`; sizes `default`, `lg`, `icon`, `icon-lg`, every one at least 48px), `Hash` (evidence in JetBrains Mono; copying it yields the exact value), `Count` (a locale-grouped count in tabular figures), `Card`, `Table` and `Tabs` (shadcn's; `Table` adapted to a ruled grid with tabular figures and the caption on top, `Tabs` to 48px tabs), and the signature elements:
  - `Fingerprint`: a left-right symmetric 8×8 glyph drawn from a 32-byte hash, so people can compare a receipt with the board without reading hex. The left half's 32 cells show the hash's first 64 bits, 2 bits each, most significant first (`00` empty, `01` square, `10` dot, `11` corner triangle), row by row; the right half mirrors it. The mapping is pinned by a test: changing it changes every glyph a voter has seen. A different glyph is conclusive; a matching one is only as strong as what a person compares, so the hash stays beside it.
  - `ReceiptStub`: the receipt as a ticket stub with a perforated divider: hash, fingerprint, board entry number and the time (UTC by default, the board's).
  - `StatusTrail`: the receipt's steps (encrypted on device, recorded on the board, anchored to Ethereum, counted), each state with its own icon and words, joined by the caller's translated `{step}, {state}` template; a trail must run complete, then at most one pending, then upcoming.
  - `QrCode`: a QR code as one SVG path, dark modules on a light ground in both themes, quiet zone included. Its encoder, `encodeQr` (`src/lib/qr.ts`), is written from ISO/IEC 18004 with no dependency, so the ballot client can use it: numeric, alphanumeric or UTF-8 byte mode (the smallest that holds the text), levels L/M/Q/H (M by default; Q for print), versions 1–40, lowest-penalty mask. `tests/qr.test.ts` checks it against published vectors and reads every symbol back with an independent reader.
  - `TierSwitcher`: results by verification tier, one tab per tier with its name and scope ("40,112 voters"), each panel only that tier's results. It has no blended "all tiers" tab, and callers must not add one (brief, Keep).

## Primitives

`src/components/ui/` holds the full shadcn/ui set (`shadcn add --all`, preset `b2CQ2Q281`), and it is the base every screen is built from. **Keep all of them, used or not**: don't delete a primitive because nothing imports it yet, and don't hand-roll a component that one of them already covers. Unused primitives cost nothing: apps import them one at a time (`@abolishus/ui/ui/<name>`, hooks from `@abolishus/ui/hooks/<name>`), so a build only bundles what it uses. The root export (`@abolishus/ui`) stays the curated set below, because `apps/ballot` imports it.

Changes from the CLI's output: buttons inside other primitives (dialog and sheet close, carousel arrows, toasts, combobox clear, attachment, message scroller, sidebar trigger) use the 48px `icon` and `default` sizes, since `Button` has no smaller ones; `recharts` takes `reselect` 5.3.0 through a workspace override (its exact 5.1.1 pin fails `trustPolicy`). Text fields (`Input`, `Textarea`, `NativeSelect`, `SelectTrigger`, `InputGroup`, the combobox chips) are 48px with base-size text by default; `size="sm"` keeps the CLI's compact field for dense tools. Any other adaptation carries a comment in the file.

## Rules

- Components are shadcn/ui: add new ones with `vp exec shadcn add <component>` from this package (the CLI version pinned in the catalog; it writes to `src/components/ui/`) (`components.json`, aliases `#/components`, `#/lib`, `#/hooks`), then adapt them. The ballot client's runtime is React plus Base UI, `class-variance-authority`, `cn` and `lucide-react`; `apps/ballot`'s bundle test allowlists exactly those, so it can't use the primitives that bring their own packages (`chart`, `calendar`, `carousel`, `command`, `input-otp`, `resizable`, `message-scroller`, `questionnaire`) without an owner-reviewed change there. Tailwind and its Vite plugin are build-time only.
- Fonts are bundled from `@fontsource` packages, never loaded from a CDN.
- Every component has a Storybook story with a play function (interaction test); `test` fails if a component, in any subdirectory of `src/components`, has none.
- Every story passes axe's WCAG 2.0–2.2 A and AA rules; a violation fails the story (`a11y.test: "error"`). Stories render on the theme's ground, so the colour-contrast rule sees the real pairing; a component with colour gets a dark-theme story too.
- `test` checks every text colour against its ground at 4.5:1 in both themes, from the oklch values in `styles.css`.
- No user-facing string is hard-coded in a component: callers pass translated text.

## Test

- `vp run --filter @abolishus/ui test`: node-side checks (stories exist, palette contrast, message formatting with fast-check, the provider).
- `vp run --filter @abolishus/ui test:storybook`: every story in headless Chromium, its play function, then axe, at desktop width (`storybook`) and again at 360px (`storybook-phone`); a story fails if the page scrolls sideways at either width. Pick "Small phone" in Storybook's viewport menu to see the phone run. Needs Playwright's Chromium (`vp exec playwright install chromium`).
- `vp run --filter @abolishus/ui storybook`: the Storybook UI on port 6006.
