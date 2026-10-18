/// <reference types="vite-plus/client" />

// The deployment the build pins (`page-build.ts`), so the page and its
// headers file come from the same values.
declare module "virtual:challenge-deployment" {
  /** The Turnstile site key, or `null` while none is issued. */
  export const SITE_KEY: string | null;
  /** The ballot client's entry points. */
  export const ENTRY_POINTS: readonly string[];
}
