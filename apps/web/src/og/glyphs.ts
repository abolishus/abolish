// Which words a link preview's image can draw. The renderer (src/og/render.ts)
// has Oxanium's Latin and Latin Extended subsets and nothing else, and draws
// any character they lack as an empty box. So an author's words (the
// question, the place) go on the image only when every character is one the
// fonts draw; otherwise the image names the poll as it does with no words,
// and the page's text beside the image (og:title, which a chat renders in
// its own fonts) still carries them.
//
// Each range here is drawn by both weights the card uses, which
// tests/og.test.ts checks against the fonts themselves. Combining marks are
// left out, since the renderer doesn't compose them with their base, so text
// is compared in NFC and a mark with no precomposed form is undrawable. So
// are controls, format characters and every other space but U+0020 and
// U+00A0, which draw as nothing a reader can see.

/** Inclusive code-point ranges both Oxanium weights draw. */
export const DRAWABLE: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xac],
  [0xae, 0x107],
  [0x10c, 0x113],
  [0x116, 0x11b],
  [0x11e, 0x11f],
  [0x122, 0x123],
  [0x12a, 0x12b],
  [0x12e, 0x131],
  [0x136, 0x137],
  [0x139, 0x13e],
  [0x141, 0x148],
  [0x14c, 0x14d],
  [0x150, 0x15b],
  [0x15e, 0x165],
  [0x16a, 0x16b],
  [0x16e, 0x173],
  [0x178, 0x17e],
  [0x192, 0x192],
  [0x218, 0x21b],
  [0x1e9e, 0x1e9e],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2020, 0x2020],
  [0x2022, 0x2022],
  [0x2026, 0x2026],
  [0x2039, 0x203a],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
];

const isDrawn = (codePoint: number) =>
  DRAWABLE.some(([first, last]) => codePoint >= first && codePoint <= last);

/**
 * `text` in NFC if the card's fonts draw every character of it and it isn't
 * blank, else `undefined`: an author's words go on the image whole or not at all, never
 * with boxes standing in for what the fonts lack.
 */
export function drawable(text: string): string | undefined {
  const composed = text.normalize("NFC");
  if (composed.trim() === "") return undefined;
  for (const char of composed) if (!isDrawn(char.codePointAt(0) ?? -1)) return undefined;
  return composed;
}
