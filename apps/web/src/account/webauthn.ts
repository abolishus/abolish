// WebAuthn's JSON forms (WebAuthn Level 3, §5.1.8 and §5.1.9; the forms
// better-auth's passkey plugin sends and reads), converted by hand to and
// from what navigator.credentials takes and returns. A few lines here instead
// of a browser library: this page's only third-party runtime code is React
// and the router (T-55).

/** RFC 4648 §5 base64url, unpadded, as WebAuthn's JSON forms use it. */
export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decodes unpadded base64url, refusing any other alphabet, padding or an impossible length. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw new RangeError("not unpadded base64url");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // A final character with bits past the last byte set has no canonical
  // encoding of its own; refuse it so each byte string has one text.
  if (toBase64url(bytes) !== text) throw new RangeError("non-canonical base64url");
  return bytes;
}

type Json = Record<string, unknown>;

function object(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${what} must be an object`);
  return value as Json;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`);
  return value;
}

function descriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("credential list must be an array");
  return value.map((d: unknown) => {
    const o = object(d, "credential descriptor");
    const transports = o["transports"];
    return {
      type: "public-key",
      id: fromBase64url(text(o["id"], "credential id")),
      ...(Array.isArray(transports)
        ? {
            transports: transports.filter((t) => typeof t === "string") as AuthenticatorTransport[],
          }
        : {}),
    };
  });
}

/** `navigator.credentials.create`'s options from the server's registration options. */
export function creationOptions(json: unknown): PublicKeyCredentialCreationOptions {
  const o = object(json, "registration options");
  const rp = object(o["rp"], "rp");
  const user = object(o["user"], "user");
  const params = o["pubKeyCredParams"];
  if (!Array.isArray(params)) throw new TypeError("pubKeyCredParams must be an array");
  const exclude = descriptors(o["excludeCredentials"]);
  const selection = o["authenticatorSelection"];
  const timeout = o["timeout"];
  const attestation = o["attestation"];
  return {
    challenge: fromBase64url(text(o["challenge"], "challenge")),
    rp: {
      name: text(rp["name"], "rp name"),
      ...(rp["id"] === undefined ? {} : { id: text(rp["id"], "rp id") }),
    },
    user: {
      id: fromBase64url(text(user["id"], "user id")),
      name: text(user["name"], "user name"),
      displayName: text(user["displayName"] ?? "", "user display name"),
    },
    pubKeyCredParams: params.map((p: unknown) => {
      const alg = object(p, "credential parameter")["alg"];
      if (typeof alg !== "number") throw new TypeError("alg must be a number");
      return { type: "public-key", alg };
    }),
    ...(exclude === undefined ? {} : { excludeCredentials: exclude }),
    ...(selection === undefined
      ? {}
      : { authenticatorSelection: object(selection, "authenticatorSelection") }),
    ...(typeof timeout === "number" ? { timeout } : {}),
    ...(typeof attestation === "string"
      ? { attestation: attestation as AttestationConveyancePreference }
      : {}),
  };
}

/** `navigator.credentials.get`'s options from the server's authentication options. */
export function requestOptions(json: unknown): PublicKeyCredentialRequestOptions {
  const o = object(json, "authentication options");
  const allow = descriptors(o["allowCredentials"]);
  const timeout = o["timeout"];
  const uv = o["userVerification"];
  return {
    challenge: fromBase64url(text(o["challenge"], "challenge")),
    ...(o["rpId"] === undefined ? {} : { rpId: text(o["rpId"], "rpId") }),
    ...(allow === undefined ? {} : { allowCredentials: allow }),
    ...(typeof timeout === "number" ? { timeout } : {}),
    ...(typeof uv === "string" ? { userVerification: uv as UserVerificationRequirement } : {}),
  };
}

const bytes = (buffer: ArrayBuffer) => toBase64url(new Uint8Array(buffer));

/** A new credential as the server's `verify-registration` reads it (RegistrationResponseJSON). */
export function registrationJSON(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bytes(credential.rawId),
    type: "public-key",
    response: {
      clientDataJSON: bytes(response.clientDataJSON),
      attestationObject: bytes(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    // No extension results: none are asked for, and none are sent back.
    clientExtensionResults: {},
    ...(credential.authenticatorAttachment === null
      ? {}
      : { authenticatorAttachment: credential.authenticatorAttachment }),
  };
}

/** An assertion as the server's `verify-authentication` reads it (AuthenticationResponseJSON). */
export function authenticationJSON(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bytes(credential.rawId),
    type: "public-key",
    response: {
      clientDataJSON: bytes(response.clientDataJSON),
      authenticatorData: bytes(response.authenticatorData),
      signature: bytes(response.signature),
      ...(response.userHandle === null ? {} : { userHandle: bytes(response.userHandle) }),
    },
    clientExtensionResults: {},
    ...(credential.authenticatorAttachment === null
      ? {}
      : { authenticatorAttachment: credential.authenticatorAttachment }),
  };
}
