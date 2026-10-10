// Well-formed UTF-8 per the byte-sequence table of RFC 3629, section 4.
// Written out rather than delegated to TextDecoder, whose handling of a
// leading BOM and of errors is configurable and varies across platforms; the
// spec needs one exact accept set everywhere (T-31). It rejects overlong forms,
// encoded surrogates (U+D800 to U+DFFF), code points above U+10FFFF, and the
// bytes C0, C1 and F5 to FF.

/** Whether `b` is a complete, well-formed UTF-8 byte string. */
export function isWellFormedUtf8(b: Uint8Array): boolean {
  let i = 0;
  const cont = (at: number, lo = 0x80, hi = 0xbf): boolean => {
    const x = b[at];
    return x !== undefined && x >= lo && x <= hi;
  };
  while (i < b.length) {
    const x = b[i] ?? 0;
    if (x <= 0x7f) {
      i += 1;
    } else if (x >= 0xc2 && x <= 0xdf) {
      if (!cont(i + 1)) return false;
      i += 2;
    } else if (x >= 0xe0 && x <= 0xef) {
      // E0: A0-BF excludes overlongs; ED: 80-9F excludes surrogates.
      const lo = x === 0xe0 ? 0xa0 : 0x80;
      const hi = x === 0xed ? 0x9f : 0xbf;
      if (!cont(i + 1, lo, hi) || !cont(i + 2)) return false;
      i += 3;
    } else if (x >= 0xf0 && x <= 0xf4) {
      // F0: 90-BF excludes overlongs; F4: 80-8F stops at U+10FFFF.
      const lo = x === 0xf0 ? 0x90 : 0x80;
      const hi = x === 0xf4 ? 0x8f : 0xbf;
      if (!cont(i + 1, lo, hi) || !cont(i + 2) || !cont(i + 3)) return false;
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}
