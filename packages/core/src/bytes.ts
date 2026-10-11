/** Real bytes only: a string or an array is refused, never coerced. */
export const isBytes = (x: unknown): x is Uint8Array =>
  x instanceof Uint8Array && ArrayBuffer.isView(x);
