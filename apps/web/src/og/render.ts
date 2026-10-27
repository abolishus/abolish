// Link previews as PNG, rendered on our own server: satori lays the card out
// and turns its text into paths, resvg (WebAssembly) rasterises the SVG. The
// fonts and the resvg module are inlined into the server bundle, so the
// deployable reads nothing from node_modules or the network at run time, and
// the same model always gives the same bytes.

import oxanium400Ext from "@fontsource/oxanium/files/oxanium-latin-ext-400-normal.woff?bytes";
import oxanium600Ext from "@fontsource/oxanium/files/oxanium-latin-ext-600-normal.woff?bytes";
import oxanium400 from "@fontsource/oxanium/files/oxanium-latin-400-normal.woff?bytes";
import oxanium600 from "@fontsource/oxanium/files/oxanium-latin-600-normal.woff?bytes";
import jetbrainsMono400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff?bytes";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?bytes";
import { createElement } from "react";
import satori, { type SatoriOptions } from "satori";

import { PreviewCard } from "./card.tsx";
import { checkPreview, type PollPreview, type PreviewFormat, PREVIEW_SIZE } from "./model.ts";

/** The bytes of a `?bytes` import (vite.config.ts). */
const bytesOf = (base64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(base64, "base64"));

const font = (name: string, weight: 400 | 600, base64: string) =>
  ({ name, weight, style: "normal", data: bytesOf(base64).buffer }) as const;

/**
 * Satori takes the first font of a name for the whole name, so the Latin
 * Extended subset has a name of its own, which it falls back to for the
 * characters Oxanium's Latin subset lacks (src/og/glyphs.ts).
 */
export const FONTS: SatoriOptions["fonts"] = [
  font("Oxanium", 400, oxanium400),
  font("Oxanium", 600, oxanium600),
  font("Oxanium Latin Extended", 400, oxanium400Ext),
  font("Oxanium Latin Extended", 600, oxanium600Ext),
  font("JetBrains Mono", 400, jetbrainsMono400),
];

let ready: Promise<void> | undefined;

/** resvg's module, instantiated once per process. */
function resvg(): Promise<void> {
  ready ??= initWasm(bytesOf(resvgWasm)).catch((error: unknown) => {
    // Another copy of this module (a test's fresh import) got there first.
    if (error instanceof Error && error.message.startsWith("Already initialized")) return;
    ready = undefined;
    throw error;
  });
  return ready;
}

/** The card for `model` as SVG, text drawn as paths. */
export async function previewSvg(model: PollPreview, format: PreviewFormat): Promise<string> {
  checkPreview(model);
  const { width, height } = PREVIEW_SIZE[format];
  return satori(createElement(PreviewCard, { model, format }), { width, height, fonts: FONTS });
}

/** The card for `model` as a PNG of `PREVIEW_SIZE[format]`. */
export async function renderPreview(
  model: PollPreview,
  format: PreviewFormat,
): Promise<Uint8Array<ArrayBuffer>> {
  return rasterise(await previewSvg(model, format));
}

/**
 * `svg` as a PNG, at its own size or `width` pixels wide. No system fonts:
 * text is already paths, so a render is the same bytes on every machine.
 */
export async function rasterise(svg: string, width?: number): Promise<Uint8Array<ArrayBuffer>> {
  await resvg();
  const image = new Resvg(svg, {
    fitTo: width === undefined ? { mode: "original" } : { mode: "width", value: width },
    font: { loadSystemFonts: false },
  });
  try {
    const rendered = image.render();
    try {
      return Uint8Array.from(rendered.asPng());
    } finally {
      rendered.free();
    }
  } finally {
    image.free();
  }
}
