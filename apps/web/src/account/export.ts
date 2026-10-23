// The account page's call to the export handler on our own origin
// (src/node/export.ts, /export; P2-27 part 2b): the signed-in account's own
// data, saved by the browser as a file. The session cookie goes only because
// the call is same-origin, as the account client's does
// (src/account/client.ts); the handler names the account from it, and
// nothing here names one (T-10). The file is made in the page from the
// answer, so it never passes through a URL or the browser's history, and
// nothing about it is sent anywhere else (T-11, T-67).

/** The export's layout this page knows (packages/core's `ACCOUNT_EXPORT_VERSION`). */
export const ACCOUNT_EXPORT_VERSION = 1;

const ISO = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACCOUNT_ID = /^[a-z0-9]{32}$/;

/** Why the export didn't download. */
export type ExportFailure =
  /** The session ended: sign in again. */
  | "signedOut"
  /** The server refused or failed, or the network did. */
  | "failed";

export class ExportError extends Error {
  readonly failure: ExportFailure;
  constructor(failure: ExportFailure) {
    super(`export ${failure}`);
    this.name = "ExportError";
    this.failure = failure;
  }
}

/** The export as a file to save. */
export interface ExportFile {
  /** `abolish-account-YYYY-MM-DD.json`, the UTC day it was made. */
  readonly name: string;
  /** The export, indented so a person can read it. */
  readonly text: string;
}

/** Every call the page makes, so it can be shown with stand-ins (stories, tests). */
export interface ExportClient {
  /** Reads the account's export and has the browser save it. */
  download(): Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The signed-in account's export as a file, or an `ExportError`. Only its
 * version, date and account are checked: the rest is the account's own
 * data, handed on as the server gave it.
 */
export async function fetchAccountExport(): Promise<ExportFile> {
  const response = await fetch("/export", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    // Exactly this type, with no charset: the handler refuses anything else.
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => {
    throw new ExportError("failed");
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = isObject(answer) ? answer["code"] : undefined;
    throw new ExportError(code === "SIGNED_OUT" ? "signedOut" : "failed");
  }
  if (!isObject(answer) || answer["version"] !== ACCOUNT_EXPORT_VERSION)
    throw new ExportError("failed");
  const { exportedAt, account } = answer;
  const day = typeof exportedAt === "string" ? ISO.exec(exportedAt)?.[1] : undefined;
  if (
    day === undefined ||
    !isObject(account) ||
    typeof account["id"] !== "string" ||
    !ACCOUNT_ID.test(account["id"])
  )
    throw new ExportError("failed");
  return { name: `abolish-account-${day}.json`, text: `${JSON.stringify(answer, null, 2)}\n` };
}

/** Has the browser save `file`, from memory: no address names it. */
function save({ name, text }: ExportFile): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Not at once: a browser may read the blob only after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The client for this origin's export handler. */
export const exportClient: ExportClient = {
  async download() {
    save(await fetchAccountExport());
  },
};
