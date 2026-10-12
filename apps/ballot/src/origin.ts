/**
 * Whether the client is being served from a path gateway (`/ipfs/<cid>/` or
 * `/ipns/<name>/`), where every CID shares one origin. There, `'self'` in the
 * CSP and the same-origin policy admit any other content on the gateway: a
 * page under another CID can open or frame the client, read its document and
 * replace `crypto.getRandomValues`, learning the vote and its randomness
 * (T-43, T-41). The client runs only from an origin of its own: a subdomain
 * gateway (`<cid>.ipfs.<gateway>`), an ENS host or our domains.
 *
 * Browsers keep percent-encoding in `location.pathname` (`/%69pfs/` stays as
 * written) while gateways decode it, so the path is decoded until it stops
 * changing, as a server might, before its first segment is compared.
 * Empty and `.` segments are dropped as a server would; a `..` segment, an
 * undecodable path or one still changing after four rounds counts as a
 * gateway path. Refusing is the safe answer, and no path the client itself
 * uses (it is served at the root and routes by hash) looks like any of these.
 */
export function onSharedGatewayPath(pathname: string): boolean {
  let path = pathname;
  for (let round = 0; ; round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return true;
    }
    if (decoded === path) break;
    if (round === MAX_DECODE_ROUNDS) return true;
    path = decoded;
  }
  const segments = path.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  // A `..` left after decoding (`/x/%2F..%2Fipfs/`) was hidden from the
  // browser's own normalisation; a server that resolves it after decoding
  // could route anywhere, so it is refused rather than resolved.
  if (segments.includes("..")) return true;
  const first = segments[0];
  return first !== undefined && /^(ipfs|ipns)$/i.test(first);
}

const MAX_DECODE_ROUNDS = 4;
