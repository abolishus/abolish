/**
 * Whether the client is being served from a path gateway (`/ipfs/<cid>/` or
 * `/ipns/<name>/`), where every CID shares one origin. There, `'self'` in the
 * CSP and the same-origin policy admit any other content on the gateway: a
 * page under another CID can open or frame the client, read its document and
 * replace `crypto.getRandomValues`, learning the vote and its randomness
 * (T-43, T-41). The client runs only from an origin of its own: a subdomain
 * gateway (`<cid>.ipfs.<gateway>`), an ENS host or our domains.
 */
export function onSharedGatewayPath(pathname: string): boolean {
  return /^\/(ipfs|ipns)(\/|$)/i.test(pathname);
}
