// Protocol-wide limits of docs/spec/parameters.md; a test checks this table
// against the spec (T-52, T-28).

export const PARAMETERS = Object.freeze({
  MAX_TAG_LEN: 255,
  MAX_OPTIONS: 64,
  MAX_TRUSTEES: 16,
  DISPLAY_TEXT_SALT_LEN: 32,
} as const);
