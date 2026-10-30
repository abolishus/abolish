/**
 * A refusal the operator can fix: printed as `{ "error": code }`, with
 * `detail`'s fields beside it where the code alone doesn't say where, exit 1.
 */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/** Malformed arguments: printed with the usage, exit 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}
