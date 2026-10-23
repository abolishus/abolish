import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import {
  APP_COLORS,
  APP_FILES,
  ICON_PNGS,
  ICON_SVG,
  ICON_SVG_PATH,
  MANIFEST_PATH,
  manifestFile,
  manifestPath,
  webManifest,
} from "../src/app/install.ts";
import { DEFAULT_LOCALE, LOCALES } from "../src/locales.ts";
import { loadCatalog } from "../src/messages.ts";
import { rasterise } from "../src/og/render.ts";

// The installable website's files: that what `public/` ships is exactly what
// src/app/install.ts says, so the manifest's words are the catalog's and each
// icon is the SVG rendered at its size. `UPDATE_APP_FILES=1` writes them
// afresh after a change to the source; CI never sets it.

const PUBLIC = join(import.meta.dirname, "..", "public");
const update = process.env["UPDATE_APP_FILES"] === "1";
const catalogs = await Promise.all(LOCALES.map(loadCatalog));

/** `want` as the committed file at `path`, or written there when updating. */
function committed(path: string, want: Uint8Array | string) {
  const file = join(PUBLIC, path);
  if (update) writeFileSync(file, want);
  expect(existsSync(file), `${path} is missing: run with UPDATE_APP_FILES=1`).toBe(true);
  return readFileSync(file);
}

/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

describe("the installable website's files", () => {
  test.each(LOCALES.map((locale, i) => [locale, catalogs[i]!] as const))(
    "ship %s's manifest in its catalog's words",
    (locale, messages) => {
      const want = manifestFile(locale, messages);
      expect(committed(manifestPath(locale), want).toString("utf8")).toBe(want);
      const manifest = webManifest(locale, messages);
      expect(manifest).toMatchObject({
        id: "/",
        name: "Abolish",
        description: messages.appDescription,
        lang: locale,
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: APP_COLORS.background,
      });
      // T-67: where it starts carries nothing that would follow a visitor.
      expect(manifest.start_url).not.toMatch(/[?#]/);
      // Every icon it names is one the server serves, as the type it says.
      for (const icon of manifest.icons) expect(APP_FILES[icon.src]).toBe(icon.type);
      expect(manifest.icons.map((i) => i.purpose)).toContain("maskable");
    },
  );

  test("give each locale a manifest of its own, the default's where it always was", () => {
    expect(manifestPath(DEFAULT_LOCALE)).toBe(MANIFEST_PATH);
    expect(new Set(LOCALES.map(manifestPath)).size).toBe(LOCALES.length);
    // The same app whichever language installed it, described in that language.
    const manifests = LOCALES.map((locale, i) => webManifest(locale, catalogs[i]!));
    expect(new Set(manifests.map((m) => m.id)).size).toBe(1);
    expect(new Set(manifests.map((m) => m.description)).size).toBe(LOCALES.length);
  });

  test("ship the icon's source as its SVG", () => {
    expect(committed(ICON_SVG_PATH, ICON_SVG).toString("utf8")).toBe(ICON_SVG);
    // Nothing in it can run or fetch: it is drawn shapes only.
    expect(ICON_SVG).not.toMatch(/<script|<foreignObject|href=|on[a-z]+=/i);
  });

  test("ship each PNG as the SVG rendered at its size, the same bytes every time", async () => {
    for (const { path, size } of ICON_PNGS) {
      const png = await rasterise(ICON_SVG, size);
      expect(await rasterise(ICON_SVG, size)).toEqual(png);
      expect(pngSize(png)).toEqual([size, size]);
      expect(new Uint8Array(committed(path, png)), path).toEqual(png);
    }
  });

  test("serve nothing but what the install names", () => {
    expect(Object.keys(APP_FILES).sort()).toEqual(
      [...LOCALES.map(manifestPath), ICON_SVG_PATH, ...ICON_PNGS.map((i) => i.path)].sort(),
    );
  });
});
