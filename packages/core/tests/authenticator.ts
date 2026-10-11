import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

// A software WebAuthn authenticator for tests: ES256 credentials with "none"
// attestation (WebAuthn Level 3, §6.1 authenticator data, §6.5.4 attestation
// object; RFC 9052 COSE keys), so the account flows run end to end against
// the real verification code with no browser.

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  throw new RangeError("value too large for this encoder");
}

/** Deterministic CBOR (RFC 8949) for the few types WebAuthn needs here. */
function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

interface Credential {
  readonly id: Uint8Array;
  readonly key: KeyObject;
  counter: number;
}

export interface Ceremony {
  /** Whether the authenticator reports user verification. Default true. */
  readonly uv?: boolean;
  /** The origin the browser would put in clientDataJSON. */
  readonly origin: string;
}

export interface RegistrationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
  readonly authenticatorSelection?: { readonly userVerification?: string };
}

export interface AuthenticationOptions {
  readonly challenge: string;
  readonly rpId?: string;
}

export class SoftAuthenticator {
  readonly credentials: Credential[] = [];

  readonly rpID: string;

  constructor(rpID: string) {
    this.rpID = rpID;
  }

  private authData(flags: number, counter: number, attested?: Uint8Array): Uint8Array {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    return Buffer.concat([
      sha256(this.rpID),
      Uint8Array.of(flags),
      c,
      attested ?? new Uint8Array(),
    ]);
  }

  private clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  /** navigator.credentials.create(), serialised as a RegistrationResponseJSON. */
  create(options: RegistrationOptions, { uv = true, origin }: Ceremony) {
    if (options.rp.id !== this.rpID) throw new Error(`RP ID ${options.rp.id} is not ${this.rpID}`);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const id = randomBytes(16);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const attested = Buffer.concat([new Uint8Array(16), idLen, id, cose]);
    const flags = FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | FLAG_AT;
    const authData = this.authData(flags, 0, attested);
    this.credentials.push({ id, key: privateKey, counter: 0 });
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** navigator.credentials.get() with credential `index`, serialised as an AuthenticationResponseJSON. */
  get(options: AuthenticationOptions, { uv = true, origin }: Ceremony, index = 0) {
    const cred = this.credentials[index];
    if (!cred) throw new Error(`no credential ${index}`);
    cred.counter++;
    const authData = this.authData(FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS, cred.counter);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), cred.key);
    return {
      id: b64url(cred.id),
      rawId: b64url(cred.id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
    };
  }
}
