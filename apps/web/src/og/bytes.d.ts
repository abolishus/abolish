/** A file's bytes as base64, inlined at build time (vite.config.ts, `inline-bytes`). */
declare module "*?bytes" {
  const base64: string;
  export default base64;
}
