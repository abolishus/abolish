// The installable website (P2-28 part 1a): the web app manifest and its
// icons, which let a phone or desktop add apps/web to its home screen and
// open it in its own window. Only the website installs here: the ballot
// client keeps its own origin, policy and entry points (ADR 0020; T-41,
// T-43), and nothing here opens it.
//
// The files are static, so they are written once into `public/` (served as
// they are, src/node/serve.ts) and a test holds them to this module: the
// manifest's words come from the message catalog like every other string,
// and each PNG is the icon's SVG below rendered at its size, so the bytes
// shipped are always what this source says (repro-build).
//
// Each locale has its own manifest (P2-28 part 4c), linked from its pages,
// so a phone installs the website named and described in the language it
// was installed from. All share the one `id`, so it is the same app
// whichever page installed it.
//
// T-67, T-11: the manifest names no tracking parameter in `start_url`, and
// fetching it or an icon is never counted as a page view.

import { formatMessage } from "@abolishus/ui";

import { DEFAULT_LOCALE, LOCALES, type Locale } from "../locales.ts";
import type { Messages } from "../messages.ts";

/** The light palette's tokens (packages/ui/src/styles.css) as sRGB, as src/og/card.tsx has them. */
export const APP_COLORS = {
  /** `--background`, light. */
  background: "#ffffff",
  /** `--primary`, light. */
  primary: "#007a55",
} as const;

/**
 * The icon: the receipt's ticket stub ([[PROJECT_BRIEF]], Signature
 * elements), its perforation and a tick for "recorded", white on the
 * primary green. Full bleed, with everything inside the central circle of
 * 40% of the size that a maskable icon keeps, so one drawing serves both
 * purposes. Square corners, no gradient, no text.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${APP_COLORS.primary}"/>
  <path d="M112 160h288v68a28 28 0 0 0 0 56v68H112v-68a28 28 0 0 0 0-56z" fill="#ffffff"/>
  <path d="M328 172v168" stroke="${APP_COLORS.primary}" stroke-width="10" stroke-dasharray="14 14"/>
  <path d="M176 254l40 40 76-84" fill="none" stroke="${APP_COLORS.primary}" stroke-width="30" stroke-linecap="square"/>
</svg>
`;

/** A PNG the icon is rendered to: where it is served and how many pixels square. */
export interface IconFile {
  readonly path: `/icons/${string}.png`;
  readonly size: number;
}

export const ICON_PNGS: readonly IconFile[] = [
  { path: "/icons/icon-192.png", size: 192 },
  { path: "/icons/icon-512.png", size: 512 },
  // iOS's home screen; it rounds the corners itself.
  { path: "/icons/apple-touch-icon.png", size: 180 },
];

export const ICON_SVG_PATH = "/icons/icon.svg";
export const MANIFEST_PATH = "/manifest.webmanifest";

/** `locale`'s manifest: the default's at `MANIFEST_PATH`, as before there was a second. */
export const manifestPath = (locale: Locale) =>
  locale === DEFAULT_LOCALE ? MANIFEST_PATH : `/manifest.${locale}.webmanifest`;

/** Every file the install serves, with its content type: nothing else under these names. */
export const APP_FILES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    LOCALES.map((locale) => [manifestPath(locale), "application/manifest+json"]),
  ),
  [ICON_SVG_PATH]: "image/svg+xml",
  ...Object.fromEntries(ICON_PNGS.map((icon) => [icon.path, "image/png"])),
};

/** The web app manifest for `locale`'s catalog. */
export function webManifest(locale: Locale, messages: Messages) {
  const say = (key: keyof Messages) => formatMessage(locale, messages[key]);
  return {
    id: "/",
    name: say("siteName"),
    short_name: say("siteName"),
    description: say("appDescription"),
    lang: locale,
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: APP_COLORS.background,
    theme_color: APP_COLORS.background,
    icons: [
      { src: ICON_SVG_PATH, sizes: "any", type: "image/svg+xml", purpose: "any" },
      ...ICON_PNGS.filter((icon) => icon.size !== 180).map((icon) => ({
        src: icon.path,
        sizes: `${icon.size}x${icon.size}`,
        type: "image/png",
        purpose: "any",
      })),
      // The same drawing: everything in it sits inside a maskable icon's safe zone.
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** `locale`'s manifest's file, as `public/` holds it at `manifestPath(locale)`. */
export const manifestFile = (locale: Locale, messages: Messages) =>
  `${JSON.stringify(webManifest(locale, messages), null, 2)}\n`;
