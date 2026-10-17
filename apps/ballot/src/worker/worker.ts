// The ballot worker's entry point. It answers the page's requests and does
// nothing else: no network, storage or code loading (the owner-reviewed bundle
// check bans those APIs from any script the page doesn't load itself, and the
// e2e watches it run; T-43). Errors become a bare "error" response, never a
// message or stack, which could carry a secret.

import { proveMembership } from "./prove.ts";
import {
  parseRequest,
  PROTOCOL_VERSION,
  requestId,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";
import { BallotSession } from "./session.ts";

// DedicatedWorkerGlobalScope isn't in the DOM library this package compiles with.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

const session = new BallotSession();

async function answer(request: WorkerRequest): Promise<WorkerResponse> {
  const { id } = request;
  const v = PROTOCOL_VERSION;
  switch (request.kind) {
    case "check-election":
      return { v, id, kind: "check-election", result: session.checkElection(request) };
    case "seal":
      return { v, id, kind: "seal", result: session.seal(request) };
    case "challenge":
      return { v, id, kind: "challenge", result: session.challenge(request) };
    case "prove-membership":
      return { v, id, kind: "prove-membership", result: await proveMembership(request) };
  }
}

scope.onmessage = ({ data }) => {
  const request = parseRequest(data);
  if (request === undefined) {
    // Without an id there is no request to answer; the page's timeout ends it.
    const id = requestId(data);
    if (id !== undefined) scope.postMessage({ v: PROTOCOL_VERSION, id, kind: "error" });
    return;
  }
  answer(request).then(
    (response) => scope.postMessage(response),
    () => scope.postMessage({ v: PROTOCOL_VERSION, id: request.id, kind: "error" }),
  );
};
