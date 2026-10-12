// The account page's calls to the account handler on our own origin
// (src/node/serve.ts, /auth), with the browser's passkey prompts in between.
// The session cookie is HttpOnly: script never reads it, and every call
// sends it only because it is same-origin (connect-src 'self').

import {
  authenticationJSON,
  creationOptions,
  registrationJSON,
  requestOptions,
} from "./webauthn.ts";

/** One of the account's passkeys, as much of it as the page shows. */
export interface PasskeyView {
  readonly id: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** Whether the passkey is synced between devices (WebAuthn's backup state). */
  readonly backedUp: boolean;
}

/** Why an account action didn't happen. */
export type AccountFailure =
  /** The person dismissed the passkey prompt, or it timed out. */
  | "cancelled"
  /** This browser has no passkey support. */
  | "unsupported"
  /** The server refused or failed. */
  | "failed";

export class AccountError extends Error {
  readonly failure: AccountFailure;
  constructor(failure: AccountFailure) {
    super(`account action ${failure}`);
    this.name = "AccountError";
    this.failure = failure;
  }
}

/** Every call the page makes, so the panel can be shown with stand-ins (stories, tests). */
export interface AccountClient {
  /** Whether a session is signed in. */
  signedIn(): Promise<boolean>;
  /** Creates an account with a new passkey, signed in. */
  signUp(): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Signs out every other session of this account. */
  signOutOthers(): Promise<void>;
  passkeys(): Promise<readonly PasskeyView[]>;
  /** Adds a passkey to the signed-in account (from a session under a day old). */
  addPasskey(): Promise<void>;
  removePasskey(id: string): Promise<void>;
  /** Deletes the account, its passkeys and its sessions (from a session under a day old). */
  deleteAccount(): Promise<void>;
}

async function call(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).catch(() => {
    throw new AccountError("failed");
  });
  if (!response.ok) throw new AccountError("failed");
  return response.json().catch(() => {
    throw new AccountError("failed");
  });
}

function credentials(): CredentialsContainer {
  if (typeof PublicKeyCredential === "undefined" || navigator.credentials === undefined)
    throw new AccountError("unsupported");
  return navigator.credentials;
}

/** Runs a passkey prompt; a dismissed or timed-out prompt is `cancelled`, not a failure. */
async function prompt(run: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
  let credential: Credential | null;
  try {
    credential = await run();
  } catch (e) {
    throw new AccountError(
      e instanceof DOMException && e.name === "NotAllowedError" ? "cancelled" : "failed",
    );
  }
  if (!(credential instanceof PublicKeyCredential)) throw new AccountError("failed");
  return credential;
}

async function register(createSession: boolean): Promise<void> {
  const container = credentials();
  const options = creationOptions(await call("/passkey/generate-register-options"));
  const credential = await prompt(() => container.create({ publicKey: options }));
  // No `name`: a passkey's label would be whatever the device calls itself
  // ("Jane's iPhone"), and the server refuses one.
  await call("/passkey/verify-registration", {
    response: registrationJSON(credential),
    ...(createSession ? { createSession: true } : {}),
  });
}

function passkeyView(value: unknown): PasskeyView {
  if (typeof value !== "object" || value === null) throw new AccountError("failed");
  const { id, createdAt, backedUp } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof createdAt !== "string" || typeof backedUp !== "boolean")
    throw new AccountError("failed");
  return { id, createdAt, backedUp };
}

/** The client for this origin's account handler. */
export const accountClient: AccountClient = {
  async signedIn() {
    // `null` when signed out.
    return (await call("/get-session")) !== null;
  },
  signUp: () => register(true),
  async signIn() {
    const container = credentials();
    const options = requestOptions(await call("/passkey/generate-authenticate-options"));
    const credential = await prompt(() => container.get({ publicKey: options }));
    await call("/passkey/verify-authentication", { response: authenticationJSON(credential) });
  },
  async signOut() {
    await call("/sign-out", {});
  },
  async signOutOthers() {
    await call("/revoke-other-sessions", {});
  },
  async passkeys() {
    const list = await call("/passkey/list-user-passkeys");
    if (!Array.isArray(list)) throw new AccountError("failed");
    return list.map(passkeyView);
  },
  addPasskey: () => register(false),
  async removePasskey(id) {
    await call("/passkey/delete-passkey", { id });
  },
  async deleteAccount() {
    await call("/delete-user", {});
  },
};
