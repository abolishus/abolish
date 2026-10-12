/** A refusal the operator can fix: printed as `{ "error": code }`, exit 1. */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Malformed arguments: printed with the usage, exit 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}
